// 기와 기왓골 계약 (순수 node, 브라우저 락 없음).
//
// 한식기와는 처마에 수직으로 곧게 오르는 등간격 기왓골(암키와·수키와 동일 across 피치)로
// 잇고, 추녀마루·회첨골에 닿는 골은 그냥 잘라낸다. 골이 물매 방향으로 넓어지거나 좁아지는
// 지붕은 없다.
//
// 그런데 straight-skeleton 지붕면은 로프트다: 처마선(Ae→Be)을 상단 체인으로 잇는다.
// 반사(회첨) 끝을 가진 면은 마루로 갈수록 넓어지고 볼록(추녀) 끝을 가진 면은 좁아지므로,
// iso-파라미터 열(iu/NU)은 물리적으로 평행하지 않다. ㄷ자 가운데 본채의 마당쪽 면이 최악으로,
// 처마선 3.20m 대 상단 체인 투영 9.00m — 등파라미터 기와는 처마로 흐를수록 3.2배 좁아진다.
// 우진각 앞면은 반대로 마루에서 5.6배 뭉친다.
//
// 이 게이트는 그 원인을 픽셀이 아니라 미터로 고정한다:
//   1) 지붕면 UV 의 u 는 세계좌표 across(처마 방향 투영)/ACROSS_PITCH 와 정확히 같아야 한다
//      → 물매 어디서 재도 기왓골 간격이 ACROSS_PITCH.
//   2) 지붕면 UV 의 v 는 마루로부터의 3D 호길이/ALONG_PITCH (세계 미터) — 열마다
//      running-max slopeLen 으로 켜 간격이 흔들리면 안 된다.
//   3) 수키와 롤 across 피치 = 암키와 UV 피치 (위상 일치). 롤은 평면상 직선이고 자기
//      처마변에 수직이며 마루를 넘지 않고 추녀에서 잘려 길이가 흩어져야 한다.
//   4) 어떤 골도 처마 포락 밖으로 나가지 않는다.
//   5) 회첨 튜브 하단은 처마 코너(eaveV) — 벽 코너(poly)가 아니다.
//   6) sugiwaMaterial: TubeGeometry 축에 맞게 map.repeat.x = length/ALONG, y ≈ 1.
// 부채꼴이 실제로 존재하는 fixture(ㄷ자 가운데 면)를 함께 검사해, 게이트가 쉬운 면만
// 보고 통과하는 상황을 막는다.
//
// 픽셀·드로우콜·프로그램 수는 이 게이트의 일이 아니다(브라우저 라운드 소관).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export {
        buildSkeletonRoof,
        GIWA_ACROSS_PITCH,
        GIWA_ALONG_PITCH,
      } from './src/layout/roof-skeleton.js';
      export { sugiwaMaterial } from './src/builder/palette.js';
      export { giwaRoofEnvelope } from './src/layout/giwa-roof-envelope.js';
      export { giwaFootprintPoints } from './src/layout/giwa-footprint.js';
      export { PRESETS } from './src/params.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'giwa-tile-course-contract-entry.js',
  },
  alias: {
    'three/addons/utils/BufferGeometryUtils.js': join(
      ROOT,
      'app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
    ),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(
  built.outputFiles[0].contents,
).toString('base64')}`;
const {
  THREE, buildSkeletonRoof, GIWA_ACROSS_PITCH, GIWA_ALONG_PITCH, sugiwaMaterial,
  giwaRoofEnvelope, giwaFootprintPoints, PRESETS,
} = await import(url);

// 팔레트는 canvas 를 쓰므로(브라우저 전용) 지붕이 실제로 만지는 재질 슬롯만 순수 three 로 채운다.
// 재질의 내용은 이 계약과 무관하다 — 검사 대상은 정점 좌표와 UV 뿐이다.
function stubMaterials() {
  const tex = () => {
    const t = new THREE.Texture();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const std = (color) => new THREE.MeshStandardMaterial({ color });
  const jeoksae = std(0x4a4d52);
  jeoksae.map = tex();
  return {
    tileTex: tex(),
    tileRidge: std(0x55585e),
    eaveBand: std(0x3a3d42),
    wood: std(0xa88c60),
    jeoksae,
    wadang: std(0xcfcabb),
    waguto: std(0xd8d3c6),
  };
}

// 암키와 UV across 와 수키와 롤은 같은 세계좌표 피치(한 켜 = 암키와 1 + 수키와 1).
const TILE_PITCH = GIWA_ACROSS_PITCH;
const ROLL_PITCH = GIWA_ACROSS_PITCH;
const ALONG_PITCH = GIWA_ALONG_PITCH;
const NU = 14, NV = 8;          // 지붕면 로프트 그리드(roof-skeleton 과 공유하는 형상)
const TUBE_TUBULAR = 11, TUBE_RADIAL = 6;
const TUBE_VERTS = (TUBE_TUBULAR + 1) * (TUBE_RADIAL + 1);
// 이보다 짧은 롤은 추녀·회첨에 붙은 자투리 기와로 취급한다(0.12m 처마 내밀기 + 0.037m 법선
// 오프셋이 방향을 지배하는 길이대라, 방향으로 물매를 판정할 수 없다).
const FULL_ROLL_RUN = 0.45;

const P = PRESETS.giwa;
const ROOF_OPTS = {
  eaveOverhang: P.eaveOverhang, riseScale: P.riseScale, profileCurve: P.profileCurve,
  cornerLift: P.cornerLift, planCurve: P.planCurve, ridgeH: P.ridgeH,
  tileBump: 0.7, sugiwaRolls: true, rafters: true, junctionCaps: true,
};
const FIXTURES = [
  { id: 'rect', shape: { planShape: 'single', bays: 3, bay: 2.4, mainHalfW: 4, mainHalfD: 3 }, hero: false },
  { id: 'l', shape: { planShape: 'l', bays: 4, bay: 2.4, mainHalfW: 5, mainHalfD: 3, wingLen: 4.5, wingW: 3 }, hero: false },
  { id: 'u', shape: { planShape: 'u', bays: 5, bay: 2.4, mainHalfW: 6, mainHalfD: 3, wingLen: 5, wingW: 3 }, hero: false },
  // 히어로 종가: 막새·적새·망와까지 켠 heroDetail 경로도 같은 불변식을 지켜야 한다.
  { id: 'u-hero', shape: { planShape: 'u', bays: 5, bay: 2.4, mainHalfW: 6, mainHalfD: 3, wingLen: 5, wingW: 3 }, hero: true },
];

const hypot2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// 처마 다각형(포락) 안쪽 여유. 처마 끝 수막새 마구리는 의도적으로 0.12m 밖으로 내민다.
function signedDistanceOutside(polygon, point) {
  // 볼록/오목 섞인 다각형이라 부호는 winding 이 아니라 최단 변거리 + inside 판정으로 만든다.
  let inside = false, best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < a.x + ((point.z - a.z) / (b.z - a.z)) * (b.x - a.x)) inside = !inside;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1e-12;
    let t = ((point.x - a.x) * dx + (point.z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)));
  }
  return inside ? -best : best;
}

const failures = [];
const notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

let totalFaces = 0, totalRolls = 0;
let sawDivergingFace = false, sawConvergingFace = false;

for (const fixture of FIXTURES) {
  const footprint = giwaFootprintPoints(fixture.shape);
  const envelope = giwaRoofEnvelope(footprint, { eaveY: 3.85, ...ROOF_OPTS });
  const mats = stubMaterials();
  const roof = buildSkeletonRoof(footprint, {
    eaveY: 3.85, mats, ...ROOF_OPTS, heroDetail: fixture.hero,
  });

  // ── 1. 지붕면: UV u = across/피치, UV v = arcFromRidge/피치 ──
  const faces = [];
  roof.traverse((o) => {
    if (o.isMesh && o.material?.userData?.paletteKey === 'tileSurface') faces.push(o);
  });
  check(faces.length >= 4, `${fixture.id}: expected at least 4 tile faces, got ${faces.length}`);
  for (const [index, face] of faces.entries()) {
    const label = `${fixture.id}/face${index}`;
    const pos = face.geometry.getAttribute('position');
    const uv = face.geometry.getAttribute('uv');
    if (pos.count !== (NU + 1) * (NV + 1)) {
      failures.push(`${label}: unexpected loft grid (${pos.count} verts)`);
      continue;
    }
    const vertex = (iu, iv) => {
      const i = iu * (NV + 1) + iv;
      return {
        x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i),
        u: uv.getX(i), v: uv.getY(i),
      };
    };
    // 처마 방향은 기하에서 직접 얻는다(iv=0 행은 직선 Ae→Be).
    const eaveStart = vertex(0, 0), eaveEnd = vertex(NU, 0);
    const width = hypot2(eaveStart, eaveEnd);
    check(width > 0.5, `${label}: degenerate eave line (${width.toFixed(3)}m)`);
    const eDir = { x: (eaveEnd.x - eaveStart.x) / width, z: (eaveEnd.z - eaveStart.z) / width };
    const across = (p) => (p.x - eaveStart.x) * eDir.x + (p.z - eaveStart.z) * eDir.z;

    let worstUv = 0;
    let worstAlong = 0;
    for (let iu = 0; iu <= NU; iu++) {
      // 열 호길이(처마→마루)를 정점에서 재구성.
      const arcs = [0];
      for (let iv = 1; iv <= NV; iv++) {
        const a = vertex(iu, iv - 1), b = vertex(iu, iv);
        arcs.push(arcs[iv - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
      }
      const colLen = arcs[NV];
      for (let iv = 0; iv <= NV; iv++) {
        const p = vertex(iu, iv);
        worstUv = Math.max(worstUv, Math.abs(p.u * TILE_PITCH - across(p)));
        const arcFromRidge = colLen - arcs[iv];
        worstAlong = Math.max(worstAlong, Math.abs(p.v * ALONG_PITCH - arcFromRidge));
      }
    }
    check(
      worstUv <= 1e-4,
      `${label}: tile-u is not world across/${TILE_PITCH} (worst ${worstUv.toFixed(5)}m).`
      + ' 기왓골이 물매 방향으로 넓어지거나 좁아진다.',
    );
    // 호길이 기반 v: 열마다 running-max slopeLen 이 남으면 ~0.3m 이상 어긋난다.
    check(
      worstAlong <= 2e-3,
      `${label}: tile-v is not world arcFromRidge/${ALONG_PITCH}`
      + ` (worst ${worstAlong.toFixed(4)}m). 물매 켜 간격이 열마다 흔들린다.`,
    );

    // 물매를 따라 여러 v 에서 "기와 한 장당 미터"를 직접 재고 ACROSS_PITCH 인지 본다.
    const spans = [];
    for (const iv of [0, 2, 4, 6, NV]) {
      const lo = vertex(0, iv), hi = vertex(NU, iv);
      const du = Math.abs(hi.u - lo.u);
      const da = Math.abs(across(hi) - across(lo));
      spans.push({ iv, du, da });
      if (du <= 1e-6) continue;               // 삼각 face 의 마루 행은 한 점으로 붕괴한다
      const metres = da / du;
      check(
        Math.abs(metres - TILE_PITCH) <= 1e-3,
        `${label}: ${metres.toFixed(4)}m per tile at v-row ${iv} (want ${TILE_PITCH})`,
      );
    }
    // fixture 가 실제로 부채꼴 면을 포함하는지(=어려운 경우를 검사 중인지) 확인.
    const eaveSpan = spans[0].da, ridgeSpan = spans[spans.length - 1].da;
    const fan = eaveSpan > 1e-6 ? ridgeSpan / eaveSpan : 0;
    if (fan >= 2.5) sawDivergingFace = true;
    if (fan <= 0.4) sawConvergingFace = true;
    totalFaces++;
  }

  // ── 2·3. 수키와 롤: 피치 일치 + 평면 직선 + 처마 수직 + 마루 미월경 + 포락 내부 ──
  const rolls = roof.getObjectByName('sugiwa-rolls');
  check(!!rolls, `${fixture.id}: sugiwa-rolls mesh missing`);
  if (rolls) {
    const pos = rolls.geometry.getAttribute('position');
    check(
      pos.count % TUBE_VERTS === 0,
      `${fixture.id}: merged roll buffer ${pos.count} is not a multiple of ${TUBE_VERTS}`,
    );
    const rollCount = Math.floor(pos.count / TUBE_VERTS);
    check(rollCount > 20, `${fixture.id}: only ${rollCount} sugiwa rolls`);
    // 처마변 방향들(축정렬 풋프린트) — 롤은 이들 중 하나에 수직이어야 한다.
    const edgeDirs = footprint.map((a, i) => {
      const b = footprint[(i + 1) % footprint.length];
      const len = hypot2(a, b) || 1;
      return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    });
    // 추녀·회첨 마루선(평면). 둘 다 처마 코너(eaveV)로 내려온다.
    const marudae = [];
    for (const segments of [envelope.skeleton.hips, envelope.skeleton.valleys]) {
      for (const s of segments) {
        const hi = s.a.h >= s.b.h ? s.a : s.b;
        const lo = s.a.h >= s.b.h ? s.b : s.a;
        const ci = envelope.skeleton.poly.findIndex(
          (v) => Math.abs(v.x - lo.x) < 1e-3 && Math.abs(v.z - lo.z) < 1e-3,
        );
        const bottom = ci >= 0 ? envelope.footprint[ci] : lo;
        marudae.push({ a: hi, b: bottom });
      }
    }
    const distanceToMarudae = (p) => {
      let best = Infinity;
      for (const s of marudae) {
        const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
        const len2 = dx * dx + dz * dz || 1e-12;
        let t = ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(p.x - (s.a.x + dx * t), p.z - (s.a.z + dz * t)));
      }
      return best;
    };

    // 회첨 튜브 하단이 처마 코너(eaveV)에 닿는지 — 벽 코너(poly)로 돌아가면 ~2m 오차.
    const valleyMeshes = [];
    roof.traverse((o) => { if (o.isMesh && o.name === 'valley-maru') valleyMeshes.push(o); });
    if (envelope.skeleton.valleys.length) {
      check(
        valleyMeshes.length === envelope.skeleton.valleys.length,
        `${fixture.id}: expected ${envelope.skeleton.valleys.length} valley-maru meshes,`
        + ` got ${valleyMeshes.length}`,
      );
      let worstEaveMiss = 0, worstWallPull = 0;
      for (const mesh of valleyMeshes) {
        const bot = mesh.userData.botPlan;
        check(!!bot, `${fixture.id}: valley-maru missing userData.botPlan`);
        if (!bot) continue;
        let bestEave = Infinity, bestWall = Infinity;
        for (const e of envelope.footprint) {
          bestEave = Math.min(bestEave, Math.hypot(bot.x - e.x, bot.z - e.z));
        }
        for (const w of envelope.skeleton.poly) {
          bestWall = Math.min(bestWall, Math.hypot(bot.x - w.x, bot.z - w.z));
        }
        worstEaveMiss = Math.max(worstEaveMiss, bestEave);
        // 벽보다 처마에 더 가까워야 한다(옛 버그는 wall gap≈0, eave gap≈1.98).
        check(
          bestEave + 0.05 < bestWall,
          `${fixture.id}: valley bottom closer to wall (${bestWall.toFixed(3)}m) than eave`
          + ` (${bestEave.toFixed(3)}m)`,
        );
        worstWallPull = Math.max(worstWallPull, bestWall);
      }
      check(
        worstEaveMiss <= 1e-4,
        `${fixture.id}: valley-maru bottom ${worstEaveMiss.toFixed(4)}m from nearest eave corner`,
      );
      check(
        worstWallPull >= 1.0,
        `${fixture.id}: valley bottoms only ${worstWallPull.toFixed(3)}m from walls`
        + ' — fixture no longer exercises the overhang case',
      );
      notes.push(
        `${fixture.id}: ${valleyMeshes.length} valley-maru bottoms on eave`
        + ` (wall pull ≥ ${worstWallPull.toFixed(2)}m)`,
      );
    }

    const topYs = [];
    let fullRolls = 0, stubRolls = 0;
    let worstAngle = 0, worstOutside = -Infinity, worstAbove = -Infinity;
    let worstStubRun = 0, worstStubOffMarudae = 0;
    // 면별 across 피치: 처마 포락(eave) 변에 투영한 full-roll 처마 끝 이웃 간격.
    // 벽 footprint 가 아니라 eave polygon 을 써야 부채꼴·overhang 면에서도 간격이 보존된다.
    const eavePoly = envelope.footprint;
    const eaveTipsByEdge = eavePoly.map(() => []);
    for (let r = 0; r < rollCount; r++) {
      const base = r * TUBE_VERTS;
      const centre = [];
      for (let i = 0; i <= TUBE_TUBULAR; i++) {
        const a = base + i * (TUBE_RADIAL + 1);
        const b = a + 3;                       // radialSegments 6 → +3 은 대칭점, 중점이 곡선점
        centre.push({
          x: (pos.getX(a) + pos.getX(b)) / 2,
          y: (pos.getY(a) + pos.getY(b)) / 2,
          z: (pos.getZ(a) + pos.getZ(b)) / 2,
        });
      }
      const head = centre[0], tail = centre[centre.length - 1];
      const run = hypot2(head, tail);
      if (run < 1e-3) continue;
      const dir = { x: (tail.x - head.x) / run, z: (tail.z - head.z) / run };
      for (const c of centre) {
        worstOutside = Math.max(worstOutside, signedDistanceOutside(envelope.footprint, c));
        worstAbove = Math.max(worstAbove, c.y - envelope.surfaceTopY);
      }
      topYs.push(tail.y);
      if (run < FULL_ROLL_RUN) {
        // 추녀·회첨에 붙은 살조각: 골 하나가 면 안에 남아 있는 구간이 거의 없는 위치다.
        // 이 조각은 실제로 마루선을 따라 비스듬히 눕는 것이 옳으므로(모서리 자투리 기와)
        // 수직성 검사에서 빼고, 대신 "짧고 마루선 근처에만 있다"를 따로 못박는다.
        stubRolls++;
        worstStubRun = Math.max(worstStubRun, run);
        for (const c of centre) worstStubOffMarudae = Math.max(worstStubOffMarudae, distanceToMarudae(c));
        continue;
      }
      fullRolls++;
      // 처마변 수직성: 어떤 처마변과도 |cos| 이 작아야 한다(= 그 변의 법선 방향으로 달린다).
      let bestDot = 1;
      for (const e of edgeDirs) bestDot = Math.min(bestDot, Math.abs(dir.x * e.x + dir.z * e.z));
      worstAngle = Math.max(worstAngle, bestDot);
      // 처마쪽 끝(낮은 y) → 최근접 eave 변 위 호길이 좌표.
      const tip = head.y <= tail.y ? head : tail;
      let bestEi = 0, bestDist = Infinity, bestAlong = 0;
      for (let ei = 0; ei < eavePoly.length; ei++) {
        const a = eavePoly[ei], b = eavePoly[(ei + 1) % eavePoly.length];
        const edx = b.x - a.x, edz = b.z - a.z;
        const elen2 = edx * edx + edz * edz || 1e-12;
        let t = ((tip.x - a.x) * edx + (tip.z - a.z) * edz) / elen2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(tip.x - (a.x + edx * t), tip.z - (a.z + edz * t));
        if (d < bestDist) {
          bestDist = d;
          bestEi = ei;
          bestAlong = t * Math.sqrt(elen2);
        }
      }
      // tip 은 처마 밖으로 0.12m 내밀려 있으므로 변 위 거리 허용.
      if (bestDist <= 0.35) eaveTipsByEdge[bestEi].push(bestAlong);
    }
    // 관측값: 수정 후 |cos| ≤ 0.053(3.0°), 수정 전(등파라미터 부채꼴) 0.70(44.6°).
    // 남는 몇 도는 롤을 지붕면 위로 0.037m 띄우는 법선 오프셋의 평면 성분이며 기울기가 아니다.
    check(
      worstAngle <= 0.08,
      `${fixture.id}: a full-length roll is not perpendicular to any eave edge (worst |cos| ${worstAngle.toFixed(4)}`
      + ` ≈ ${(90 - (Math.acos(Math.min(1, worstAngle)) * 180) / Math.PI).toFixed(2)}° off).`
      + ' 기왓골이 부채꼴로 방사한다.',
    );
    // 롤 across 피치 = 암키와 피치(위상 일치). aSpan/round(aSpan/P) 양자화로
    // 면마다 ≤ ~P/(2n) 편차가 생기므로 중앙값 허용 1.5cm.
    let pitchSamples = 0, worstPitchDev = 0;
    for (const tips of eaveTipsByEdge) {
      if (tips.length < 3) continue;
      tips.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < tips.length; i++) {
        const g = tips[i] - tips[i - 1];
        // 면 경계·잘린 구간·겹면 tip 이 만드는 비정상 간격 제외.
        if (g > ROLL_PITCH * 0.75 && g < ROLL_PITCH * 1.25) gaps.push(g);
      }
      if (gaps.length < 2) continue;
      gaps.sort((a, b) => a - b);
      const med = gaps[Math.floor(gaps.length / 2)];
      worstPitchDev = Math.max(worstPitchDev, Math.abs(med - ROLL_PITCH));
      pitchSamples += gaps.length;
    }
    check(
      pitchSamples >= 8,
      `${fixture.id}: too few roll-pitch samples (${pitchSamples}) to verify am/su phase match`,
    );
    check(
      worstPitchDev <= 0.015,
      `${fixture.id}: sugiwa roll across pitch deviates ${worstPitchDev.toFixed(3)}m from`
      + ` tile pitch ${ROLL_PITCH}m (am/su phase mismatch)`,
    );
    check(
      stubRolls <= Math.ceil(rollCount * 0.12),
      `${fixture.id}: ${stubRolls}/${rollCount} rolls are corner slivers (max ${Math.ceil(rollCount * 0.12)})`,
    );
    check(
      worstStubRun <= 0.5,
      `${fixture.id}: a corner sliver roll runs ${worstStubRun.toFixed(3)}m — too long to be a sliver`,
    );
    check(
      worstStubOffMarudae <= 0.4,
      `${fixture.id}: a corner sliver roll sits ${worstStubOffMarudae.toFixed(3)}m from any hip/valley line`,
    );
    check(
      worstOutside <= 0.30,
      `${fixture.id}: a roll reaches ${worstOutside.toFixed(3)}m outside the eave envelope`,
    );
    check(
      worstAbove <= 0.12,
      `${fixture.id}: a roll rises ${worstAbove.toFixed(3)}m above the roof surface top (crosses the ridge)`,
    );
    // 추녀에서 실제로 잘리는가: 모든 롤이 마루까지 가면 끝 높이가 한 값으로 뭉친다.
    const spread = Math.max(...topYs) - Math.min(...topYs);
    check(
      spread >= 0.5,
      `${fixture.id}: roll top spread is only ${spread.toFixed(3)}m — rolls are not being cut at the hips`,
    );
    // sugiwaMaterial: TubeGeometry uv.x=length → repeat.x ≈ length/ALONG, repeat.y = 1.
    const map = rolls.material?.map;
    check(!!map, `${fixture.id}: sugiwa-rolls material has no map`);
    if (map) {
      check(
        map.repeat.y <= 1.01,
        `${fixture.id}: sugiwa map.repeat.y=${map.repeat.y} (circumference should be ~1;`
        + ' TubeGeometry uv.x is length — axis was swapped)',
      );
      check(
        map.repeat.x >= 2,
        `${fixture.id}: sugiwa map.repeat.x=${map.repeat.x} too low for slope tiling`,
      );
      // 밀도: length/0.34 였다면 ~maxSlopeLen/0.34 ≈ 20; along 0.9 면 ~7–8. 4× 과밀 회귀 방지.
      check(
        map.repeat.x <= Math.ceil(12 / ALONG_PITCH) + 1,
        `${fixture.id}: sugiwa map.repeat.x=${map.repeat.x} too dense (want ~length/${ALONG_PITCH})`,
      );
    }
    totalRolls += rollCount;
    notes.push(
      `${fixture.id}: ${faces.length} faces, ${rollCount} rolls (${stubRolls} corner slivers),`
      + ` worst off-perpendicular ${(90 - (Math.acos(Math.min(1, worstAngle)) * 180) / Math.PI).toFixed(2)}°,`
      + ` roll top spread ${spread.toFixed(2)}m, roll-pitch dev ${worstPitchDev.toFixed(3)}m,`
      + ` sugiwa.repeat=(${map?.repeat.x},${map?.repeat.y})`,
    );
  }
}

// 순수 재질 계약: TubeGeometry 축(U=길이) + 물매 켜 피치 + matte roughness band (#150 item I).
{
  const tex = new THREE.Texture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const mat = sugiwaMaterial({ tileTex: tex }, 3.6, 0.45);
  check(
    mat.map.repeat.x === Math.round(3.6 / ALONG_PITCH) && mat.map.repeat.y === 1,
    `sugiwaMaterial(3.6m) repeat=(${mat.map.repeat.x},${mat.map.repeat.y})`
    + ` want (${Math.round(3.6 / ALONG_PITCH)},1)`,
  );
  // tile path roughness lives in TILE_LOOK (0.92–0.96). Low roughness sparkles under telephoto.
  check(
    mat.roughness >= 0.92 && mat.roughness <= 0.96,
    `sugiwaMaterial roughness ${mat.roughness} outside matte band [0.92, 0.96]`,
  );
}

check(
  sawDivergingFace,
  'no fixture face fans outward toward the ridge — the ㄷ자 middle range case is not being exercised',
);
check(
  sawConvergingFace,
  'no fixture face converges toward the ridge — the hip-face case is not being exercised',
);

if (failures.length) {
  console.error(`GIWA TILE COURSE: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
assert.ok(totalFaces >= 20 && totalRolls >= 400);
assert.equal(TILE_PITCH, ROLL_PITCH, 'amkiwa UV pitch and sugiwa roll pitch must match');
for (const note of notes) console.log(`  ${note}`);
console.log(
  `GIWA TILE COURSE: PASS (${FIXTURES.length} footprints, ${totalFaces} faces at ${TILE_PITCH}m across`
  + ` / ${ALONG_PITCH}m along, ${totalRolls} rolls at same across pitch,`
  + ` perpendicular to eave, cut at hip/valley, valleys on eave corners)`,
);
