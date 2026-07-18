// 마을 배치용 2D 기하 헬퍼. 좌표는 월드 (x, z) 평면 — y(고도)는 site.heightAt 이 담당.
// 여기 함수들은 순수(부수효과 없음)라 plan.js 가 결정론적 데이터를 만들 때 안전하게 쓴다.
//
// 좌표 규약(코드베이스 공통): +z = 남(南, 앞·진입·마당·물), -z = 북(北, 뒤·배산·주산).
//   집은 자기 로컬 +z 를 도로 쪽으로 돌려 앉는다(대문·마당이 도로를 향함).

export const V = (x, z) => ({ x, z });
export const add = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
export const mul = (a, s) => ({ x: a.x * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.z * b.z;
export const len = (a) => Math.hypot(a.x, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, z: a.z / l }; };
// 좌측 법선(진행방향 기준 왼쪽). CCW 폴리곤에서 안쪽을 향한다.
export const perpL = (a) => ({ x: a.z, z: -a.x });
export const perpR = (a) => ({ x: -a.z, z: a.x });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
// 로컬 +z 를 월드 방향 dir 로 돌리는 회전각(three rotation.y). local(0,0,1) → (sin,·,cos).
export const facingY = (dir) => Math.atan2(dir.x, dir.z);

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;                       // CCW 양수
}

export function polyCentroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cr = p.x * q.z - q.x * p.z;
    cx += (p.x + q.x) * cr; cz += (p.z + q.z) * cr; a += cr;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {           // 퇴화 폴리곤: 산술 평균
    const n = poly.length;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, z: poly.reduce((s, p) => s + p.z, 0) / n };
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

export function ensureCCW(poly) {
  return polyArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

// 다각형을 바깥으로 d 만큼 마이터 오프셋(볼록/반사 모두). hanok.js 의 offsetPoly 와 동일 감각.
// d<0 이면 안쪽 축소. CCW 입력 가정.
export function offsetPoly(poly, d) {
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const e1 = norm(sub(cur, prev)), e2 = norm(sub(next, cur));
    // CCW 외측 법선 = (e.z, -e.x)
    const o1 = { x: e1.z, z: -e1.x }, o2 = { x: e2.z, z: -e2.x };
    const bis = norm({ x: o1.x + o2.x, z: o1.z + o2.z });
    const cosH = Math.max(0.4, bis.x * o1.x + bis.z * o1.z);
    out.push({ x: cur.x + bis.x * d / cosH, z: cur.z + bis.z * d / cosH });
  }
  return out;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.z > pt.z) !== (b.z > pt.z)) &&
        (pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x)) inside = !inside;
  }
  return inside;
}

// 점 p 에서 선분 ab 까지의 최단거리와 투영 파라미터 t(0..1).
export function distToSeg(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-9) return { d: dist(p, a), t: 0, pt: a };
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + abx * t, z: a.z + abz * t };
  return { d: dist(p, q), t, pt: q };
}

// 폴리라인(여러 점) 까지의 최단거리 + 가장 가까운 점 + 그 지점의 접선.
export function distToPolyline(p, pts) {
  let best = { d: Infinity, pt: pts[0], tan: { x: 1, z: 0 }, seg: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distToSeg(p, pts[i], pts[i + 1]);
    if (r.d < best.d) best = { d: r.d, pt: r.pt, tan: norm(sub(pts[i + 1], pts[i])), seg: i, t: r.t };
  }
  return best;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i], pts[i + 1]);
  return L;
}

// 폴리라인을 등간격으로 재샘플 → 각 샘플의 {pt, tan(접선), s(누적거리)}.
export function resample(pts, spacing) {
  const out = [];
  if (pts.length < 2) return out;
  let acc = 0, carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = dist(a, b);
    if (seg < 1e-6) continue;
    const tan = norm(sub(b, a));
    let d = carry;
    while (d <= seg) {
      out.push({ pt: lerp(a, b, d / seg), tan, s: acc + d });
      d += spacing;
    }
    carry = d - seg;
    acc += seg;
  }
  return out;
}

// 두 선분 교차점(있으면 {x,z,t,u}, 없으면 null). t,u ∈ [0,1].
export function segIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const rxs = r.x * s.z - r.z * s.x;
  if (Math.abs(rxs) < 1e-9) return null;
  const qp = sub(c, a);
  const t = (qp.x * s.z - qp.z * s.x) / rxs;
  const u = (qp.x * r.z - qp.z * r.x) / rxs;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t, t, u };
}

export function boundsOfPts(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ };
}

// 축 정렬 사각 필지: 도로변 한 점(base)에서 도로 접선(tan)·안쪽 법선(inward)으로 폭·깊이 사각.
//   frontHalf: 도로변 절반폭, depth: 도로 반대쪽 깊이, setback: 도로에서 띄우는 여백.
// 반환 폴리곤은 CCW. 집의 로컬 +z(정면)는 -inward(=도로쪽)를 향한다.
export function frontageParcel(base, tan, inward, frontHalf, depth, setback = 0) {
  const t = norm(tan), n = norm(inward);
  const c = add(base, mul(n, setback));          // 도로에서 setback 만큼 안쪽 기준선
  const bl = add(c, mul(t, -frontHalf));
  const br = add(c, mul(t, frontHalf));
  const tr = add(br, mul(n, depth));
  const tl = add(bl, mul(n, depth));
  return [bl, br, tr, tl];                        // 도로변(앞) → 안쪽(뒤), CCW
}

// 두 볼록(축·회전 무관) 폴리곤이 겹치는지: 분리축(SAT) 근사. 필지 충돌 판정용.
export function polysOverlap(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const axis = norm(perpL(sub(b, a)));
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of A) { const d = dot(p, axis); if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const p of B) { const d = dot(p, axis); if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA < minB || maxB < minA) return false;   // 분리축 발견 → 안 겹침
    }
  }
  return true;
}
