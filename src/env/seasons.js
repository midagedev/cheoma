import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { getWind } from './wind.js';

// 계절 시스템 — 날씨 시뮬레이터의 "킥": 가을 단풍·봄 벚꽃·여름 신록.
//   setupSeasons(envGroup, { layout }) → { setSeason(name, opts), update(dt), dispose() }
//   name: 'spring' | 'summer' | 'autumn'   (겨울은 weather=snow 가 담당)
//
// 구현 방침:
//  - 잎 색은 나무 재질(공유 MeshStandardMaterial)의 셰이더를 onBeforeCompile 로 패치해
//    vertex 단계에서 vColor 를 계절 목표색으로 이동시킨다. 재질을 교체하지 않으므로
//    weather.js 의 적설 패치(fragment, color_fragment 이후)와 자연히 합성된다
//    (잎 색 → 그 위에 눈 블렌딩). 소나무(species 0)는 상록으로 무시.
//  - 개체별 phase: instanceMatrix 위치 해시로 잎 색 채도·명도와 물드는 시차를 흩뜨린다.
//  - 계절 전환은 항상 여름(초록)을 경유해 보간 → 빨강↔분홍 직접 보간의 진흙색을 피한다.
//  - 지면은 terrain 재질에 aGround 마스크 기반 곱연산 틴트(가을 마른 금빛/봄 신록)를
//    주입 — 박석 마당은 유지, 풀·숲 원경만 은은하게.
//  - 낙하 파티클: 나무 수관에서 흩날리는 낙엽/벚꽃잎(InstancedMesh 쿼드, MeshBasic →
//    weather 적설 traverse 대상 아님). 바람 사인 요동 + 회전 낙하 + 지면/수관 끝 페이드.

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 수종별 계절 목표 잎색 (index = SPECIES). pine(0)은 미사용(상록).
const AUTUMN = [0x000000, 0xe8c33a, 0xc8452c, 0xa5762f, 0xcf6b4e]; // 은행 진노랑 / 단풍 주홍 / 잡목 갈금 / 벚 코랄
const SPRING = [0x000000, 0x9cc24a, 0x8fbf52, 0x93c256, 0xf2bcd0]; // 신록 연둣빛 / 벚 연분홍
const SEASON_AMT = { spring: 0.85, summer: 0, autumn: 0.92 };

// 지면 곱연산 톤 (aGround 영역). 여름=중립. 가을은 마른 풀 금빛(#b99a55 계열)이
// 분명히 읽히게, 봄은 여름과 구별되는 신록으로.
const GROUND_MUL = {
  spring: new THREE.Vector3(0.9, 1.1, 0.78),
  summer: new THREE.Vector3(1, 1, 1),
  autumn: new THREE.Vector3(1.24, 1.06, 0.46),
};
const GROUND_AMT = { spring: 0.7, summer: 0, autumn: 1.0 };

const RATE = 2.6;          // 색/지면 보간 속도 (1/s) — 대략 1.5s 안에 여름 경유 전환
const PART_RATE = 2.4;     // 파티클 페이드 속도
const TREE_SWAY = 1.15;    // 나무 수관 흔들림 진폭(월드 단위 배율)
const LITTER_UP = 38;      // 낙엽 지면 누적 0→1 시간(초) — 은은히
const LITTER_DOWN = 12;    // 낙엽 사라짐 시간(초)
const TAU = Math.PI * 2;

export function setupSeasons(envGroup, { layout, paddies = null } = {}) {
  let disposed = false;
  // ---------- 대상 재질 수집 ----------
  const treesGroup = envGroup.getObjectByName('trees');
  const terrainGroup = envGroup.getObjectByName('terrain');
  const treeInsts = treesGroup ? treesGroup.children.filter((o) => o.isInstancedMesh) : [];
  const treeMat = treeInsts.length ? treeInsts[0].material : null;
  const terrainMesh = terrainGroup ? terrainGroup.getObjectByName('terrain') : null;
  const terrainMat = terrainMesh ? terrainMesh.material : null;

  // ---------- 공유 uniform ----------
  // 잎 목표색은 수종(은행·단풍·잡목·벚)별 vec3 uniform 4개. three.js onBeforeCompile 에서
  // 배열 uniform 의 동적 인덱싱은 업로드가 불안정하므로 스칼라 uniform + 정적 분기로 처리.
  const uCol = [0, 1, 2, 3].map(() => ({ value: new THREE.Vector3(0.15, 0.32, 0.12) }));
  const uTargetAmt = { value: 0 };
  const uGroundMul = { value: new THREE.Vector3(1, 1, 1) };
  const uGroundAmt = { value: 0 };
  // 나무 흔들림: 바람 필드(wind.js)를 vertex 셰이더로 넘겨 수관을 월드 방향으로 미세하게 눕힌다.
  // 거스트가 불면 파티클과 함께 크게 휘어 "바람이 분다"가 화면 전체에서 동기화돼 읽힌다.
  const uWind = { value: new THREE.Vector2(0, 0) };
  const uWindTime = { value: 0 };

  if (treeMat) patchTrees(treeMat, uCol, uTargetAmt, uWind, uWindTime);
  if (terrainMat) patchTerrain(terrainMat, uGroundMul, uGroundAmt);

  // ---------- 파티클(낙엽/벚꽃) ----------
  const leaves = buildLeaves(treeInsts);
  if (leaves) envGroup.add(leaves.mesh);
  // 낙엽 지면 누적(가을): 나무 밑·마당 구석에 낙엽 데칼이 서서히 늘어난다.
  const litter = buildLitter(treeInsts, layout);
  if (litter) envGroup.add(litter.mesh);

  // ---------- 전환 상태기계 ----------
  // 항상 여름(amt→0)으로 내렸다가, 목표 팔레트로 다시 올린다.
  let season = 'summer';
  let pending = 'summer';
  let phase = 'idle';            // 'out' | 'in' | 'idle'
  let amt = 0;                   // 잎 색 강도 (uTargetAmt)
  let amtGoal = 0;
  let gAmt = 0;                  // 지면 강도
  let gAmtGoal = 0;
  const gMul = new THREE.Vector3(1, 1, 1);       // 현재 지면 곱
  const gMulGoal = new THREE.Vector3(1, 1, 1);
  let partAmt = 0;               // 파티클 가시 강도
  let partGoal = 0;
  let litterLevel = 0;           // 낙엽 지면 누적 진행도(0..1)
  let litterGoal = 0;
  let pinnedLitter = null;       // shot 하네스로 특정 누적 단계 고정(null=자유 진행)
  let t = 0;

  function applyPalette(name) {
    const src = name === 'autumn' ? AUTUMN : SPRING;
    // uCol[0..3] = 은행(1)·단풍(2)·잡목(3)·벚(4). Color→Vector3 은 채널을 직접 옮긴다
    // (Vector3.copy 는 .x/.y/.z 를 읽어 Color 를 그대로 넣으면 NaN 이 된다).
    for (let i = 0; i < 4; i++) {
      const c = linCol(src[i + 1] || 0x2a4020);
      uCol[i].value.set(c.r, c.g, c.b);
    }
    gMulGoal.copy(GROUND_MUL[name] || GROUND_MUL.summer);
    if (leaves) leaves.setSeason(name);
  }

  function setSeason(name, opts = {}) {
    if (disposed) return;
    if (!['spring', 'summer', 'autumn'].includes(name)) name = 'summer';
    pending = name;
    partGoal = name === 'summer' ? 0 : 1;
    litterGoal = name === 'autumn' ? 1 : 0;  // 낙엽 누적은 가을에만
    // 다랑이 논 계절 전파(자체 보간). shot 모드는 즉시 세팅.
    if (paddies) { if (opts.immediate) paddies.applyImmediate(name); else paddies.setSeason(name); }

    if (opts.immediate) {
      season = name;
      phase = 'idle';
      if (name !== 'summer') applyPalette(name);
      amt = amtGoal = SEASON_AMT[name];
      gAmt = gAmtGoal = GROUND_AMT[name];
      gMul.copy(GROUND_MUL[name] || GROUND_MUL.summer);
      gMulGoal.copy(gMul);
      partAmt = partGoal;
      litterLevel = opts.litter != null ? opts.litter : litterGoal;
      if (litter) litter.setLevel(litterLevel);
      pushUniforms();
      if (leaves) { leaves.mesh.visible = partAmt > 0.01; leaves.prewarm(); }
      return;
    }
    // 부드러운 전환: 먼저 여름으로 내린다(현재가 이미 여름이면 즉시 in 으로).
    phase = 'out';
    amtGoal = 0;
    gAmtGoal = 0;
  }

  function pushUniforms() {
    uTargetAmt.value = amt;
    uGroundAmt.value = gAmt;
    uGroundMul.value.copy(gMul);
  }

  function update(dt) {
    if (disposed) return;
    t += dt;
    const k = Math.min(1, dt * RATE);

    if (phase === 'out') {
      amt += (0 - amt) * k;
      gAmt += (0 - gAmt) * k;
      if (amt < 0.02) {
        amt = 0; gAmt = 0;
        season = pending;
        if (season === 'summer') {
          phase = 'idle';
        } else {
          applyPalette(season);
          amtGoal = SEASON_AMT[season];
          gAmtGoal = GROUND_AMT[season];
          phase = 'in';
        }
      }
    } else if (phase === 'in') {
      amt += (amtGoal - amt) * k;
      gAmt += (gAmtGoal - gAmt) * k;
      gMul.lerp(gMulGoal, k);
      if (Math.abs(amtGoal - amt) < 0.01) { amt = amtGoal; gAmt = gAmtGoal; phase = 'idle'; }
    }
    pushUniforms();

    // 바람 uniform 갱신(나무 흔들림). 필드는 wind.js 하나 → 파티클과 거스트 타이밍 동기.
    const w = getWind(t);
    uWind.value.set(w.dirX * w.speed * TREE_SWAY, w.dirZ * w.speed * TREE_SWAY);
    uWindTime.value = t;

    // 파티클
    partAmt += (partGoal - partAmt) * Math.min(1, dt * PART_RATE);
    if (leaves) {
      const vis = partAmt > 0.01;
      leaves.mesh.visible = vis;
      if (vis) leaves.update(dt, t, partAmt, w);
    }

    // 낙엽 지면 누적(선형 램프, 은은히). 가을 진입 후 서서히 늘고, 떠나면 서서히 사라진다.
    if (pinnedLitter != null) {
      litterLevel = pinnedLitter;
    } else if (litterGoal > litterLevel) {
      litterLevel = Math.min(litterGoal, litterLevel + dt / LITTER_UP);
    } else {
      litterLevel = Math.max(litterGoal, litterLevel - dt / LITTER_DOWN);
    }
    if (litter) litter.setLevel(litterLevel);

    if (paddies) paddies.update(dt);   // 논 계절색·물강도 보간
  }

  // shot 하네스 훅: 낙엽 누적 단계 고정(은은한 증가 비교 컷). v=null 이면 자유 진행.
  let seasonDebug = null;
  if (typeof window !== 'undefined') {
    seasonDebug = { setLitter(v) { pinnedLitter = v; if (v != null && litter) { litterLevel = v; litter.setLevel(v); } } };
    window.__season = seasonDebug;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (leaves) {
      envGroup.remove(leaves.mesh);
      leaves.mesh.geometry.dispose();
      leaves.mesh.material.dispose();
      if (leaves.tex) leaves.tex.dispose();
    }
    if (litter) {
      envGroup.remove(litter.mesh);
      litter.mesh.geometry.dispose();
      litter.mesh.material.dispose();
      if (litter.tex) litter.tex.dispose();
    }
    uTargetAmt.value = 0;
    uGroundAmt.value = 0;
    if (typeof window !== 'undefined' && window.__season === seasonDebug) delete window.__season;
  }

  return { setSeason, update, dispose, get season() { return season; } };
}

// ---------- 재질 셰이더 패치 ----------

function patchTrees(mat, uCol, uTargetAmt, uWind, uWindTime) {
  if (mat.userData.__seasonPatched) return;
  mat.userData = mat.userData || {};
  mat.userData.__seasonPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uCol1 = uCol[0];
    shader.uniforms.uCol2 = uCol[1];
    shader.uniforms.uCol3 = uCol[2];
    shader.uniforms.uCol4 = uCol[3];
    shader.uniforms.uTargetAmt = uTargetAmt;
    shader.uniforms.uWind = uWind;
    shader.uniforms.uWindTime = uWindTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFoliage;
        attribute float aSpecies;
        uniform vec3 uCol1;
        uniform vec3 uCol2;
        uniform vec3 uCol3;
        uniform vec3 uCol4;
        uniform float uTargetAmt;
        uniform vec2 uWind;
        uniform float uWindTime;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
      #if defined( USE_INSTANCING )
      if (aFoliage > 0.5) {
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float h = fract(sin(dot(ip, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        int sp = int(aSpecies + 0.5);
        vec3 tgt = uCol1;                          // 은행(1)
        if (sp == 2) tgt = uCol2;                  // 단풍
        else if (sp == 3) tgt = uCol3;             // 잡목
        else if (sp == 4) tgt = uCol4;             // 벚
        tgt *= (0.80 + 0.36 * h);                  // 개체별 채도·명도 편차
        float amt = sp == 0 ? 0.0 : uTargetAmt;    // 소나무(0)는 상록
        float localAmt = clamp(amt * (0.70 + 0.58 * h), 0.0, 1.0); // 물드는 시차
        vColor.rgb = mix(vColor.rgb, tgt, localAmt);
      }
      #endif`)
      // 바람 흔들림: instanceMatrix 적용 후(월드 공간)에 수관을 바람 방향으로 눕힌다. 높이가 높은
      // 잎일수록 크게, 개체별 위상으로 서로 다르게. 줄기(aFoliage=0)는 고정.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          if (aFoliage > 0.5) {
            vec3 wip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            float wph = fract(sin(dot(wip, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
            float hf = clamp((mvPosition.y - wip.y) / 6.0, 0.0, 1.6);
            float sway = 0.6 * sin(uWindTime * 1.7 + wph) + 0.4 * sin(uWindTime * 3.1 + wph * 1.7);
            vec2 disp = uWind * hf * (0.55 + 0.6 * sway);
            mvPosition.x += disp.x;
            mvPosition.z += disp.y;
          }
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.needsUpdate = true;
}

function patchTerrain(mat, uGroundMul, uGroundAmt) {
  if (mat.userData.__seasonPatched) return;
  mat.userData = mat.userData || {};
  mat.userData.__seasonPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uGroundMul = uGroundMul;
    shader.uniforms.uGroundAmt = uGroundAmt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGround;\nvarying float vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = aGround;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGroundMul;\nuniform float uGroundAmt;\nvarying float vGround;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), uGroundMul, uGroundAmt * vGround);`);
  };
  mat.needsUpdate = true;
}

// ---------- 낙엽/벚꽃 파티클 ----------

// 잎 실루엣 절차 생성(#116) — "낙엽이 낙엽답게": 원형 점이 아니라 은행잎(부채꼴)·단풍잎(손바닥)
// 형태를 흰 알파로 그린다(색은 instanceColor 로 곱함). 셀 중심 (32,32), 위=−y.
//   kind 0=벚꽃 꽃잎(둥근 타원+끝 파임), 1=은행(부채꼴+중앙 결각+잎자루), 2=단풍(5갈래+잎자루).
function drawLeafShape(g, kind) {
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
  if (kind === 0) {                       // 벚꽃 꽃잎
    g.beginPath();
    g.moveTo(0, 21);
    g.bezierCurveTo(15, 13, 14, -13, 3, -19);
    g.quadraticCurveTo(0, -15, -3, -19);  // 끝 살짝 파임
    g.bezierCurveTo(-14, -13, -15, 13, 0, 21);
    g.fill();
  } else if (kind === 1) {                 // 은행잎(부채꼴)
    g.beginPath();
    g.moveTo(0, 20);                        // 잎자루 위쪽 기점
    g.quadraticCurveTo(-17, 12, -22, -9);   // 왼쪽 옆선 위로
    g.quadraticCurveTo(-13, -19, -4, -11);  // 왼쪽 상단 봉우리
    g.quadraticCurveTo(0, -8, 4, -11);      // 중앙 결각(V 패임)
    g.quadraticCurveTo(13, -19, 22, -9);    // 오른쪽 상단 봉우리
    g.quadraticCurveTo(17, 12, 0, 20);      // 오른쪽 옆선 아래로
    g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 18); g.lineTo(0, 29); g.stroke(); // 잎자루
  } else {                                 // 단풍잎(5갈래 손바닥)
    const tips = [0, 65, 135, 225, 295];   // 위·우상·우하·좌하·좌상 (deg, 위=0)
    const R = 23;
    g.beginPath();
    for (let i = 0; i < tips.length; i++) {
      const a = tips[i] * Math.PI / 180;
      const x = Math.sin(a) * R, y = -Math.cos(a) * R;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      const n = tips[(i + 1) % tips.length];
      let mid = (tips[i] + (n > tips[i] ? n : n + 360)) / 2;
      const bottom = Math.abs(((mid % 360) + 360) % 360 - 180) < 20; // 바닥(180°)=잎자루 골
      const rv = bottom ? 5 : 10;
      const av = mid * Math.PI / 180;
      g.lineTo(Math.sin(av) * rv, -Math.cos(av) * rv);
    }
    g.closePath(); g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 6); g.lineTo(0, 30); g.stroke(); // 잎자루
  }
}

// 3프레임 아틀라스(192×64: [벚꽃|은행|단풍]). InstancedMesh 는 per-instance aFrame UV 오프셋으로 프레임 선택.
function makeLeafAtlas() {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 192, 64);
  for (let f = 0; f < 3; f++) {
    g.save(); g.translate(f * 64 + 32, 32); drawLeafShape(g, f); g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildLeaves(treeInsts) {
  // 낙엽수(은행·단풍·잡목·벚)에서 이미터 수집. instanceMatrix 이동 = 지면 높이.
  const shed = new Set(['ginkgo', 'maple', 'misc', 'cherry']);
  const emitters = [];
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const inst of treeInsts) {
    if (!shed.has(inst.name)) continue;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m4);
      m4.decompose(pos, quat, scl);
      const s = (scl.x + scl.z) * 0.5;
      emitters.push({ x: pos.x, y: pos.y, z: pos.z, r: 2.6 * s, top: 8.5 * s, bot: 3.4 * s, sp: inst.name });
    }
  }
  if (!emitters.length) return null;

  // 가중 이미터 선택: 화면 안(건물 주변, 원점 가까이)의 나무가 낙엽을 더 많이 뿌리게 해
  // 원경 숲에 흩어져 안 보이는 문제를 피한다.
  const weights = emitters.map((e) => 1 / (1 + Math.pow(Math.hypot(e.x, e.z) / 44, 2.4)));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pickEmitter = (u) => {
    let acc = u * wsum;
    for (let k = 0; k < emitters.length; k++) { acc -= weights[k]; if (acc <= 0) return emitters[k]; }
    return emitters[emitters.length - 1];
  };

  // #125 개수 대폭 감축(사용자: "색종이 축제 아니라 바람에 이따금 지는 잎"). 640→~150. 나무 방출
  //   낙엽은 마을 중심 근경에서만 보이는 보조분(원점 밖 focus 근경은 petals 담당) → 성기게 충분.
  //   per-frame 갱신 루프도 감축분만큼 저비용(성능 우선).
  const N = Math.min(160, emitters.length * 4);
  const tex = makeLeafAtlas();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    alphaTest: 0.03, fog: true,
  });
  // per-instance aFrame(0/1/2)으로 아틀라스 3프레임 중 하나를 UV 오프셋 선택(단일 드로우콜 유지).
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFrame;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = vec2((vMapUv.x + aFrame) / 3.0, vMapUv.y);\n#endif');
  };
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('aFrame', new THREE.InstancedBufferAttribute(new Float32Array(N), 1));
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'seasonLeaves';
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  mesh.visible = false;

  // 파티클 상태
  const st = [];
  let s = 0x9e3779b9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) {
    const e = pickEmitter(rnd());
    st.push({
      e,
      hh: rnd() * e.top,                 // 지면 위 높이 (0..top)
      ox: (rnd() * 2 - 1),               // 정규화 반경 오프셋
      oz: (rnd() * 2 - 1),
      phase: rnd() * Math.PI * 2,
      swaySpd: 0.6 + rnd() * 0.9,
      swayAmp: 0.6 + rnd() * 1.1,
      fall: 1.1 + rnd() * 1.3,
      spin: rnd() * Math.PI * 2,
      spinSpd: (rnd() * 2 - 1) * 1.8,
      size: 0.36 + rnd() * 0.20,          // #125 월드 0.36~0.56m — 사람 스케일 대비 자연스러운 낙엽(구 1.0~1.7m=사람만)
      tilt: rnd(),                        // 회전축 성향
    });
  }

  const dummy = new THREE.Object3D();
  let t2 = 0;             // 현재 애니메이션 시간(요동 위상)
  let fallScale = 1;      // 계절별 낙하 계수 (봄 벚꽃잎이 더 느리고 가볍게)
  let sizeScale = 1;
  let windX = 0, windZ = 0, windGust = 0; // 매 프레임 wind.js 필드에서 갱신

  function setSeason(name) {
    const spring = name === 'spring';
    fallScale = spring ? 0.6 : 1.0;
    sizeScale = spring ? 0.82 : 1.0;
    // 개체 형태·색: 가을은 이미터 수종을 따라간다 — 은행나무는 은행잎(황금), 단풍나무는 단풍잎(주홍~주황),
    //   벚·잡목은 단순 잎(웜 오렌지-브라운). 봄은 전부 벚꽃 꽃잎(연분홍). #116 "낙엽을 낙엽답게".
    const GINKGO = [0xf2c53d, 0xf0b429, 0xe8b21f, 0xf5ce4a];       // 순수 황금(은행)
    const MAPLE  = [0xc0392b, 0xd35400, 0xe0491f, 0xb83a1e, 0xd9622b]; // 진홍~주황(단풍)
    const WARM   = [0xd9772b, 0xc86a2a, 0xcf9a3a, 0xbe7d34];       // 벚·잡목 낙엽(오렌지-브라운)
    const SP     = [0xf3c4d6, 0xf0b0c8, 0xe79bbf, 0xfad9e6];       // 봄 벚꽃
    const frames = geo.attributes.aFrame.array;
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const sp = st[i].e.sp;
      let frame, pal;
      if (spring) { frame = 0; pal = SP; }
      else if (sp === 'ginkgo') { frame = 1; pal = GINKGO; }
      else if (sp === 'maple') { frame = 2; pal = MAPLE; }
      else if (sp === 'misc') { frame = (i & 1) ? 1 : 2; pal = (i & 1) ? GINKGO : MAPLE; } // 잡목=은행·단풍 혼합
      else { frame = 0; pal = WARM; }        // cherry 등 = 단순 잎 오렌지-브라운
      frames[i] = frame;
      col.copy(linCol(pal[(i * 5) % pal.length]));
      const j = 0.85 + ((i * 2654435761) % 1000) / 1000 * 0.3;  // 개체 밝기 편차
      mesh.setColorAt(i, col.multiplyScalar(j));
    }
    geo.attributes.aFrame.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  function writeOne(i, globalFade) {
    const p = st[i];
    const e = p.e;
    // 아래로 내려올수록 수관 밖으로 부채꼴로 흩어진다(공중에 퍼지는 낙엽).
    const fallT = 1 - Math.min(1, Math.max(0, p.hh / e.top));
    const spread = e.r * (0.6 + 1.5 * fallT);
    // 거스트가 불면 요동이 커지고 소용돌이가 세진다.
    const swirl = 1 + windGust * 1.8;
    const wob = Math.sin(t2 * p.swaySpd + p.phase);
    const wob2 = Math.cos(t2 * p.swaySpd * 0.8 + p.phase);
    // 바람 횡류: 낮게 내려올수록(fallT↑) 더 멀리 실려간다.
    const carry = (0.6 + 1.6 * fallT);
    const px = e.x + p.ox * spread + wob * p.swayAmp * (0.5 + fallT) * swirl + windX * carry;
    const pz = e.z + p.oz * spread + wob2 * p.swayAmp * (0.5 + fallT) * swirl + windZ * carry;
    const py = e.y + e.bot * 0.2 + p.hh;
    // 끝단 페이드: 지면 근처(하강 끝) + 수관 꼭대기(재생성 직후) 축소
    const endFade = Math.min(smoothstep(0, 1.4, p.hh), smoothstep(e.top, e.top - 1.4, p.hh));
    const sc = p.size * sizeScale * globalFade * (0.3 + 0.7 * endFade);
    dummy.position.set(px, py, pz);
    dummy.rotation.set(p.spin * (0.5 + p.tilt), p.spin, p.spin * (0.3 + p.tilt * 0.4));
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  function update(dt, tt, globalFade, w) {
    t2 = tt;
    if (w) { windX = w.dirX * w.speed * 1.6; windZ = w.dirZ * w.speed * 1.6; windGust = w.gust; }
    for (let i = 0; i < N; i++) {
      const p = st[i];
      p.hh -= p.fall * fallScale * dt;
      if (p.hh < 0) p.hh += p.e.top;             // 재순환
      p.spin += (p.spinSpd + windGust * 1.5) * dt; // 거스트에 회전 가속
      writeOne(i, globalFade);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function prewarm() {
    // shot 모드: 위상 없이 즉시 한 번 배치(공중 정지 방지용 최소 셋업).
    t2 = 0;
    for (let i = 0; i < N; i++) writeOne(i, 1);
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, tex, setSeason, update, prewarm };
}

// ---------- 낙엽 지면 누적 ----------
// 가을에 나무 밑·마당 구석에 낙엽 데칼(바닥에 눕힌 쿼드)이 서서히 쌓인다. setLevel(0..1)로
// 개체별 임계값을 넘긴 것만 드러내 "점점 쌓이는" 느낌을 준다. MeshBasic → 적설 traverse 대상 아님.
function buildLitter(treeInsts, layout = {}) {
  const shed = new Set(['ginkgo', 'maple', 'misc', 'cherry']);
  const bases = [];
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const inst of treeInsts) {
    if (!shed.has(inst.name)) continue;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m4); m4.decompose(pos, quat, scl);
      const s = (scl.x + scl.z) * 0.5;
      bases.push({ x: pos.x, y: pos.y, z: pos.z, r: 2.6 * s });
    }
  }
  // 화면 안(원점 가까운) 나무만 낙엽을 뿌리게 가중 정렬 → 원경에 흩어져 안 보이는 문제 회피.
  bases.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
  const nearBases = bases.slice(0, 48);

  let s = 0x1234abcd;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  // 낙엽 데칼 위치 수집: 나무 밑 원반 + 마당 네 구석.
  const spots = [];
  for (const b of nearBases) {
    const k = 3 + Math.floor(rnd() * 3);   // #125 지면 낙엽 대폭 감축(낙하 낙엽과 같은 비율) — 성기게
    for (let i = 0; i < k; i++) {
      const rr = Math.sqrt(rnd()) * b.r * 1.5;
      const th = rnd() * Math.PI * 2;
      spots.push({ x: b.x + Math.cos(th) * rr, y: b.y + 0.04, z: b.z + Math.sin(th) * rr });
    }
  }
  // 마당 구석(기단 바깥 모서리)에 바람에 몰린 낙엽 무더기(진입로·계단 앞 포함).
  const xE = (layout.xEave ?? 9) + 3, zE = (layout.zEave ?? 6) + 3;
  const corners = [[-xE, -zE], [xE, -zE], [-xE, zE], [xE, zE], [0, zE + 2], [-xE * 0.6, zE + 1]];
  for (const [cx, cz] of corners) {
    for (let i = 0; i < 9; i++) {   // #125 구석 무더기도 감축(14→9) — 지면이 낙엽으로 뒤덮이지 않고 드문드문
      spots.push({ x: cx + (rnd() * 2 - 1) * 3.6, y: 0.05, z: cz + (rnd() * 2 - 1) * 3.6 });
    }
  }
  const N = spots.length;
  if (!N) return null;

  const tex = makeLeafAtlas();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    alphaTest: 0.06, fog: true,
  });
  // per-instance aFrame UV 오프셋으로 은행·단풍·단순잎 실루엣 선택(지면 낙엽도 낙엽답게, #116).
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFrame;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = vec2((vMapUv.x + aFrame) / 3.0, vMapUv.y);\n#endif');
  };
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('aFrame', new THREE.InstancedBufferAttribute(new Float32Array(N), 1));
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'seasonLitter';
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6; // 지면 위, 낙하 낙엽/눈보다 아래
  mesh.visible = false;

  // 지면 낙엽 종별 색·형태: 은행(황금)·단풍(주홍~주황)·단순잎(오렌지-브라운) 혼합.
  const GINKGO = [0xf2c53d, 0xf0b429, 0xe8b21f];
  const MAPLE = [0xc0392b, 0xd35400, 0xb83a1e, 0xd9622b];
  const WARM = [0xc98a3a, 0x9a6b2e, 0xc0632f, 0xb5502a];
  const frames = geo.attributes.aFrame.array;
  const col = new THREE.Color();
  const st = [];
  for (let i = 0; i < N; i++) {
    st.push({
      sp: spots[i],
      rev: rnd(),                       // 드러나는 임계값(누적 진행도가 이걸 넘으면 보임)
      rot: rnd() * Math.PI * 2,         // 바닥면 내 회전
      size: 0.6 + rnd() * 0.55,        // #125 지면 낙엽 클럼프 스케일(구 2.1~4.0m=거대) — 잎 무더기로 읽히되 사람 스케일 이하
      tiltX: (rnd() * 2 - 1) * 0.12,    // 살짝 들뜬 각도
      tiltZ: (rnd() * 2 - 1) * 0.12,
    });
    const r3 = i % 3;
    const frame = r3 === 0 ? 1 : r3 === 1 ? 2 : 0;   // 은행·단풍·단순잎 순환
    const pal = frame === 1 ? GINKGO : frame === 2 ? MAPLE : WARM;
    frames[i] = frame;
    col.copy(linCol(pal[(i * 5) % pal.length])).multiplyScalar(0.8 + rnd() * 0.35);
    mesh.setColorAt(i, col);
  }
  geo.attributes.aFrame.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;

  const dummy = new THREE.Object3D();
  let last = -1;
  function setLevel(level) {
    if (Math.abs(level - last) < 0.004) return;
    last = level;
    mesh.visible = level > 0.005;
    if (!mesh.visible) return;
    for (let i = 0; i < N; i++) {
      const p = st[i];
      // rev 를 넘긴 개체만 드러난다(0→full 부드럽게). 누적이 커질수록 데칼이 늘어난다.
      const g = smoothstep(p.rev, p.rev + 0.18, level);
      const sc = g * p.size;
      dummy.position.set(p.sp.x, p.sp.y, p.sp.z);
      dummy.rotation.set(-Math.PI / 2 + p.tiltX, p.rot, p.tiltZ);
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  setLevel(0);

  return { mesh, tex, setLevel };
}
