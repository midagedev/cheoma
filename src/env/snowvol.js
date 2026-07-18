import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boundaryEdges } from './roofcapture.js';
import { makeRng } from '../rng.js';

// 적설 볼륨 시뮬 — 셰이더 틴트(#21) 위에 얹는 "실제 두께의 눈 층".
//   createSnowVolume(scene, { getBuilding, getGround, layout })
//     → { group, rebuild(surfaces), update(dt, {accum,t,wind}), setVisible, setLayout, dispose,
//         fireSlip(), setSlip(p) }
//
// 구성:
//  ① 지붕 눈 쉘: captureRoofSurfaces 로 얻은 상향 곡면을 복제해 노멀 방향으로 두께만큼 부풀린
//     별도 메시(전 표면 1병합 → 드로우콜 1). 두께는 공유 uniform uThick(=accum*MAX_THICK)로 자라
//     — 매 프레임 정점 재계산 없이 uniform 한 번으로 전체 성장. 경계 에지에 림 벽을 세워 처마
//     눈처마(눈띠)·볼륨 단면이 어느 각도서도 읽히게 한다. 물매(ny)로 게이트 → 처마 밑·수직면 무적설.
//  ② 지면 드리프트: 기단 기슭을 감싸는 berm 리본 + 마당 눈더미 몇 개(1병합). 바람 방향으로
//     쏠린다(uWind·uWindBias, wind.js 필드 재사용) — 풍하측이 두껍게.
//  ③ 미끄럼 낙설 이벤트: 물매 급한 지붕면에서 눈판이 스르륵 미끄러져 처마 밖으로 툭 떨어지는
//     드문 이벤트(퍼프 파티클 + 슬래브). 앰비언트 미세 원칙의 예외(눈에 띄어도 됨).
//
// 융설: weather 가 accum 을 낮추면 uThick 이 줄어 쉘이 스스로 얇아진다(추가 로직 불요).

const MAX_THICK = 0.52;                          // accum=1 일 때 최대 눈 두께(월드 m) — 두툼한 눈담요
const SNOW_COL = new THREE.Color(0xeef2f7);

// ── 볏짚 돔(choga) 적설 감쇠(#85) ────────────────────────────────────────────
// 초가의 둥근 볏짚 지붕은 볼록면이라, 기와면과 같은 균일 노멀 오프셋을 주면 곡면 전체가
// 통째로 부풀어 흰 돔("눈사람 머리")처럼 보인다(기와 팔작·맞배면은 평탄해 정상). 실제 볏짚은
// 눈이 얹혀도 "두께"가 아니라 "윤곽"을 따르므로, 둥근 표면만 골라 (a) 두께 상한을 낮추고
// (b) 정수리(상향 노멀 ny 큰 곳)를 추가로 깎아 눈이 둥근 능선을 얇게 덮게 한다. 처마쪽(ny 낮음)은
// 감쇠에서 제외돼 눈처마(눈띠) 립·볼륨 단면 인상을 유지한다.
//   판별: 수평 노멀의 방위 코히런스 = |Σ(nx,nz)| / Σ|(nx,nz)|. 기와·궁·절 지붕은 면(面)마다
//   별도 메시라 한 면의 노멀이 한 방위로 모여 코히런스 ≈1, 둥근 볏짚 돔은 노멀이 방사로 퍼져
//   상쇄돼 ≈0. planarity(면 곡률)는 돔 얕기에 따라 기와면과 겹쳐 부적합 → 방위 코히런스로 분리.
const THATCH_COHERENCE = 0.5;                    // 이 미만 = 방사 노멀(둥근 돔) → 감쇠 적용
const THATCH_SCALE = 0.62;                       // 돔 눈 두께를 기와 대비 낮춤(윤곽 따르기)
const THATCH_APEX_ATTEN = 0.35;                  // 정수리(ny 큰 곳)를 추가로 깎아 통팽창 차단
const SLIP_DUR = 1.7;                            // 낙설 1회 애니 길이(초)
const SLIP_PERIOD = 15.0;                        // 자동 낙설 주기(초, 드물게)

// roofOnly(선택): 지붕 눈 쉘만 구성하고 지면 드리프트(berm·눈더미)·낙설을 생략한다. 근접 링(#84)
//   전용 — 지면 드리프트는 layout 기준 origin 상대라 월드 오프셋 필지에선 오배치되나, 지붕 쉘은
//   captureRoofSurfaces 월드좌표를 지오에 베이크하므로 group=origin 유지 시 오프셋 필지에 정확히 얹힌다.
//   기본 false = 기존 weather.js 호출 무회귀.
export function createSnowVolume(scene, { getBuilding, getGround, layout, roofOnly = false }) {
  let L = layout || {};
  const group = new THREE.Group();
  group.name = 'snowVolume';
  group.visible = false;
  scene.add(group);

  // 공유 uniform — 한 번 갱신으로 쉘·berm 전체 성장/쏠림 반영.
  const uThick = { value: 0 };
  const uWind = { value: new THREE.Vector2(1, 0) };
  const uWindBias = { value: 0 };

  const shellMat = makeShellMaterial(uThick, uWind, uWindBias, { emissive: 0x0c1018 });
  // 지면 드리프트 전용: 흰 지면 위 흰 눈두둑은 정오광에서 형태가 안 읽혀, 베이크 AO(기슭 어둡게)로
  // 광원 방향과 무관하게 두둑 형태(및 바람 쏠림 비대칭)가 드러나게 한다.
  const groundMat = makeShellMaterial(uThick, uWind, uWindBias, { emissive: 0x0c1018, ao: true });
  let shellMesh = null;
  let bermMesh = null;

  const slip = makeSlip();
  group.add(slip.slab);
  group.add(slip.puff);

  let slipTimer = SLIP_PERIOD * 0.5;

  function clearMesh(m) {
    if (!m) return;
    group.remove(m);
    m.geometry.dispose();
  }

  // 지붕 표면 캡처(surfaces)로 눈 쉘을 (재)구성. 건물 재생성 때마다 호출.
  function rebuild(surfaces) {
    clearMesh(shellMesh); shellMesh = null;
    if (surfaces && surfaces.length) {
      const geo = buildShellGeometry(surfaces);
      if (geo) {
        shellMesh = new THREE.Mesh(geo, shellMat);
        shellMesh.name = 'snowShell';
        // 정점 변위(uThick)는 그림자 깊이 패스에 반영되지 않아 castShadow 시 그림자가 어긋난다.
        // 눈층은 얇아 자체 그림자 기여가 미미 → 끈다. 지붕 본체 그림자로 충분.
        shellMesh.castShadow = false;
        shellMesh.receiveShadow = false;   // 곡면 자기그림자 아크네 회피(지붕 기존 방침과 동일)
        shellMesh.frustumCulled = false;
        shellMesh.renderOrder = 2;
        group.add(shellMesh);
      }
    }
    if (!roofOnly) { rebuildGround(); slip.configure(L, surfaces); }
  }

  function rebuildGround() {
    clearMesh(bermMesh); bermMesh = null;
    const geo = buildGroundGeometry(L);
    if (geo) {
      bermMesh = new THREE.Mesh(geo, groundMat);
      bermMesh.name = 'snowDrift';
      bermMesh.receiveShadow = true;
      bermMesh.frustumCulled = false;
      bermMesh.renderOrder = 1;
      group.add(bermMesh);
    }
  }

  function setLayout(nl) { if (nl) L = nl; }

  function update(dt, ctx) {
    const accum = ctx.accum || 0;
    uThick.value = accum * MAX_THICK;
    const w = ctx.wind || { dirX: 1, dirZ: 0, speed: 0, gust: 0 };
    // 바람 방향으로 드리프트 쏠림. 세기는 풍속에 비례(무풍이면 대칭).
    uWind.value.set(w.dirX, w.dirZ);
    uWindBias.value = Math.min(0.6, w.speed * 0.5);

    // 낙설 스케줄: 눈이 충분히 쌓였을 때(accum>0.55)만, 드물게. shot 고정(setSlip) 중엔 자동 정지.
    if (!slip.pinned && accum > 0.55) {
      slipTimer -= dt;
      if (slipTimer <= 0) { slip.fire(ctx.t || 0); slipTimer = SLIP_PERIOD * (0.7 + 0.6 * hash01((ctx.t || 0) * 0.37)); }
    }
    slip.update(dt, accum);
  }

  function setVisible(v) { group.visible = v; }

  function dispose() {
    clearMesh(shellMesh); clearMesh(bermMesh);
    slip.dispose(group);
    scene.remove(group);
    shellMat.dispose(); groundMat.dispose();
  }

  return {
    group, rebuild, update, setVisible, setLayout, dispose,
    fireSlip: (t) => slip.fire(t || 0),
    setSlip: (p) => slip.setPinned(p),
    get slabGroup() { return slip.slab; },
  };
}

// ── 눈 재질 ────────────────────────────────────────────────────────────────
// 정점 변위로 노멀 방향 두께를 uThick 로 키운다. aWindDir·uWind 로 드리프트 쏠림, aOut 로 처마 립.
function makeShellMaterial(uThick, uWind, uWindBias, { emissive = 0x0c1018, ao = false } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: SNOW_COL, roughness: 0.92, metalness: 0.0,
    emissive: new THREE.Color(emissive), emissiveIntensity: 1.0,
    side: THREE.DoubleSide,
    // 불투명 유지 + 디더(확률적) 알파로 커버리지 페이드. 두께 0(accum≈0)이면 전 프래그먼트 discard →
    // 맨 기와, 자라면 채워진다. transparent 로 하면 겹치는 반투명(눈 쉘↔지면 두둑)이 depthWrite
    // 상호 가림으로 검게 죽는 three 정렬 함정에 빠지므로, 정렬·깊이 안전한 디더 방식을 쓴다.
  });
  const aoDecl = ao ? 'attribute float aAO; varying float vAO;' : '';
  const aoSet = ao ? 'vAO = aAO;' : '';
  const aoFragDecl = ao ? 'varying float vAO;' : '';
  const aoFragApply = ao ? 'diffuseColor.rgb *= vAO;' : '';
  // three 는 onBeforeCompile 변형을 기본 프로그램 캐시키에 반영하지 않는다. 같은 MeshStandard 기본
  // 속성을 가진 두 재질(shell=ao off, ground=ao on)이 같은 키로 프로그램을 공유해 서로의 셰이더를
  // 잘못 재사용 → 지붕 쉘이 aAO(=0) 곱연산으로 검게 죽던 버그. 키를 분리해 각자 프로그램을 갖게 한다.
  m.customProgramCacheKey = () => 'snowvol_' + (ao ? 'ground' : 'shell');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uThick = uThick;
    sh.uniforms.uWind = uWind;
    sh.uniforms.uWindBias = uWindBias;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aLift; attribute float aGrow; attribute vec3 aOut; attribute vec2 aWindDir;
        uniform float uThick; uniform vec2 uWind; uniform float uWindBias;
        varying float vCov; ${aoDecl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float wf = 1.0 + uWindBias * dot(aWindDir, uWind);
          // 저주파 골 요철(눈이 기왓골 위에 얹혀 살짝 물결짐 — 과하지 않게)
          float gv = 0.5 + 0.25*sin(transformed.x*8.5) + 0.25*sin(transformed.z*8.5);
          float lift = uThick * aGrow * max(wf, 0.0) * (0.85 + 0.30*gv);
          transformed += aLift * lift;
          transformed += aOut * (uThick * 0.65 * clamp(aGrow, 0.0, 1.0));
          // 커버리지: 눈 층 높이(uThick*aGrow) 로 램프. 얇을 땐 반투명(엷은 눈 스밈)→두꺼울수록 불투명.
          // 넓은 구간(0.02~0.22m)에 걸쳐 올려 초기 엷은 자국→중기 담요→후기 두툼함이 순차로 읽히게.
          vCov = smoothstep(0.02, 0.22, uThick * aGrow);
          ${aoSet}
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vCov; ${aoFragDecl}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${aoFragApply}
        // 디더 알파: 커버리지(vCov) 미만이면 화소 discard. 화면좌표 해시라 확률적 알파(불투명·깊이 안전).
        {
          float _dth = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          if (vCov < _dth) discard;
        }`);
  };
  return m;
}

// 수평 노멀 방위 코히런스 = |Σ(nx,nz)| / Σ|(nx,nz)|. 경사 평면(한 방위)≈1, 둥근 돔(방사)≈0.
// 거의 수평(무물매)면 수평성분이 미미 → 1 반환(돔 아님, 팽창 문제 없음).
export function domeCoherence(s) {
  let sx = 0, sz = 0, sm = 0;
  const n = s.count;
  for (let i = 0; i < n; i++) {
    const nx = s.nor[i * 3], nz = s.nor[i * 3 + 2];
    sx += nx; sz += nz; sm += Math.hypot(nx, nz);
  }
  if (sm < 1e-4) return 1;
  return Math.hypot(sx, sz) / sm;
}

// 정점 눈 두께 계수(grow). 기와 평면(round=false)은 물매 게이트만 — 기존 거동 불변.
// 둥근 볏짚 돔(round=true)은 THATCH_SCALE 로 얇히고, 정수리(ny 큰 곳)를 추가 감쇠(#85).
export function growFor(ny, round) {
  const g = smooth01(ny, 0.10, 0.42);            // 물매 게이트(공통): 완경사=1, 급경사·수직→0
  if (!round) return g;
  return g * THATCH_SCALE * (1 - THATCH_APEX_ATTEN * smooth01(ny, 0.5, 0.92));
}

// ── 지붕 눈 쉘 지오메트리(표면 복제 + 경계 림 벽) ────────────────────────────
export function buildShellGeometry(surfaces) {
  const parts = [];
  for (const s of surfaces) {
    const n = s.count;
    const round = domeCoherence(s) < THATCH_COHERENCE;      // 둥근 볏짚 돔 판별(#85)
    // 표면 복제(기와면 위 0.02m 띄움)
    const pos = new Float32Array(n * 3);
    const lift = new Float32Array(n * 3);
    const grow = new Float32Array(n);
    const out = new Float32Array(n * 3);        // 표면 정점은 outward 0
    const wdir = new Float32Array(n * 2);        // 지붕은 바람 쏠림 0
    for (let i = 0; i < n; i++) {
      const nx = s.nor[i * 3], ny = s.nor[i * 3 + 1], nz = s.nor[i * 3 + 2];
      pos[i * 3] = s.pos[i * 3] + nx * 0.02;
      pos[i * 3 + 1] = s.pos[i * 3 + 1] + ny * 0.02;
      pos[i * 3 + 2] = s.pos[i * 3 + 2] + nz * 0.02;
      lift[i * 3] = nx; lift[i * 3 + 1] = ny; lift[i * 3 + 2] = nz;
      grow[i] = growFor(ny, round);              // #85: 둥근 돔이면 얇게+정수리 감쇠
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aLift', new THREE.BufferAttribute(lift, 3));
    g.setAttribute('aGrow', new THREE.BufferAttribute(grow, 1));
    g.setAttribute('aOut', new THREE.BufferAttribute(out, 3));
    g.setAttribute('aWindDir', new THREE.BufferAttribute(wdir, 2));
    g.setIndex(new THREE.BufferAttribute(s.index, 1));
    g.computeVertexNormals();
    parts.push(g);

    // 경계 림 벽: 처마·박공 가장자리에 눈 두께 단면을 세운다(처마 눈처마 립).
    const edges = boundaryEdges(s.index);
    if (edges.length) parts.push(buildRim(s, edges, round));
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

// 경계 에지마다 사각 벽(림): 아래=기와면(안 자람), 위=들린 눈 가장자리(밖으로 살짝 내밈=립).
// round=true(볏짚 돔): 표면과 동일한 growFor 감쇠를 립에도 적용해 이음매 없이 얇아진다.
function buildRim(s, edges, round = false) {
  const nQuad = edges.length;
  const pos = new Float32Array(nQuad * 4 * 3);
  const lift = new Float32Array(nQuad * 4 * 3);
  const grow = new Float32Array(nQuad * 4);
  const out = new Float32Array(nQuad * 4 * 3);
  const wdir = new Float32Array(nQuad * 4 * 2);   // zeros
  const idx = new Uint32Array(nQuad * 6);
  let vo = 0, io = 0;
  const outward = new THREE.Vector3();
  for (const [a, b] of edges) {
    for (const vi of [a, b]) {
      const nx = s.nor[vi * 3], ny = s.nor[vi * 3 + 1], nz = s.nor[vi * 3 + 2];
      const px = s.pos[vi * 3] + nx * 0.02, py = s.pos[vi * 3 + 1] + ny * 0.02, pz = s.pos[vi * 3 + 2] + nz * 0.02;
      const gw = growFor(ny, round);
      outward.set(nx, 0, nz);
      const hl = outward.length();
      if (hl > 1e-4) outward.multiplyScalar(1 / hl); else outward.set(0, 0, 0);
      // top(들린 눈 가장자리) — lift·grow·out 적용
      pos[vo * 3] = px; pos[vo * 3 + 1] = py; pos[vo * 3 + 2] = pz;
      lift[vo * 3] = nx; lift[vo * 3 + 1] = ny; lift[vo * 3 + 2] = nz;
      grow[vo] = gw;
      out[vo * 3] = outward.x; out[vo * 3 + 1] = outward.y; out[vo * 3 + 2] = outward.z;
      const top = vo; vo++;
      // bottom(기와면 고정) — lift·out 0
      pos[vo * 3] = px; pos[vo * 3 + 1] = py; pos[vo * 3 + 2] = pz;
      grow[vo] = 0;
      vo++;
      // (top, bottom) 쌍이 a, b 순으로 저장됨
    }
    // vo-4..vo-1: [topA, botA, topB, botB]
    const tA = vo - 4, bA = vo - 3, tB = vo - 2, bB = vo - 1;
    idx[io++] = tA; idx[io++] = bA; idx[io++] = tB;
    idx[io++] = tB; idx[io++] = bA; idx[io++] = bB;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLift', new THREE.BufferAttribute(lift, 3));
  g.setAttribute('aGrow', new THREE.BufferAttribute(grow, 1));
  g.setAttribute('aOut', new THREE.BufferAttribute(out, 3));
  g.setAttribute('aWindDir', new THREE.BufferAttribute(wdir, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ── 지면 드리프트(기단 기슭 berm 리본 + 마당 눈더미) ─────────────────────────
function buildGroundGeometry(L) {
  // 처마 낙수선(xEave/zEave) 바로 아래에 눈이 쌓여 두둑을 이룬다(지붕이 흘려보낸 눈 + 처마 밑 그늘).
  const hx = (L.xEave ?? 8) + 0.2;
  const hz = (L.zEave ?? 6) + 0.2;
  const width = 1.8;                        // berm 리본 폭(안쪽 높음→밖으로 스러짐)
  const y0 = 0.02;
  const seg = 120;

  const posA = [], liftA = [], growA = [], outA = [], wdirA = [], aoA = [], idxA = [];
  const dir = new THREE.Vector3();
  const push = (x, z, gw, ao) => {
    dir.set(x, 0, z); const l = dir.length() || 1; dir.multiplyScalar(1 / l);
    posA.push(x, y0, z);
    liftA.push(0, 1, 0);
    growA.push(gw);
    outA.push(0, 0, 0);
    wdirA.push(dir.x, dir.z);               // 바람 쏠림용 방사 방향
    aoA.push(ao);                            // 베이크 AO: 크레스트 밝게, 기슭 어둡게(형태 읽힘)
    return posA.length / 3 - 1;
  };
  // 둥근 사각 둘레 리본(안쪽 링=높음, 바깥 링=0)
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    // 슈퍼타원(모서리 둥근 사각)
    const rr = 1 / Math.pow(Math.pow(Math.abs(c), 4) + Math.pow(Math.abs(s), 4), 0.25);
    const inx = c * rr * hx, inz = s * rr * hz;
    const oux = c * rr * (hx + width), ouz = s * rr * (hz + width);
    push(inx, inz, 1.5, 1.0);      // 안쪽(처마 밑 두둑) — 두껍게(바람 쏠림으로 풍하측 더 높아짐)
    push(oux, ouz, 0.0, 0.72);     // 바깥 — 0 으로 스러짐(기슭 그늘)
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idxA.push(a, c, b, b, c, d);
  }

  // 마당 눈더미 몇 개(처마 낙수/낙설 낙하선 부근 — 결정론 배치, 바람 쏠림)
  const rng = makeRng(0x50f7 ^ Math.round((L.W || 12) * 7 + (L.D || 8) * 13));
  const moundGeos = [];
  const nMound = 6;
  for (let m = 0; m < nMound; m++) {
    const th = rng.range(0, Math.PI * 2);
    const rad = Math.max(hx, hz) + rng.range(0.4, 3.2);
    const cx = Math.cos(th) * rad, cz = Math.sin(th) * rad;
    moundGeos.push(buildMound(cx, cz, rng.range(0.7, 1.5), rng.range(0.45, 0.9)));
  }

  const ribbon = new THREE.BufferGeometry();
  ribbon.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  ribbon.setAttribute('aLift', new THREE.Float32BufferAttribute(liftA, 3));
  ribbon.setAttribute('aGrow', new THREE.Float32BufferAttribute(growA, 1));
  ribbon.setAttribute('aOut', new THREE.Float32BufferAttribute(outA, 3));
  ribbon.setAttribute('aWindDir', new THREE.Float32BufferAttribute(wdirA, 2));
  ribbon.setAttribute('aAO', new THREE.Float32BufferAttribute(aoA, 1));
  ribbon.setIndex(idxA);
  ribbon.computeVertexNormals();

  const merged = mergeGeometries([ribbon, ...moundGeos], false);
  ribbon.dispose(); for (const g of moundGeos) g.dispose();
  return merged;
}

// 낮은 눈더미(눌린 반구). 정점별 aGrow=꼭대기 높음→기슭 0, aWindDir=방사(바람 쏠림).
function buildMound(cx, cz, radius, height) {
  const rings = 4, seg = 10;
  const posA = [], liftA = [], growA = [], outA = [], wdirA = [], aoA = [], idxA = [];
  const dir = new THREE.Vector3();
  for (let r = 0; r <= rings; r++) {
    const rr = r / rings;                    // 0=꼭대기, 1=기슭
    for (let a = 0; a <= seg; a++) {
      const th = (a / seg) * Math.PI * 2;
      const x = cx + Math.cos(th) * rr * radius;
      const z = cz + Math.sin(th) * rr * radius;
      posA.push(x, 0.02, z);
      liftA.push(0, 1, 0);
      growA.push((1 - rr) * (height / MAX_THICK));  // 두께=height(월드) → aGrow*uThick 로 환산
      outA.push(0, 0, 0);
      dir.set(x, 0, z); const l = dir.length() || 1;
      wdirA.push(dir.x / l, dir.z / l);
      aoA.push(1.0 - 0.28 * rr);              // 꼭대기 밝게, 기슭 어둡게(형태 음영)
    }
  }
  const stride = seg + 1;
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < seg; a++) {
      const p0 = r * stride + a, p1 = p0 + 1, p2 = p0 + stride, p3 = p2 + 1;
      idxA.push(p0, p2, p1, p1, p2, p3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  g.setAttribute('aLift', new THREE.Float32BufferAttribute(liftA, 3));
  g.setAttribute('aGrow', new THREE.Float32BufferAttribute(growA, 1));
  g.setAttribute('aOut', new THREE.Float32BufferAttribute(outA, 3));
  g.setAttribute('aWindDir', new THREE.Float32BufferAttribute(wdirA, 2));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(aoA, 1));
  g.setIndex(idxA);
  g.computeVertexNormals();
  return g;
}

// ── 미끄럼 낙설 이벤트 ──────────────────────────────────────────────────────
// 슬래브(눈판)가 처마쪽으로 미끄러지다 처마 밖으로 넘어가 떨어지며 퍼프가 터진다.
function makeSlip() {
  // 슬래브: 얇은 흰 판(살짝 투명). 그룹 트랜스폼으로 위치·기울기 애니.
  const slab = new THREE.Group();
  slab.name = 'snowSlipSlab';
  const slabMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.16, 1.1),
    new THREE.MeshStandardMaterial({ color: 0xf6f8fc, roughness: 0.95, transparent: true, opacity: 0, emissive: 0x1a2028 })
  );
  slab.add(slabMesh);
  slab.visible = false;

  // 퍼프: 낙하 지점에서 흩어지는 눈가루 도트.
  const NP = 80;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(NP * 3);
  const vel = new Float32Array(NP * 3);
  const seed = new Float32Array(NP);
  const rng = makeRng(0x5117);
  for (let i = 0; i < NP; i++) seed[i] = rng();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const puffMat = new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uPix: { value: 300 } },
    transparent: true, depthWrite: false,
    vertexShader: `uniform float uPix; attribute float aSz; varying float vo;
      void main(){ vo=aSz; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*mv; gl_PointSize=(4.0+aSz*9.0)*(uPix/max(-mv.z,1.0)); }`,
    fragmentShader: `uniform float uFade; varying float vo;
      void main(){ vec2 d=gl_PointCoord-0.5; float a=smoothstep(0.5,0.1,length(d))*uFade*(0.5+0.5*vo);
        if(a<0.02) discard; gl_FragColor=vec4(1.0,1.0,1.0,a); }`,
  });
  const aSz = new Float32Array(NP);
  for (let i = 0; i < NP; i++) aSz[i] = seed[i];
  geo.setAttribute('aSz', new THREE.BufferAttribute(aSz, 1));
  const puff = new THREE.Points(geo, puffMat);
  puff.name = 'snowSlipPuff';
  puff.frustumCulled = false;
  puff.renderOrder = 24;
  puff.visible = false;

  // 낙설 경로 앵커(처마 모서리들). configure 에서 layout 으로 채운다.
  let anchors = [];
  let active = false, tSlip = 0, anchorIdx = 0, pinned = false;

  function configure(L, surfaces) {
    const xE = (L.xEave ?? 8), zE = (L.zEave ?? 6), eaveY = (L.eaveEdgeY ?? 5.5);
    // 급물매 처마 모서리 근처 4곳(전/후 처마선의 좌우). start=처마 위쪽, eave=처마끝, ground=지면.
    anchors = [];
    for (const sz of [1, -1]) for (const sx of [0.55, -0.55]) {
      const ex = sx * xE, ez = sz * zE;
      anchors.push({
        start: new THREE.Vector3(ex * 0.72, eaveY + 1.5, ez * 0.72),
        eave: new THREE.Vector3(ex, eaveY + 0.2, ez),
        ground: new THREE.Vector3(ex * 1.12, 0.1, ez * 1.12),
      });
    }
  }

  function fire(t) {
    if (!anchors.length) return;
    anchorIdx = Math.floor(hash01((t + 1) * 2.17) * anchors.length) % anchors.length;
    active = true; tSlip = 0;
  }
  function setPinned(p) {
    if (p == null) { pinned = false; active = false; slab.visible = false; puff.visible = false; return; }
    pinned = true; active = true; anchorIdx = 0; tSlip = p * SLIP_DUR;
  }

  const tmp = new THREE.Vector3();
  function update(dt, accum) {
    if (!active || !anchors.length) { slab.visible = false; puff.visible = false; return; }
    if (!pinned) tSlip += dt;
    const A = anchors[anchorIdx];
    const p = Math.min(1, tSlip / SLIP_DUR);
    // 0..0.45 미끄러짐(start→eave), 0.45..1 낙하(eave→ground)
    slab.visible = true;
    const slabMesh0 = slab.children[0];
    if (p < 0.45) {
      const k = p / 0.45;
      tmp.copy(A.start).lerp(A.eave, k * k);
      slab.position.copy(tmp);
      slab.rotation.set(0, 0, 0);
      slabMesh0.material.opacity = Math.min(1, k * 2) * 0.9;
      puff.visible = false;
    } else {
      const k = (p - 0.45) / 0.55;
      tmp.copy(A.eave).lerp(A.ground, k * k);       // 가속 낙하
      slab.position.copy(tmp);
      slab.rotation.x = k * 1.6;                     // 넘어가며 뒤집힘
      slabMesh0.material.opacity = (1 - k) * 0.9;
      // 퍼프: 낙하 시작(k~0)에 처마에서 터져 흩어짐
      const arr = puff.geometry.attributes.position.array;
      const base = A.eave;
      for (let i = 0; i < NP; i++) {
        const sp = 1.0 + seed[i] * 2.0;
        const ang = seed[i] * Math.PI * 2;
        const rad = (0.2 + seed[i] * 0.9) * k * sp;
        arr[i * 3] = base.x + Math.cos(ang) * rad;
        arr[i * 3 + 1] = base.y - k * (0.6 + seed[i] * 2.4) * sp - k * k * 1.5;
        arr[i * 3 + 2] = base.z + Math.sin(ang) * rad;
      }
      puff.geometry.attributes.position.needsUpdate = true;
      puff.visible = true;
      puffMat.uniforms.uFade.value = (1 - k) * 0.85;
    }
    if (!pinned && p >= 1) { active = false; slab.visible = false; puff.visible = false; }
  }

  function dispose(parent) {
    parent.remove(slab); parent.remove(puff);
    slabMesh.geometry.dispose(); slabMesh.material.dispose();
    puff.geometry.dispose(); puffMat.dispose();
  }

  return { slab, puff, configure, fire, setPinned, update, dispose, get pinned() { return pinned; } };
}

// ── 유틸 ────────────────────────────────────────────────────────────────────
function smooth01(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function hash01(n) {
  const x = Math.sin(n * 91.37 + 7.1) * 43758.5453;
  return x - Math.floor(x);
}
