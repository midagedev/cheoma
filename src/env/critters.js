import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { presentationWeight } from '../core/lod.js';
import { makeRng } from '../rng.js';

// 생물 앰비언트: 마을에 생명감. 새 떼(boids)·까치·개·고양이.
//   setupCritters(parent, { heightAt, layout }) →
//     { update(dt), setTime(name), setSeason(name), setEnabled(bool) }
//   parent: 환경 group. 여기에 critters 서브그룹을 붙여 env ON/OFF(가시성)에 함께 묶인다.
// 파티클·본 없이 트랜스폼 애니메이션만. 시드 결정론. 추가 부하 < 1ms/frame 목표.
//
// 좌표 규약: 모든 모델은 로컬 +X 를 정면(진행 방향)으로 만든다. 지면 부착은 heightAt.
// 새는 하늘 실루엣(unlit, fog 무시)이라 원경에서 먹점 무리로 읽힌다. 밤엔 새 떼 없음.

const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const M4 = () => new THREE.Matrix4();
const TAU = Math.PI * 2;

// 파트에 균일 vertex color 부여 + 비인덱스 통일(merge 안전). uv 는 제거해 속성 세트를 맞춘다.
function tint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = lin(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}
// 파트 배치: 이동 → 회전(y,z) → 스케일 순으로 로컬 변환.
function place(geo, x, y, z, o = {}) {
  const { ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = o;
  const m = M4().makeTranslation(x, y, z);
  if (ry) m.multiply(M4().makeRotationY(ry));
  if (rz) m.multiply(M4().makeRotationZ(rz));
  m.multiply(M4().makeScale(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ico = (r) => new THREE.IcosahedronGeometry(r, 1);
const cone = (r, h) => new THREE.ConeGeometry(r, h, 4);

// 지수 분포(포아송 간격) — 간헐 이벤트 스케줄. lo/hi 로 클램프.
function poisson(rng, mean, lo, hi) {
  const u = Math.max(1e-6, rng());
  return Math.min(hi, Math.max(lo, -mean * Math.log(u)));
}

// ---------- 모델 지오메트리 (전부 로컬 +X 정면, y=0 접지) ----------

// 개: 누렁이 톤 로우폴리(~108 tri). 다리 관절 없음 — 몸통 바운스·기울임으로 걸음 암시.
function buildDog() {
  const tan = 0xc79a5b, dark = 0x7a5230, paw = 0x6b4c2c;
  const p = [];
  p.push(tint(place(box(0.85, 0.34, 0.30), 0, 0.52, 0), tan));        // 몸통
  p.push(tint(place(box(0.34, 0.30, 0.26), 0.42, 0.58, 0), tan));     // 목·가슴
  p.push(tint(place(box(0.26, 0.26, 0.24), 0.62, 0.66, 0), tan));     // 머리
  p.push(tint(place(box(0.18, 0.13, 0.13), 0.78, 0.60, 0), dark));    // 주둥이
  p.push(tint(place(box(0.05, 0.12, 0.09), 0.56, 0.82, 0.10), dark)); // 귀
  p.push(tint(place(box(0.05, 0.12, 0.09), 0.56, 0.82, -0.10), dark));
  const leg = (x, z) => tint(place(box(0.10, 0.36, 0.11), x, 0.18, z), paw);
  p.push(leg(0.30, 0.12), leg(0.30, -0.12), leg(-0.28, 0.12), leg(-0.28, -0.12));
  p.push(tint(place(box(0.32, 0.09, 0.09), -0.58, 0.66, 0, { rz: 0.7 }), tan)); // 꼬리(위로)
  return mergeGeometries(p, false);
}

// 고양이 몸통(웅크림, ~80 tri). 꼬리는 별도(사인 흔들림).
function buildCatBody() {
  const fur = 0x303138, chest = 0xb9bdc2;
  const p = [];
  p.push(tint(place(ico(0.24), 0, 0.22, 0, { sx: 1.02, sy: 0.60, sz: 0.66 }), fur)); // 웅크린 몸통
  p.push(tint(place(ico(0.13), 0.28, 0.30, 0), fur));                                 // 머리
  p.push(tint(place(cone(0.05, 0.11), 0.28, 0.44, 0.07), fur));                       // 귀
  p.push(tint(place(cone(0.05, 0.11), 0.28, 0.44, -0.07), fur));
  p.push(tint(place(ico(0.09), 0.30, 0.20, 0, { sx: 0.8, sy: 0.9, sz: 0.7 }), chest)); // 가슴 밝은 패치
  return mergeGeometries(p, false);
}
// 고양이 꼬리: 원점에서 +X 로 뻗음 → 흔들 때 base 를 축으로 회전.
function buildCatTail() { return tint(place(box(0.42, 0.06, 0.06), 0.21, 0, 0), 0x2b2c31); }

// 까치 몸통(~80 tri): 검정+흰 배·어깨, 파란 기 도는 검정 꼬리(별도).
function buildMagpieBody() {
  const blk = 0x1b1e25, wht = 0xe9eaec, wing = 0x2a3644;
  const p = [];
  p.push(tint(place(ico(0.13), 0, 0.13, 0, { sx: 1.05, sy: 0.9, sz: 0.82 }), blk)); // 몸통
  p.push(tint(place(ico(0.09), 0.0, 0.13, 0.085, { sx: 1.0, sy: 0.85, sz: 0.55 }), wht)); // 흰 어깨(좌우)
  p.push(tint(place(ico(0.09), 0.0, 0.13, -0.085, { sx: 1.0, sy: 0.85, sz: 0.55 }), wht));
  p.push(tint(place(ico(0.085), -0.04, 0.08, 0, { sx: 1.0, sy: 0.7, sz: 0.95 }), wht)); // 흰 배(아래)
  p.push(tint(place(ico(0.075), 0.15, 0.22, 0), blk));                              // 머리
  p.push(tint(place(cone(0.022, 0.08), 0.23, 0.22, 0, { rz: -Math.PI / 2 }), 0x111318)); // 부리(+X)
  p.push(tint(place(box(0.14, 0.04, 0.04), -0.02, 0.15, 0.11, { rz: 0.1 }), wing)); // 어깨 날개기
  p.push(tint(place(box(0.14, 0.04, 0.04), -0.02, 0.15, -0.11, { rz: 0.1 }), wing));
  return mergeGeometries(p, false);
}
function buildMagpieTail() { return tint(place(box(0.34, 0.045, 0.06), 0.17, 0, 0), 0x232c39); }

// 새(원경 실루엣) 인스턴스 프로토: 2 tri "ㅅ자" 날개. 날개 끝을 +Y 로 들어 상반각(dihedral)을
// 만든다 → 매트릭스 Y 스케일 요동이 날갯짓(접힘↔펼침)으로 읽힌다. 로컬 +X 정면.
function buildBirdGeo() {
  const g = new THREE.BufferGeometry();
  const V = {
    head: [0.30, 0.0, 0.0], tail: [-0.16, 0.0, 0.0],
    lTip: [-0.20, 0.17, -0.58], rTip: [-0.20, 0.17, 0.58],
  };
  const pos = new Float32Array([
    ...V.head, ...V.tail, ...V.lTip,   // 왼 날개
    ...V.head, ...V.rTip, ...V.tail,   // 오른 날개
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// 새 떼(boids) 공용 팩토리 — 단일 건물 스코프(setupCritters)와 마을 스코프(setupVillageCritters)가
// 홈 앵커·고도밴드·원정 반경만 달리해 재사용한다. rng 소비 순서는 두 호출자가 동일(N→homeAngle→개체×N→tExc).
//   반환 update(dt, t, active): active=false(밤)면 정지. inst.visible 은 호출자가 토글.
//   cx/cz/alt/ax/az: 홈 선회 타원(중심·고도·반축). exCx/exCz: 원정 목표 중심(기본 원점 — 단일 건물 파리티).
//   bandLo/bandHi: 고도 밴드(수관 위·프레임 상단 사이로 무리를 가둠). color/size: 원경 먹점 실루엣.
function makeBoidFlock(group, rng, {
  cx = 2, cz = 12, alt = 17, ax = 4, az = 3,
  bandLo = 14, bandHi = 21, awayR = 122, exCx = 0, exCz = 0,
  sizeLo = 0.5, sizeHi = 0.8, color = 0x2b2e28,
} = {}) {
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  const M = new THREE.Matrix4();
  let scaleBoost = 1;   // 원경(부감) 가시성용 배율 — 호출자가 카메라 고도로 램프(마을 스코프). 근경=1.
  const N = rng.int(12, 16);
  const geo = buildBirdGeo();
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: false });
  const inst = new THREE.InstancedMesh(geo, mat, N);
  inst.name = 'birds';
  inst.frustumCulled = false;   // 원정 시 경계구가 커져 팝 방지
  inst.castShadow = false;
  group.add(inst);

  const pos = [], vel = [], phase = [], size = [];
  let homeAngle = rng.range(0, TAU);
  const homePt = (ang, ta) => _v.set(cx + Math.cos(ang) * ax, alt + 2.5 * Math.sin(ta * 0.11), cz + Math.sin(ang) * az);
  const anchor = homePt(homeAngle, 0).clone();
  const target = anchor.clone();
  for (let i = 0; i < N; i++) {
    const a = rng.range(0, TAU), r = rng.range(3, 9);
    const py = anchor.y + rng.range(-3, 3);
    pos.push(new THREE.Vector3(anchor.x + Math.cos(a) * r, py, anchor.z + Math.sin(a) * r));
    const sp = rng.range(6, 8);
    vel.push(new THREE.Vector3(Math.cos(a) * sp, 0, Math.sin(a) * sp));
    phase.push(rng.range(0, TAU));
    size.push(rng.range(sizeLo, sizeHi));   // 원경 먹점: 작게
  }

  let mode = 'home';
  let tExc = poisson(rng, 55, 40, 90);   // 다음 원정 시각
  let holdMax = 0, hold = 0;

  function update(dt, t, active) {
    if (!active) return;
    homeAngle += 0.085 * dt;
    if (mode === 'home') {
      target.copy(homePt(homeAngle, t));
      if (t >= tExc) {
        mode = 'away';
        const aa = homeAngle + Math.PI + rng.range(-0.6, 0.6); // 반대편으로 → 화면 가로지름
        target.set(exCx + Math.cos(aa) * awayR, 30 + rng.range(-3, 7), exCz + Math.sin(aa) * awayR);
        holdMax = rng.range(5, 9); hold = 0;
      }
    } else {
      if (anchor.distanceTo(target) < 12) {
        hold += dt;
        if (hold > holdMax) { mode = 'home'; tExc = t + poisson(rng, 55, 40, 90); }
      }
    }
    anchor.lerp(target, 1 - Math.exp(-dt / 2.4));

    // boids: 분리·정렬·응집 + 앵커 유인 + 고도 유지.
    const rSep = 3.5, rNb = 12;
    for (let i = 0; i < N; i++) {
      const pi = pos[i], vi = vel[i];
      let sx = 0, sy = 0, sz = 0, ax2 = 0, ay = 0, az2 = 0, cx2 = 0, cy = 0, cz2 = 0, ns = 0, nn = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const pj = pos[j];
        const dx = pi.x - pj.x, dy = pi.y - pj.y, dz = pi.z - pj.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rSep * rSep && d2 > 1e-4) { const inv = 1 / d2; sx += dx * inv; sy += dy * inv; sz += dz * inv; ns++; }
        if (d2 < rNb * rNb) { ax2 += vel[j].x; ay += vel[j].y; az2 += vel[j].z; cx2 += pj.x; cy += pj.y; cz2 += pj.z; nn++; }
      }
      let fx = 0, fy = 0, fz = 0;
      if (ns) { fx += sx * 1.6; fy += sy * 1.6; fz += sz * 1.6; }
      if (nn) {
        fx += (ax2 / nn - vi.x) * 0.7; fy += (ay / nn - vi.y) * 0.7; fz += (az2 / nn - vi.z) * 0.7;    // 정렬
        fx += (cx2 / nn - pi.x) * 0.06; fy += (cy / nn - pi.y) * 0.06; fz += (cz2 / nn - pi.z) * 0.06; // 응집
      }
      fx += (anchor.x - pi.x) * 0.11; fy += (anchor.y - pi.y) * 0.13; fz += (anchor.z - pi.z) * 0.11; // 앵커
      if (pi.y < bandLo) fy += (bandLo - pi.y) * 0.8;        // 나무 위로(지면·수관 회피)
      else if (pi.y > bandHi) fy -= (pi.y - bandHi) * 0.9;   // 천장(프레임 상단 이탈 방지)
      vi.x += fx * dt; vi.y += fy * dt; vi.z += fz * dt;
      const sp = Math.hypot(vi.x, vi.y, vi.z) || 1e-3;
      const cl = Math.min(9, Math.max(6, sp)) / sp;
      vi.x *= cl; vi.y = Math.max(-3, Math.min(3, vi.y * cl)); vi.z *= cl;
      pi.x += vi.x * dt; pi.y += vi.y * dt; pi.z += vi.z * dt;
    }
    for (let i = 0; i < N; i++) {
      const pi = pos[i], vi = vel[i];
      const yaw = -Math.atan2(vi.z, vi.x);
      const flap = 0.35 + 0.95 * (0.5 + 0.5 * Math.sin(t * 11 + phase[i]));
      const k = size[i] * scaleBoost;
      _e.set(0, yaw, 0);
      _q.setFromEuler(_e);
      _s.set(k, k * flap, k);
      M.compose(pi, _q, _s);
      inst.setMatrixAt(i, M);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
  return {
    inst,
    update,
    setScaleBoost(v) { scaleBoost = v; },
    setFade(v) {
      const alpha = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
      mat.transparent = alpha < 0.999;
      mat.opacity = alpha;
      mat.depthWrite = alpha >= 0.999;
    },
  };
}

export function setupCritters(parent, { heightAt = () => 0, layout = {} } = {}) {
  const group = new THREE.Group();
  group.name = 'critters';
  parent.add(group);

  const rng = makeRng(90210);
  // 지상/건물 생물 공용 재질(수목과 같은 flatShading 페이스 룩).
  const solidMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true,
  });

  // 레이아웃 파생 치수.
  const xEave = layout.xEave ?? 9, zEave = layout.zEave ?? 6;
  const eaveMax = Math.max(xEave, zEave);
  const clearance = eaveMax + 9;
  const podTopY = layout.podTopY ?? 0.6;
  const ridgeY = layout.ridgeY ?? 6;
  const ridgeHalf = layout.ridgeHalf ?? 3;
  const eaveEdgeY = layout.eaveEdgeY ?? 5;
  const hw = (layout.W ?? 8) / 2, hd = (layout.D ?? 6) / 2;

  let time = 'day';
  let flockActive = true;    // 밤엔 false → 새 떼 숨김
  let live = 1;              // 밤엔 낮은 활동성(이동 느림·휴식 김)
  let t = 0;

  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3();

  // ==================================================================
  // 1) 새 떼 (boids) — 마을 상공 앵커 주위 선회 + 간헐 원정(능선 너머)
  //   홈 선회: 앞마당 상공(+z, 카메라 방향)에 중심을 둔 완만한 타원 → 기본 프레이밍에 늘 든다.
  //   원정 목표는 원점 중심(exCx/exCz 기본 0). makeBoidFlock 공용 구현.
  // ==================================================================
  const flock = makeBoidFlock(group, rng, {
    cx: 2, cz: 12, alt: 17, ax: 4, az: 3,
    bandLo: 14, bandHi: 21, awayR: 122,
  });

  // 나무 페르치 수집: 건물 가까운 활엽수 상단 수관 지점 몇 곳(까치가 지붕↔나무를 오감).
  // 나무 인스턴스 행렬을 복호화해 위치·스케일을 얻는다(seasons.buildLeaves 와 동일 방식).
  // 수관 꼭대기 높이는 프로토 지오메트리의 바운딩박스 최상단(로컬)에서 정확히 얻어 스케일을 곱한다.
  // 나무 중심(줄기)에서는 수관 표면이 정점 근처라, 정점 살짝 아래(0.98)에 앉혀야 꼭대기에 실루엣으로 선다.
  const leafy = new Set(['maple', 'misc', 'ginkgo', 'cherry']);
  const CROWN_F = 0.93;
  function collectTreePerches() {
    const treeGroup = parent.getObjectByName('trees');
    if (!treeGroup) return [];
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const cand = [];
    for (const inst of treeGroup.children) {
      if (!inst.isInstancedMesh || !leafy.has(inst.name)) continue;         // 활엽수만(수관 무성)
      if (!inst.geometry.boundingBox) inst.geometry.computeBoundingBox();
      const topLocal = inst.geometry.boundingBox.max.y;                     // 수관 정점(로컬)
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m4);
        m4.decompose(p, q, s);
        const d = Math.hypot(p.x, p.z);
        if (d < 20 || d > 50) continue;                     // 건물 겹침·원경 제외
        const sc = (s.x + s.z) * 0.5;
        cand.push({ x: p.x, y: p.y, z: p.z, top: p.y + sc * topLocal * CROWN_F, key: d - (p.z > 0 ? 10 : 0) });
      }
    }
    cand.sort((a, b) => a.key - b.key);                     // 가깝고 앞마당(+z)인 나무 우선
    const picked = [];
    for (const c of cand) {
      if (picked.length >= 3) break;
      if (picked.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 12)) continue;    // 서로 떨어뜨림
      picked.push(c);
    }
    return picked.map((c) => ({
      x: c.x,
      y: c.top,                                             // 상단 수관 돔
      z: c.z,
      yaw: -Math.atan2(-c.z, -c.x),                          // 마당(원점) 쪽을 바라보게
      tree: true,
    }));
  }

  // ==================================================================
  // 2) 까치 1~2 — 지붕 용마루·처마 끝, 그리고 가까운 나무 수관에 앉아 있다가 짧은 호 비행
  // ==================================================================
  const magpies = (() => {
    // 용마루 양 끝(하늘 배경 → 실루엣이 산다)과 처마 끝 모서리에 앉힌다.
    const roofPerches = [
      { x: ridgeHalf, y: ridgeY + 0.18, z: 0, yaw: 0 },
      { x: -ridgeHalf, y: ridgeY + 0.18, z: 0, yaw: Math.PI },
      { x: xEave * 0.92, y: eaveEdgeY + 0.06, z: zEave * 0.88, yaw: -Math.PI / 2 },
      { x: -xEave * 0.92, y: eaveEdgeY + 0.06, z: zEave * 0.88, yaw: -Math.PI / 2 },
    ];
    // 나무 페르치: 건물 가까운 활엽수 수관 위에 몇 곳. 지붕에서 짧은 호를 그리며 오간다.
    // 나무 인스턴스 행렬을 복호화(seasons.buildLeaves 와 같은 방식) → 상단 수관 지점을 뽑는다.
    const treePerches = collectTreePerches();
    const perches = [...roofPerches, ...treePerches];
    // 선택 가중: 용마루·처마(iconic 실루엣)를 더 자주, 나무는 이따금.
    const perchW = perches.map((p) => (p.tree ? 0.55 : 1.0));
    const bodyGeo = buildMagpieBody();
    const tailGeo = buildMagpieTail();
    const list = [];
    const cnt = rng.int(1, 2);
    const used = new Set();
    for (let i = 0; i < cnt; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, solidMat); body.castShadow = true;
      const tail = new THREE.Mesh(tailGeo, solidMat);
      tail.position.set(-0.14, 0.14, 0);
      tail.rotation.z = 0.5;   // 뒤·위로 치켜든 꼬리
      g.add(body, tail);
      g.scale.setScalar(1.8);  // 원경에서도 읽히게 (까치 ~0.45m)
      g.name = 'magpie';
      group.add(g);
      // 첫 마리는 용마루 끝(하늘 배경 → 실루엣이 산다), 둘째는 처마 모서리.
      let pi = i === 0 ? 0 : 2;
      while (used.has(pi)) pi = (pi + 1) % perches.length;
      used.add(pi);
      const p = perches[pi];
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.yaw;
      list.push({ g, tail, perch: pi, yaw: p.yaw, mode: 'perch', tNext: t + poisson(rng, 12, 5, 22), fly: null, ph: rng.range(0, TAU) });
    }

    // 가중 페르치 선택(현재 위치 제외). 지붕이 무거워 나무행은 이따금만 고른다.
    function pickPerch(cur) {
      let sum = 0;
      for (let i = 0; i < perches.length; i++) if (i !== cur) sum += perchW[i];
      let r = rng() * sum;
      for (let i = 0; i < perches.length; i++) {
        if (i === cur) continue;
        if ((r -= perchW[i]) <= 0) return i;
      }
      return (cur + 1) % perches.length;
    }

    function update(dt) {
      for (const m of list) {
        if (m.mode === 'perch') {
          // 꼬리 까딱 + 미세 머리 흔들림
          m.tail.rotation.z = 0.5 + 0.12 * Math.sin(t * 2.2 + m.ph);
          m.g.rotation.y = m.yaw + 0.05 * Math.sin(t * 1.3 + m.ph);
          if (t >= m.tNext && flockActive) {   // 밤엔 이동 자제
            const np = pickPerch(m.perch);
            const a = perches[m.perch], b = perches[np];
            m.fly = { a: new THREE.Vector3(a.x, a.y, a.z), b: new THREE.Vector3(b.x, b.y, b.z), u: 0, dur: 0.9 + Math.hypot(b.x - a.x, b.z - a.z) * 0.05 };
            m.perch = np; m.yaw = b.yaw;
            m.mode = 'fly';
          }
        } else {
          const f = m.fly;
          f.u += dt / f.dur;
          const u = Math.min(1, f.u);
          _v.lerpVectors(f.a, f.b, u);
          _v.y += Math.sin(Math.PI * u) * (1.2 + f.a.distanceTo(f.b) * 0.06); // 호(arc)
          _v.y += 0.05 * Math.sin(t * 26);                                     // 날갯짓 진동
          m.g.position.copy(_v);
          const dir = Math.atan2(f.b.z - f.a.z, f.b.x - f.a.x);
          m.g.rotation.y = -dir;
          m.tail.rotation.z = 0.2;   // 비행 중 꼬리 펴짐
          if (u >= 1) {
            m.mode = 'perch'; m.g.rotation.y = m.yaw;
            m.tNext = t + poisson(rng, 12, 5, 22) / live;
          }
        }
      }
    }
    // 검증 전용: 첫 까치를 첫 나무 페르치로 즉시 스냅하고 그 지점을 반환(스크린샷 조준용).
    function debugToTree() {
      const ti = perches.findIndex((p) => p.tree);
      if (ti < 0 || !list.length) return null;
      const m = list[0], b = perches[ti];
      m.mode = 'perch'; m.perch = ti; m.yaw = b.yaw; m.fly = null;
      m.tNext = t + 999;
      m.g.position.set(b.x, b.y, b.z);
      m.g.rotation.y = b.yaw;
      return { x: b.x, y: b.y, z: b.z };
    }
    return { update, debugToTree };
  })();

  // ==================================================================
  // 3) 개 1 — 마당 가장자리 링을 waypoint 랜덤워크. 이따금 앉아 쉼.
  // ==================================================================
  const dog = (() => {
    const g = new THREE.Group();
    g.name = 'dog';
    const mesh = new THREE.Mesh(buildDog(), solidMat);
    mesh.castShadow = true;
    g.add(mesh);
    group.add(g);

    const inner = eaveMax + 1.6;
    const outer = clearance + 1;
    // 건물 발자국(+여유) 밖 & 마당 안쪽 링에서 waypoint 추출. 앞마당(+z) 선호.
    function pickWaypoint() {
      for (let k = 0; k < 40; k++) {
        const r = rng.range(inner, outer);
        const a = rng.range(0, TAU);
        let x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (rng() < 0.7 && z < 0) z = -z;
        if (Math.abs(x) > xEave + 0.6 || Math.abs(z) > zEave + 0.6) return { x, z };
      }
      return { x: 0, z: outer * 0.8 };
    }

    let wp = pickWaypoint();
    let px = wp.x, pz = wp.z, heading = rng.range(0, TAU);
    let mode = 'walk', rest = 0, sit = 0, gaitPh = 0;
    g.position.set(px, heightAt(px, pz), pz);

    function update(dt) {
      if (mode === 'walk') {
        const dx = wp.x - px, dz = wp.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4) {
          if (rng() < 0.55) { mode = 'rest'; rest = rng.range(5, 15) / live; }
          else wp = pickWaypoint();
        } else {
          const want = Math.atan2(dz, dx);
          // 부드러운 방향 전환(최단각)
          let d = ((want - heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
          heading += Math.max(-1.6 * dt, Math.min(1.6 * dt, d));
          const speed = (0.8 + 0.7 * rng()) * live;
          px += Math.cos(heading) * speed * dt;
          pz += Math.sin(heading) * speed * dt;
          gaitPh += dt * 9 * live;
        }
      } else {
        rest -= dt;
        if (rest <= 0) { mode = 'walk'; wp = pickWaypoint(); }
      }
      // 앉음 보간(휴식=1) — 엉덩이 내리고 코 살짝 듦
      sit += ((mode === 'rest' ? 1 : 0) - sit) * Math.min(1, dt * 3);
      const bounce = mode === 'walk' ? Math.abs(Math.sin(gaitPh)) * 0.05 : 0;
      g.position.set(px, heightAt(px, pz) - sit * 0.12 + bounce, pz);
      g.rotation.set(0, -heading, mode === 'walk' ? Math.sin(gaitPh) * 0.03 : 0);
      mesh.rotation.z = sit * 0.16;   // 앉을 때 뒤로 살짝 기움(코 듦)
    }
    // group(g)은 env·critters 그룹이 원점 identity라 g.position == 월드 위치(라이브 참조).
    return { update, group: g, get state() { return mode === 'rest' ? 'sitting' : 'walking'; } };
  })();

  // ==================================================================
  // 4) 고양이 1 — 기단 위 웅크려 정지(대부분). 꼬리 흔들림. 이따금 사뿐히 이동.
  // ==================================================================
  const cat = (() => {
    const perches = [
      { x: hw * 0.7, y: podTopY + 0.02, z: hd + 0.30, yaw: -Math.PI / 2 },
      { x: -hw * 0.7, y: podTopY + 0.02, z: hd + 0.30, yaw: -Math.PI / 2 },
      { x: hw + 0.30, y: podTopY + 0.02, z: hd * 0.4, yaw: 0 },
    ];
    const g = new THREE.Group();
    g.name = 'cat';
    const body = new THREE.Mesh(buildCatBody(), solidMat); body.castShadow = true;
    const tail = new THREE.Mesh(buildCatTail(), solidMat);
    tail.position.set(-0.24, 0.20, 0);
    tail.rotation.set(0, 0, 0.35);   // 뒤로 낮게 뻗은 꼬리
    g.add(body, tail);
    group.add(g);

    let cur = rng.int(0, perches.length - 1);
    let p = perches[cur];
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.yaw;
    let mode = 'sit', tNext = t + poisson(rng, 26, 14, 44), fly = null, ph = rng.range(0, TAU), yaw = p.yaw;

    function update(dt) {
      // 꼬리는 항상 사인 흔들림(살아있음)
      tail.rotation.y = 0.3 * Math.sin(t * 1.6 + ph);
      tail.rotation.z = 0.35 + 0.08 * Math.sin(t * 2.3 + ph);
      if (mode === 'sit') {
        g.rotation.y = yaw + 0.03 * Math.sin(t * 0.9 + ph);   // 미세 자세
        if (t >= tNext && flockActive) {
          let np = rng.int(0, perches.length - 1);
          if (np === cur) np = (np + 1) % perches.length;
          const a = perches[cur], b = perches[np];
          const dur = 0.8 + Math.hypot(b.x - a.x, b.z - a.z) * 0.09;
          fly = { a: new THREE.Vector3(a.x, a.y, a.z), b: new THREE.Vector3(b.x, b.y, b.z), u: 0, dur };
          cur = np; yaw = b.yaw; mode = 'move';
        }
      } else {
        fly.u += dt / fly.dur;
        const u = Math.min(1, fly.u);
        _v.lerpVectors(fly.a, fly.b, u);
        _v.y += Math.sin(Math.PI * u) * 0.35;   // 낮고 사뿐한 호
        g.position.copy(_v);
        const dir = Math.atan2(fly.b.z - fly.a.z, fly.b.x - fly.a.x);
        g.rotation.y = -dir;
        if (u >= 1) { mode = 'sit'; g.rotation.y = yaw; tNext = t + poisson(rng, 26, 14, 44) / live; }
      }
    }
    return { update };
  })();

  // ---------- 공개 API ----------
  function update(dt) {
    t += dt;
    flock.update(dt, t, flockActive);
    magpies.update(dt);
    dog.update(dt);
    cat.update(dt);
  }
  function setTime(name) {
    time = name;
    flockActive = name !== 'night';
    live = name === 'night' ? 0.45 : 1;
    flock.inst.visible = flockActive;
  }
  function setSeason(_name) { /* 계절 연동 여지(현재 무영향) */ }
  function setEnabled(v) { group.visible = !!v; }

  return {
    update, setTime, setSeason, setEnabled,
    // 오디오 개 짖음 positional 앵커: 개의 라이브 월드 위치(매 프레임 갱신된 참조)·상태('walking'|'sitting').
    get dogAnchor() { return dog.group.position; },
    get dogState() { return dog.state; },
    // 검증 전용: 까치를 나무 페르치로 스냅(스크린샷 조준용). 페르치 없으면 null.
    debugMagpieTree() { return magpies.debugToTree(); },
  };
}

// ============================================================================
// 마을 스코프 소동물 — 개·고양이·까치·새 떼. setupCritters(단일 건물 하나에 종속)와 달리 마을 전역을
//   상대한다. env.group(마을 모드에서 은닉됨)이 아니라 어댑터가 넘긴 마을 루트(parent)에 직접 붙어
//   부감·근접 양쪽에서 보인다. 닭·소(populate buildVillageAnimals)와는 별개 레이어.
//
//   setupVillageCritters(parent, { heightAt, center, radius, scale, parcels, treePerches, seed }) →
//     { update(dt), updateLod(camera, detail, weightAt), setTime, setSeason, setEnabled, setFade, group }
//
//   parcels:     [{ x, z, baseY, W, D, rotY, kind }]  비-히어로 주거 필지(월드좌표·회전).
//   treePerches: [{ x, y, z }]                        당산나무·마당나무 수관 지점(까치 페르치).
//
// 성능: 개·고양이·까치·새 각각 단일 InstancedMesh(부위 애니는 개체별 매트릭스 합성) → 규모 무관 ≤4 드로우콜.
//   개체 상한은 규모별(CAP). 지오·헬퍼(buildDog/buildCat*/buildMagpie*/buildBirdGeo, tint/place/poisson,
//   makeBoidFlock)는 setupCritters 와 전면 공유.
// 결정론: 전용 makeRng(seed)만 소비 — 전역 Math.random 을 건드리지 않아 마을 생성(plan+populate) 해시와
//   독립적이다. 어댑터가 생성 완료(finishVillage) 후 post-gen 레이어로 붙이므로 재현성 불변.
// 스타일: setupCritters 와 동일 로우폴리·flatShading. 좌표 규약 로컬 +X 정면. 밤엔 새 떼 숨김·활동 저하.
export function setupVillageCritters(parent, {
  heightAt = () => 0,
  center = { x: 0, z: 0 },
  radius = 40,
  scale = 'village',
  parcels = [],
  treePerches = [],
  seed = 4242,
} = {}) {
  const group = new THREE.Group();
  group.name = 'village-critters';
  parent.add(group);

  // 각 레이어가 자기 난수열을 소유한다. 지상 LOD sleep 여부가 하늘 새 떼의 다음 원정 방향이나
  // 다른 종의 행동 순서를 바꾸지 않아 같은 seed의 배경 연출이 카메라 경로와 분리된다.
  const placementRng = makeRng((seed ^ 0x504c4143) >>> 0);
  const flockRng = makeRng((seed ^ 0x464c4f43) >>> 0);
  const dogRng = makeRng((seed ^ 0x444f4753) >>> 0);
  const catRng = makeRng((seed ^ 0x43415453) >>> 0);
  const magpieRng = makeRng((seed ^ 0x4d414750) >>> 0);
  const solidMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true,
  });

  let flockActive = true;   // 밤엔 false → 새 떼 숨김·까치/고양이 이동 자제
  let live = 1;             // 밤엔 낮은 활동성(이동 느림·휴식 김)
  let t = 0;
  let enabled = true;
  let fadeWeight = 1;
  let waveWeight = 1;
  const LOD_EPSILON = 0.002;
  // 새 떼는 부감에서도 마을 실루엣의 일부로 유지한다. 지상 개체인 까치는
  // 개·고양이·닭·소와 같은 시선-셀 LOD를 따르며 크기 부스트하지 않는다.
  const BIRD_BOOST = 4.2;
  const lod = {
    birdScale: 1,
    waveWeight: 1,
    ground: { dogs: 1, cats: 1, magpies: 1 },
    active: { dogs: true, cats: true, magpies: true },
    updates: { flock: 0, dogs: 0, cats: 0, magpies: 0 },
    skipped: { groundFrames: 0 },
  };

  const _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _p = new THREE.Vector3(), _sc = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
  const presentationFade = () => presentationWeight(fadeWeight, waveWeight);

  const EMPTY_GROUND_RIG = Object.freeze({
    update() { return 0; }, setDetail() { return 0; }, applyVisibility() {},
    consumeVisibilityChange() { return false; }, count: 0,
  });
  function makeGroundDetailController(inst, states) {
    let maxWeight = 1;
    let visibilityChanged = false;
    function applyVisibility() {
      const next = enabled && presentationFade() > LOD_EPSILON && maxWeight > LOD_EPSILON;
      if (inst.visible !== next) visibilityChanged = true;
      inst.visible = next;
    }
    function setDetail(weightAt, fallback = 1) {
      maxWeight = 0;
      for (const state of states) {
        const value = weightAt ? weightAt(state) : fallback;
        state.detail = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
        maxWeight = Math.max(maxWeight, state.detail);
      }
      applyVisibility();
      return maxWeight;
    }
    function consumeVisibilityChange() {
      const changed = visibilityChanged;
      visibilityChanged = false;
      return changed;
    }
    return { setDetail, applyVisibility, consumeVisibilityChange };
  }
  function collapseHiddenInstance(inst, state, index) {
    if (state.detail > LOD_EPSILON || state.renderedDetail <= LOD_EPSILON) return false;
    _m.makeScale(0, 0, 0);
    inst.setMatrixAt(index, _m);
    state.renderedDetail = 0;
    return true;
  }

  // 규모별 개체 상한(과밀·산만 방지). 전부 인스턴싱이라 드로우콜은 개체수와 무관.
  const CAP = ({
    hamlet:  { dog: 1, cat: 1, magpie: 2 },
    village: { dog: 2, cat: 2, magpie: 3 },
    town:    { dog: 4, cat: 3, magpie: 4 },
    capital: { dog: 5, cat: 4, magpie: 5 },
    hanyang: { dog: 6, cat: 5, magpie: 6 },
  })[scale] || { dog: 2, cat: 2, magpie: 3 };

  // 필지를 자체 rng 로 결정론적 셔플 → 개·고양이·까치 홈으로 분배(겹쳐도 무방, 오프셋이 다름).
  const shuffled = parcels.map((p) => ({ p, k: placementRng() }))
    .sort((a, b) => a.k - b.k).map((o) => o.p);
  const take = (n) => shuffled.slice(0, Math.max(0, Math.min(n, shuffled.length)));
  // 필지 로컬(fx=우, fz=앞/+z) → 월드. parcelMatrix(T·Ry) 규약과 동일(populate 소동물 배치와 일치).
  const toWorld = (p, fx, fz) => {
    const cos = Math.cos(p.rotY), sin = Math.sin(p.rotY);
    return { x: p.x + fx * cos + fz * sin, z: p.z - fx * sin + fz * cos };
  };

  // ==================================================================
  // 1) 새 떼 — 마을 중심 상공 선회 + 간헐 원정(마을 밖으로). 고도·반경은 규모 비례.
  //   고도를 넉넉히(부감 시선각에서 마을 지붕·숲 위 미스트/능선 배경으로 떠 대비가 살게).
  // ==================================================================
  const alt = Math.min(78, Math.max(30, 28 + radius * 0.34));
  const flock = makeBoidFlock(group, flockRng, {
    cx: center.x, cz: center.z, alt, ax: Math.max(6, radius * 0.34), az: Math.max(5, radius * 0.28),
    bandLo: alt - 7, bandHi: alt + 7, awayR: radius * 1.7 + 70, exCx: center.x, exCz: center.z,
    sizeLo: 0.6, sizeHi: 1.05,
  });

  // ==================================================================
  // 2) 개 — 필지 앞마당(대문·길가) 근처를 홈으로 삼아 그 둘레를 랜덤워크. 이따금 앉아 쉼.
  // ==================================================================
  const dogs = (() => {
    const homes = take(CAP.dog).map((p) => {
      const w = toWorld(p, p.W * 0.1, p.D * 0.62);   // 앞마당(+z) 가장자리
      return { x: w.x, z: w.z, baseY: p.baseY };
    });
    const count = homes.length;
    if (!count) return EMPTY_GROUND_RIG;
    const inst = new THREE.InstancedMesh(buildDog(), solidMat, count);
    inst.name = 'v-dogs'; inst.castShadow = true; inst.frustumCulled = false;
    group.add(inst);
    const RAD = 6.5;   // 홈 주변 배회 반경
    const S = homes.map((h) => ({
      hx: h.x, hz: h.z, baseY: h.baseY, px: h.x, pz: h.z, wpx: h.x, wpz: h.z,
      x: h.x, z: h.z,
      heading: dogRng.range(0, TAU), mode: 'walk', rest: 0, sit: 0, gaitPh: dogRng.range(0, TAU),
      detail: 1, renderedDetail: 1,
    }));
    const detail = makeGroundDetailController(inst, S);
    const pickWp = (s) => { const a = dogRng.range(0, TAU), r = dogRng.range(2, RAD); s.wpx = s.hx + Math.cos(a) * r; s.wpz = s.hz + Math.sin(a) * r; };
    for (const s of S) pickWp(s);
    function update(dt) {
      if (!inst.visible) return 0;
      let active = 0, dirty = false;
      for (let i = 0; i < count; i++) {
        const s = S[i];
        if (s.detail <= LOD_EPSILON) {
          dirty = collapseHiddenInstance(inst, s, i) || dirty;
          continue;
        }
        active++;
        if (s.mode === 'walk') {
          const dx = s.wpx - s.px, dz = s.wpz - s.pz, d = Math.hypot(dx, dz);
          if (d < 0.4) { if (dogRng() < 0.5) { s.mode = 'rest'; s.rest = dogRng.range(4, 12) / live; } else pickWp(s); }
          else {
            const want = Math.atan2(dz, dx);
            let da = ((want - s.heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
            s.heading += Math.max(-1.6 * dt, Math.min(1.6 * dt, da));
            const sp = (0.8 + 0.6 * dogRng()) * live;
            s.px += Math.cos(s.heading) * sp * dt; s.pz += Math.sin(s.heading) * sp * dt;
            s.gaitPh += dt * 9 * live;
          }
        } else { s.rest -= dt; if (s.rest <= 0) { s.mode = 'walk'; pickWp(s); } }
        s.sit += ((s.mode === 'rest' ? 1 : 0) - s.sit) * Math.min(1, dt * 3);
        const bounce = s.mode === 'walk' ? Math.abs(Math.sin(s.gaitPh)) * 0.05 : 0;
        const rz = (s.mode === 'walk' ? Math.sin(s.gaitPh) * 0.03 : 0) + s.sit * 0.16;
        s.x = s.px; s.z = s.pz;
        _m.makeTranslation(s.px, s.baseY - s.sit * 0.12 + bounce, s.pz);
        _m.multiply(_m2.makeRotationY(-s.heading));
        if (rz) _m.multiply(_m2.makeRotationZ(rz));
        _m.scale(_sc.setScalar(s.detail));
        inst.setMatrixAt(i, _m);
        s.renderedDetail = s.detail;
        dirty = true;
      }
      if (dirty) inst.instanceMatrix.needsUpdate = true;
      return active;
    }
    return { update, ...detail, count };
  })();

  // ==================================================================
  // 3) 고양이 — 필지 담·기단 모서리에 웅크려 앉음(대부분). 이따금 근처로 사뿐 이동. 꼬리는 정지각으로 구움.
  // ==================================================================
  const cats = (() => {
    const catGeo = mergeGeometries([buildCatBody(), place(buildCatTail(), -0.24, 0.20, 0, { rz: 0.35 })], false);
    const homes = take(CAP.cat).map((p) => {
      const w = toWorld(p, p.W * 0.34, p.D * 0.4);   // 앞마당 한쪽 모서리
      return { x: w.x, z: w.z, baseY: p.baseY, yaw: -p.rotY - Math.PI / 2 };
    });
    const count = homes.length;
    if (!count) {
      catGeo.dispose();
      return EMPTY_GROUND_RIG;
    }
    const inst = new THREE.InstancedMesh(catGeo, solidMat, count);
    inst.name = 'v-cats'; inst.castShadow = true; inst.frustumCulled = false;
    group.add(inst);
    const S = homes.map((h) => {
      const a = catRng.range(0, TAU), r = catRng.range(1.2, 3);
      return {
        baseY: h.baseY, yaw: h.yaw, ph: catRng.range(0, TAU), clock: 0,
        ax: h.x, az: h.z, bx: h.x + Math.cos(a) * r, bz: h.z + Math.sin(a) * r,   // 두 페르치 사이 왕래
        from: 'a', mode: 'sit', u: 0, dur: 1, tNext: poisson(catRng, 26, 14, 44),
        px: h.x, pz: h.z, x: h.x, z: h.z, detail: 1, renderedDetail: 1,
      };
    });
    const detail = makeGroundDetailController(inst, S);
    function update(dt) {
      if (!inst.visible) return 0;
      let active = 0, dirty = false;
      for (let i = 0; i < count; i++) {
        const s = S[i];
        if (s.detail <= LOD_EPSILON) {
          dirty = collapseHiddenInstance(inst, s, i) || dirty;
          continue;
        }
        active++;
        s.clock += dt;
        let px, pz, hop = 0;
        const frx = s.from === 'a' ? s.ax : s.bx, frz = s.from === 'a' ? s.az : s.bz;
        const tox = s.from === 'a' ? s.bx : s.ax, toz = s.from === 'a' ? s.bz : s.az;
        if (s.mode === 'sit') {
          px = frx; pz = frz;
          if (s.clock >= s.tNext && flockActive) { s.mode = 'move'; s.u = 0; s.dur = 0.8 + Math.hypot(tox - frx, toz - frz) * 0.09; }
        } else {
          s.u += dt / s.dur; const u = Math.min(1, s.u);
          px = frx + (tox - frx) * u; pz = frz + (toz - frz) * u;
          hop = Math.sin(Math.PI * u) * 0.3;   // 낮고 사뿐한 호
          if (u >= 1) { s.mode = 'sit'; s.from = s.from === 'a' ? 'b' : 'a'; s.tNext = s.clock + poisson(catRng, 26, 14, 44) / live; }
        }
        s.px = px; s.pz = pz; s.x = px; s.z = pz;
        const yaw = s.yaw + 0.05 * Math.sin(s.clock * 0.9 + s.ph);   // 미세 자세
        _p.set(px, s.baseY + hop, pz);
        _e.set(0, yaw, 0); _q.setFromEuler(_e); _sc.setScalar(s.detail);
        _m.compose(_p, _q, _sc);
        inst.setMatrixAt(i, _m);
        s.renderedDetail = s.detail;
        dirty = true;
      }
      if (dirty) inst.instanceMatrix.needsUpdate = true;
      return active;
    }
    return { update, ...detail, count };
  })();

  // ==================================================================
  // 4) 까치 — 당산나무·마당나무 수관, 그리고 지붕 용마루에 앉아 있다가 근처로 짧은 호 비행. 매우 한국적(까치+당산나무).
  // ==================================================================
  const magpies = (() => {
    // 페르치 후보: 나무 수관 우선(iconic) + 지붕(용마루 추정 높이). 지붕은 나무가 모자랄 때 채운다.
    const perches = [];
    for (const tp of treePerches) perches.push({ x: tp.x, y: tp.y, z: tp.z });
    for (const p of shuffled) perches.push({ x: p.x, y: p.baseY + (p.kind === 'giwa' ? 5.2 : 4.0), z: p.z });
    const count = Math.min(CAP.magpie, perches.length);
    if (!count) return EMPTY_GROUND_RIG;
    const magGeo = mergeGeometries([buildMagpieBody(), place(buildMagpieTail(), -0.14, 0.14, 0, { rz: 0.5 })], false);
    const inst = new THREE.InstancedMesh(magGeo, solidMat, count);
    inst.name = 'v-magpies'; inst.castShadow = true; inst.frustumCulled = false;
    group.add(inst);
    const SCALE = 1.8;         // 원경에서도 읽히게(까치 ~0.45m)
    const MAXHOP = 26;         // 마을을 가로지르는 장거리 비행 방지(근처 페르치만)
    const S = [];
    for (let i = 0; i < count; i++) S.push({
      cur: i, mode: 'perch', yaw: magpieRng.range(0, TAU), ph: magpieRng.range(0, TAU), clock: 0,
      tNext: poisson(magpieRng, 12, 5, 22), fly: null,
      x: perches[i].x, z: perches[i].z, detail: 1, renderedDetail: 1,
    });
    const detail = makeGroundDetailController(inst, S);
    function nearPerch(ci) {
      const a = perches[ci];
      const cand = [];
      for (let i = 0; i < perches.length; i++) { if (i === ci) continue; const b = perches[i]; if (Math.hypot(b.x - a.x, b.z - a.z) < MAXHOP) cand.push(i); }
      return cand.length ? cand[magpieRng.int(0, cand.length - 1)] : -1;
    }
    function update(dt) {
      if (!inst.visible) return 0;
      let active = 0, dirty = false;
      for (let i = 0; i < count; i++) {
        const s = S[i];
        if (s.detail <= LOD_EPSILON) {
          dirty = collapseHiddenInstance(inst, s, i) || dirty;
          continue;
        }
        active++;
        s.clock += dt;
        if (s.mode === 'perch') {
          const p = perches[s.cur];
          const yaw = s.yaw + 0.05 * Math.sin(s.clock * 1.3 + s.ph);
          const bob = 0.02 * Math.sin(s.clock * 2.2 + s.ph);
          _p.set(p.x, p.y + bob, p.z);
          if (s.clock >= s.tNext && flockActive) {
            const np = nearPerch(s.cur);
            if (np < 0) { s.tNext = s.clock + poisson(magpieRng, 12, 5, 22); }
            else {
              const a = perches[s.cur], b = perches[np];
              s.fly = { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, u: 0, dur: 0.9 + Math.hypot(b.x - a.x, b.z - a.z) * 0.05, dir: Math.atan2(b.z - a.z, b.x - a.x) };
              s.cur = np; s.mode = 'fly';
            }
          }
          _e.set(0, yaw, 0);
        } else {
          const f = s.fly; f.u += dt / f.dur; const u = Math.min(1, f.u);
          const px = f.ax + (f.bx - f.ax) * u, pz = f.az + (f.bz - f.az) * u;
          let py = f.ay + (f.by - f.ay) * u + Math.sin(Math.PI * u) * (1.2 + Math.hypot(f.bx - f.ax, f.bz - f.az) * 0.06);
          py += 0.05 * Math.sin(s.clock * 26);   // 날갯짓 진동
          _p.set(px, py, pz);
          _e.set(0, -f.dir, 0);
          if (u >= 1) { s.mode = 'perch'; s.yaw = -f.dir; s.tNext = s.clock + poisson(magpieRng, 12, 5, 22) / live; }
        }
        s.x = _p.x; s.z = _p.z;
        const sc = SCALE * s.detail;
        _q.setFromEuler(_e); _sc.set(sc, sc, sc);
        _m.compose(_p, _q, _sc);
        inst.setMatrixAt(i, _m);
        s.renderedDetail = s.detail;
        dirty = true;
      }
      if (dirty) inst.instanceMatrix.needsUpdate = true;
      return active;
    }
    return { update, ...detail, count };
  })();

  // ---------- 공개 API ----------
  function update(dt) {
    if (!group.visible) return;
    t += dt;
    flock.update(dt, t, flockActive);
    if (flockActive) lod.updates.flock++;
    const magpieActive = magpies.update(dt);
    const dogActive = dogs.update(dt);
    const catActive = cats.update(dt);
    lod.updates.magpies += magpieActive;
    lod.updates.dogs += dogActive;
    lod.updates.cats += catActive;
    if (magpieActive + dogActive + catActive === 0) lod.skipped.groundFrames++;
  }
  function setTime(name) {
    flockActive = name !== 'night';
    live = name === 'night' ? 0.45 : 1;
    flock.inst.visible = flockActive;
  }
  // ── 공통 LOD 소비자 ── 절대 camera.y를 다시 판독하지 않고, 런타임이
  // 시선 지면에 대해 한 번 계산한 detail 상태와 공간 가중치를 주입받는다.
  function updateLod(_camera, detail = null, weightAt = null) {
    const aerial = Math.max(0, Math.min(1, detail?.aerialWeight ?? 0));
    lod.birdScale = 1 + aerial * (BIRD_BOOST - 1);
    flock.setScaleBoost(lod.birdScale);

    const groundAllowed = detail?.groundActive !== false;
    const fallback = groundAllowed ? (detail?.groundWeight ?? 1) : 0;
    const resolver = groundAllowed ? weightAt : null;
    lod.ground.dogs = dogs.setDetail(resolver, fallback);
    lod.ground.cats = cats.setDetail(resolver, fallback);
    lod.ground.magpies = magpies.setDetail(resolver, fallback);
    syncLodActive();
    // 각 컨트롤러의 dirty 플래그를 같은 프레임에 모두 비운다. 논리 OR를 직접 이어 쓰면
    // 앞 컨트롤러가 true인 프레임에 뒤 플래그가 남아 다음 프레임까지 그림자 캐시를 깨운다.
    const dogsChanged = dogs.consumeVisibilityChange();
    const catsChanged = cats.consumeVisibilityChange();
    const magpiesChanged = magpies.consumeVisibilityChange();
    return dogsChanged || catsChanged || magpiesChanged;
  }
  function setSeason(_name) { /* 계절 연동 여지(현재 무영향) */ }
  function syncLodActive() {
    const shown = enabled && presentationFade() > LOD_EPSILON;
    lod.active.dogs = shown && lod.ground.dogs > LOD_EPSILON;
    lod.active.cats = shown && lod.ground.cats > LOD_EPSILON;
    lod.active.magpies = shown && lod.ground.magpies > LOD_EPSILON;
  }
  function applyPresentation() {
    const alpha = presentationFade();
    lod.waveWeight = waveWeight;
    group.visible = enabled && alpha > LOD_EPSILON;
    flock.setFade(alpha);
    solidMat.transparent = alpha < 0.999;
    solidMat.opacity = alpha;
    solidMat.depthWrite = alpha >= 0.999;
    dogs.applyVisibility(); cats.applyVisibility(); magpies.applyVisibility();
    syncLodActive();
  }
  function setEnabled(v) {
    enabled = !!v;
    applyPresentation();
  }
  // 근접 링 크로스페이드(0..1) 파리티(setupAnimals.setFade 와 동형). 공유 재질 하나라 개체 전체 균일 페이드.
  function setFade(v) {
    fadeWeight = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    applyPresentation();
  }
  function setWaveFade(v) {
    waveWeight = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    applyPresentation();
  }

  // Reroll/scale wave는 multiplier만 주입한다. ground child visibility와 flock/day 상태는
  // 이 controller가 계속 소유해 reframe 중 일반 decor fader의 vis0 덮어쓰기를 피한다.
  group.userData.waveFade = { setWeight: setWaveFade };

  return {
    update, updateLod, setTime, setSeason, setEnabled, setFade, setWaveFade, group,
    // 검증용: 개체수(스크린샷 조준·게이트).
    counts: { dogs: dogs.count, cats: cats.count, magpies: magpies.count },
    lod,
  };
}
