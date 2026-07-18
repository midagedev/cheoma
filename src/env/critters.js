import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  // ==================================================================
  const flock = (() => {
    const N = rng.int(12, 16);
    const geo = buildBirdGeo();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2b2e28, side: THREE.DoubleSide, fog: false,
    });
    const inst = new THREE.InstancedMesh(geo, mat, N);
    inst.name = 'birds';
    inst.frustumCulled = false;   // 원정 시 경계구가 커져 팝 방지
    inst.castShadow = false;
    group.add(inst);

    const pos = [], vel = [], phase = [], size = [];
    let homeAngle = rng.range(0, TAU);
    // 홈 선회: 앞마당 상공(+z, 카메라 방향)에 중심을 둔 완만한 타원 → 기본 프레이밍에 늘 든다.
    const homeCx = 2, homeCz = 12, homeAx = 4, homeAz = 3, homeAlt0 = 17;
    const homePt = (ang, ta) => _v.set(homeCx + Math.cos(ang) * homeAx, homeAlt0 + 2.5 * Math.sin(ta * 0.11), homeCz + Math.sin(ang) * homeAz);
    const anchor = homePt(homeAngle, 0).clone();
    const target = anchor.clone();
    for (let i = 0; i < N; i++) {
      const a = rng.range(0, TAU), r = rng.range(3, 9);
      pos.push(new THREE.Vector3(anchor.x + Math.cos(a) * r, anchor.y + rng.range(-3, 3), anchor.z + Math.sin(a) * r));
      const sp = rng.range(6, 8);
      vel.push(new THREE.Vector3(Math.cos(a) * sp, 0, Math.sin(a) * sp));
      phase.push(rng.range(0, TAU));
      size.push(rng.range(0.5, 0.8));   // 원경 먹점: 작게
    }

    let mode = 'home';
    let tExc = poisson(rng, 55, 40, 90);   // 다음 원정 시각
    const awayR = 122;
    let holdMax = 0, hold = 0;

    function update(dt) {
      if (!flockActive) return;
      // 앵커 선회 + 원정 상태기계
      homeAngle += 0.085 * dt;
      if (mode === 'home') {
        target.copy(homePt(homeAngle, t));
        if (t >= tExc) {
          mode = 'away';
          const aa = homeAngle + Math.PI + rng.range(-0.6, 0.6); // 반대편으로 → 화면 가로지름
          target.set(Math.cos(aa) * awayR, 30 + rng.range(-3, 7), Math.sin(aa) * awayR);
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
      // 무리가 한 덩어리로 뭉쳐 프레임에 머물되, 개체 간 간격은 유지 → 흩뿌린 먹점 무리.
      const rSep = 3.5, rNb = 12;
      for (let i = 0; i < N; i++) {
        const pi = pos[i], vi = vel[i];
        let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, cx = 0, cy = 0, cz = 0, ns = 0, nn = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const pj = pos[j];
          const dx = pi.x - pj.x, dy = pi.y - pj.y, dz = pi.z - pj.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < rSep * rSep && d2 > 1e-4) { const inv = 1 / d2; sx += dx * inv; sy += dy * inv; sz += dz * inv; ns++; }
          if (d2 < rNb * rNb) { ax += vel[j].x; ay += vel[j].y; az += vel[j].z; cx += pj.x; cy += pj.y; cz += pj.z; nn++; }
        }
        // 가속도 누적
        let fx = 0, fy = 0, fz = 0;
        if (ns) { fx += sx * 1.6; fy += sy * 1.6; fz += sz * 1.6; }
        if (nn) {
          fx += (ax / nn - vi.x) * 0.7; fy += (ay / nn - vi.y) * 0.7; fz += (az / nn - vi.z) * 0.7;    // 정렬
          fx += (cx / nn - pi.x) * 0.06; fy += (cy / nn - pi.y) * 0.06; fz += (cz / nn - pi.z) * 0.06; // 응집
        }
        fx += (anchor.x - pi.x) * 0.11; fy += (anchor.y - pi.y) * 0.13; fz += (anchor.z - pi.z) * 0.11; // 앵커
        if (pi.y < 14) fy += (14 - pi.y) * 0.8;        // 나무 위로(지면·수관 회피)
        else if (pi.y > 21) fy -= (pi.y - 21) * 0.9;   // 천장(프레임 상단 이탈 방지)
        vi.x += fx * dt; vi.y += fy * dt; vi.z += fz * dt;
        // 속도 클램프(순항 6~9)
        const sp = Math.hypot(vi.x, vi.y, vi.z) || 1e-3;
        const cl = Math.min(9, Math.max(6, sp)) / sp;
        vi.x *= cl; vi.y = Math.max(-3, Math.min(3, vi.y * cl)); vi.z *= cl;
        pi.x += vi.x * dt; pi.y += vi.y * dt; pi.z += vi.z * dt;
      }
      // 매트릭스: yaw=진행방향, Y 스케일 요동=날갯짓
      for (let i = 0; i < N; i++) {
        const pi = pos[i], vi = vel[i];
        const yaw = -Math.atan2(vi.z, vi.x);
        const flap = 0.35 + 0.95 * (0.5 + 0.5 * Math.sin(t * 11 + phase[i]));
        _e.set(0, yaw, 0);
        _q.setFromEuler(_e);
        _s.set(size[i], size[i] * flap, size[i]);
        M.compose(pi, _q, _s);
        inst.setMatrixAt(i, M);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
    const M = new THREE.Matrix4();
    return { inst, update };
  })();

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
    flock.update(dt);
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
