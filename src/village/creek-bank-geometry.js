import * as THREE from 'three';
import { getPropMaterials } from '../props/materials.js';
import { boulderGeometry } from '../props/geom.js';
import { makeRng } from '../rng.js';
import { CREEK_BANK_LIMITS } from './creek-bank-plan.js';

// ── 개천 호안(護岸) 형상 — #20 R4 Phase B ─────────────────────────────────────
// creek-bank-plan.js 의 불변 spec 만 소비한다. 지형·수면·위계를 여기서 다시 풀지 않는다.
//
// 재질 규약: 성벽·석등·돌다리와 같은 props 화강암 재질(getPropMaterials)만 **차용**한다.
//   호안 전용 재질·텍스처·프로그램 패밀리를 만들지 않으며, 이 결과는 populate 의 랜드마크
//   병합(mergeStatic)에 들어가 돌다리가 이미 쓰는 같은 재질로 접힌다 → 드로우콜 +0.
//   그래서 dispose 대상도 지오메트리뿐이다(재질은 모듈 수명 공유물이다).
//
// 형상 위계(계획 주석의 3급 위계 중 아래 두 급):
//   seokchuk = 메쌓기 막돌 호안벽 — 켜별 요철·어긋난 줄눈·갓돌 천단·배수 구멍.
//   natural  = 성 밖 자연석·토안 — 물가에 앉은 자연석 무리(벽 없음).

const FACE_NAME = 'creek-bank-face';
const SHADE_NAME = 'creek-bank-shade';
const NATURAL_NAME = 'creek-bank-natural';

// 삼각형 스트립 누적기. 인덱스 지오메트리 하나로 모아 병합 비용·정점 수를 억제한다.
function makeSink() {
  return { pos: [], idx: [] };
}

function pushQuad(sink, a, b, c, d) {
  const base = sink.pos.length / 3;
  for (const v of [a, b, c, d]) sink.pos.push(v.x, v.y, v.z);
  sink.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function finish(sink, material, name, { castShadow = false } = {}) {
  if (!sink.idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(sink.pos, 3));
  geo.setIndex(sink.idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  // 그림자 캐스터를 늘리지 않는다(한양 드로우콜의 44%가 그림자다 — perf-audit-baseline).
  //   호안은 하도 안쪽을 향한 벽이고 그 사면은 지형 자체가 이미 음영을 준다.
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

// 켜 경계 높이(0..1). 지터로 줄눈이 수평 일직선이 되지 않게 한다 — 메쌓기의 어긋난 줄눈.
function courseFraction(course, courses, jitter, amount) {
  const base = course / courses;
  if (course === 0 || course === courses) return base;
  return Math.min(1, Math.max(0, base + jitter * amount / courses));
}

// 켜별 면 오프셋(하도 쪽 = 음수). 막돌이 들쭉날쭉하게 물려 나온 정도.
function courseOffset(course, courses, jitter, amount) {
  const wave = Math.sin((course * 1.7 + jitter * 2.3) * 1.9);
  return -amount * (0.35 + 0.65 * Math.abs(wave)) * (course === courses - 1 ? 0.45 : 1);
}

function buildRevetmentRun(run, limits, sinks) {
  const L = limits;
  const points = run.points;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    const height = Math.min(p.topY - p.toeY, q.topY - q.toeY);
    if (!(height > 0)) continue;
    const at = (point, offset, y) => ({
      x: point.x + point.nx * offset,
      y,
      z: point.z + point.nz * offset,
    });
    const yOf = (point, fraction) => (point.toeY - L.embed)
      + (point.topY - (point.toeY - L.embed)) * fraction;

    for (let course = 0; course < L.courses; course++) {
      const f0p = courseFraction(course, L.courses, p.jitter, L.courseJitter);
      const f1p = courseFraction(course + 1, L.courses, p.jitter, L.courseJitter);
      const f0q = courseFraction(course, L.courses, q.jitter, L.courseJitter);
      const f1q = courseFraction(course + 1, L.courses, q.jitter, L.courseJitter);
      const offP = courseOffset(course, L.courses, p.jitter, L.faceJitter);
      const offQ = courseOffset(course, L.courses, q.jitter, L.faceJitter);
      // 최하단 켜는 상시 젖는 구간이라 어두운 화강암으로 둔다(사진 판독의 물때 띠).
      const sink = course === 0 ? sinks.shade : sinks.face;
      // 면(하도를 향한 벽면). winding 은 법선이 하도 쪽(-n)을 보도록 잡는다.
      pushQuad(sink,
        at(p, offP, yOf(p, f0p)), at(p, offP, yOf(p, f1p)),
        at(q, offQ, yOf(q, f1q)), at(q, offQ, yOf(q, f0q)));
      // 켜 사이 턱 — 오프셋 차이만큼의 좁은 수평면. 빛을 받아 켜 선이 읽힌다.
      if (course < L.courses - 1) {
        const nextOffP = courseOffset(course + 1, L.courses, p.jitter, L.faceJitter);
        const nextOffQ = courseOffset(course + 1, L.courses, q.jitter, L.faceJitter);
        pushQuad(sinks.face,
          at(p, offP, yOf(p, f1p)), at(q, offQ, yOf(q, f1q)),
          at(q, nextOffQ, yOf(q, f1q)), at(p, nextOffP, yOf(p, f1p)));
      }
    }

    // 갓돌 천단 — 면 상단(내민 립)에서 뒤채움 상단(벤치)까지 덮는 수평면. 이 면이 없으면
    //   호안 뒤 2.5m 사면이 부감에서 도랑으로 읽힌다(뒤채움은 실제로 벽 두께의 일부다).
    const lipP = at(p, -L.copingOverhang, p.topY);
    const lipQ = at(q, -L.copingOverhang, q.topY);
    pushQuad(sinks.face,
      lipP, lipQ,
      { x: q.backX, y: q.topY, z: q.backZ }, { x: p.backX, y: p.topY, z: p.backZ });
    // 립 아래 그림자면(내민 갓돌의 저면).
    pushQuad(sinks.shade,
      lipP, { x: p.x + p.nx * courseOffset(L.courses - 1, L.courses, p.jitter, L.faceJitter), y: p.topY - L.copingDepth * 0.35, z: p.z + p.nz * courseOffset(L.courses - 1, L.courses, p.jitter, L.faceJitter) },
      { x: q.x + q.nx * courseOffset(L.courses - 1, L.courses, q.jitter, L.faceJitter), y: q.topY - L.copingDepth * 0.35, z: q.z + q.nz * courseOffset(L.courses - 1, L.courses, q.jitter, L.faceJitter) },
      lipQ);

    // 배수 구멍 — 계획이 고른 자리에만, 함몰 패널 한 장. 사진 판독의 "중간에 배수 구멍".
    const weepChance = L.sampleSpacing / L.weepSpacing;
    if (p.weep < weepChance && height > L.weepSize * 2.2) {
      const half = L.weepSize * 0.5;
      const midY = p.toeY + Math.min(height * 0.55, L.weepSize * 1.6);
      const tx = (q.x - p.x), tz = (q.z - p.z);
      const tl = Math.hypot(tx, tz) || 1;
      const ux = tx / tl, uz = tz / tl;
      const cx = p.x + ux * Math.min(half + 0.1, tl * 0.5);
      const cz = p.z + uz * Math.min(half + 0.1, tl * 0.5);
      const back = (sx, sy) => ({
        x: cx + ux * sx + p.nx * L.weepRecess,
        y: midY + sy,
        z: cz + uz * sx + p.nz * L.weepRecess,
      });
      pushQuad(sinks.shade, back(-half, -half), back(-half, half), back(half, half), back(half, -half));
    }
  }
}

// 성 밖 물가의 자연석 무리. 벽이 아니라 흩어진 돌이라 계획 표본마다 최대 한 덩이만 앉힌다.
function buildNaturalRun(run, limits, sink, rng) {
  const L = limits;
  const chance = L.sampleSpacing / L.naturalStoneSpacing;
  const template = boulderGeometry(rng, L.naturalStoneRadius, 1, 0.72);
  const source = template.getAttribute('position');
  // boulderGeometry 는 IcosahedronGeometry(PolyhedronGeometry) 라 **비인덱스**다. getIndex() 가 null 인
  //   것을 전제하지 않으면 여기서 던지고, 그 예외가 buildFeatureObjects 를 통째로 무너뜨려 한양이
  //   아예 생성되지 않는다(2026-08-01 실측: worker 0/1 모두 타임아웃, 패치 재질 41개인 부분 씬).
  //   비인덱스면 정점 순서가 곧 삼각형 순서다.
  const index = template.getIndex();
  const triangleCount = index ? index.count : source.count;
  const matrix = new THREE.Matrix4();
  const vector = new THREE.Vector3();
  for (const point of run.points) {
    if (point.weep >= chance) continue;
    const radius = L.naturalStoneRadius * (0.7 + rng() * 0.8);
    // 물가 안쪽(하도 쪽)에 반쯤 잠기게 — 자연석 호안은 물때 선에 걸린다.
    const inset = -(0.4 + rng() * 1.4);
    const y = Math.max(point.waterY - radius * 0.35, point.toeY + radius * 0.3);
    matrix.makeRotationY(rng() * Math.PI * 2);
    matrix.scale(vector.set(radius / L.naturalStoneRadius, radius / L.naturalStoneRadius * 0.8,
      radius / L.naturalStoneRadius));
    matrix.setPosition(point.x + point.nx * inset, y, point.z + point.nz * inset);
    const base = sink.pos.length / 3;
    for (let i = 0; i < source.count; i++) {
      vector.fromBufferAttribute(source, i).applyMatrix4(matrix);
      sink.pos.push(vector.x, vector.y, vector.z);
    }
    for (let i = 0; i < triangleCount; i++) sink.idx.push(base + (index ? index.getX(i) : i));
  }
  template.dispose();
}

// 이 형상이 쓰는 재질 역할. 계약 검사는 props 캔버스 텍스처(=DOM)를 만들지 않고 이 역할만 주입한다
//   (drainage 의 materials 주입과 같은 규약). 기본값은 props 화강암 차용이다.
export const CREEK_BANK_MATERIAL_ROLES = Object.freeze(['face', 'shade', 'natural']);

function resolveMaterials(override) {
  if (!override) {
    const P = getPropMaterials();
    return { face: P.granite, shade: P.graniteDark, natural: P.graniteMoss };
  }
  for (const role of CREEK_BANK_MATERIAL_ROLES) {
    if (!override[role]?.isMaterial) {
      throw new TypeError(`creek bank materials.${role} must be a THREE.Material`);
    }
  }
  return override;
}

/**
 * 호안 계획 → 최대 세 개의 병합 메시(면·음영·자연석). 재질은 전부 **차용**이라 소유권은
 * 지오메트리에만 있다. 빈 계획은 null 을 돌려 아무것도 할당하지 않는다.
 */
export function buildCreekBanks(plan, { materials = null } = {}) {
  if (!plan?.urban || !plan.runs?.length) return null;
  const limits = plan.limits || CREEK_BANK_LIMITS;
  const P = resolveMaterials(materials);
  const sinks = { face: makeSink(), shade: makeSink(), natural: makeSink() };
  const rng = makeRng(0x0cee2b17);
  for (const run of plan.runs) {
    if (run.rank === 'seokchuk') buildRevetmentRun(run, limits, sinks);
    else buildNaturalRun(run, limits, sinks.natural, rng);
  }
  const group = new THREE.Group();
  group.name = 'creek-banks';
  for (const mesh of [
    finish(sinks.face, P.face, FACE_NAME),
    finish(sinks.shade, P.shade, SHADE_NAME),
    finish(sinks.natural, P.natural, NATURAL_NAME),
  ]) if (mesh) group.add(mesh);
  if (!group.children.length) return null;
  group.userData = { kind: 'creek-banks', schema: plan.version };
  return group;
}

export function disposeCreekBanks(root) {
  if (!root) return;
  root.traverse((object) => { if (object.isMesh) object.geometry?.dispose(); });
}
