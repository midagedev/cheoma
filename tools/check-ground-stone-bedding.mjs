// 접지 석재(디딤돌·댓돌·기단 상면) 깊이 계약 — 브라우저 없는 순수 노드 게이트.
//
// 이 게이트가 있는 이유: 근접 z-fighting 신고가 세 라운드를 통과했다. `check:building-clearance`
//   는 "기초가 매입되었는지"와 "레이어당 depth owner 가 하나인지"를 레이어 *이름별로* 세므로,
//   서로 다른 레이어의 상면이 같은 평면에 겹치는 경우(기와 podium-upper/podium-cap, 종가
//   기단 몸통/갑석)와 돌 상면이 마당면과 같은 평면에 놓이는 경우(초가 앞 디딤돌)를 모두
//   통과시켰다. z-fighting 의 **원인은 동일평면성이고 그것은 산술**이므로 여기서 수치로
//   막는다. 실제로 깜빡이는지(깊이 버퍼 정밀도)만 렌더 확인의 몫이다.
//
// 판정 축 3개:
//   1. beddedStone 산술 — 보이는 상면은 표면 기준 authored 높이, 밑동은 지면 아래 FOUNDATION_SINK.
//   2. 접지 석재 매입/돌출 — 이름 'stepping-stone' 인 모든 메시가 표면 아래 FOUNDATION_SINK
//      만큼 묻히고 표면 위로 최소 MIN_STAND_PROUD 만큼 솟는다. 소품 디딤돌 길은 재질별로
//      병합되어 개별 이름이 없으므로 병합 메시 bounds 로 같은 것을 본다.
//   3. 동일평면 상향면 0개 — 그려지는 표면 높이 이상에서, 서로 다른 메시의 **위를 향한**
//      평평한 석재면이 COPLANAR_EPS 안에서 XZ 로 겹치면 실패. 위를 향한 짝만 보는 이유는
//      FrontSide 재질에서 아래를 향한 면은 컬링되어 색상 패스에 나타나지 않기 때문이고,
//      표면 아래를 제외하는 이유는 불투명한 마당면에 가려 보이지 않기 때문이다.
//
// 검출기 자체의 이빨은 회귀 픽스처로 증명한다(REGRESSIONS): 수정 전 좌표로 되돌린 사본에서
//   축 2·3 이 반드시 실패해야 한다. 그래서 이 파일은 "지금 통과한다"가 아니라 "그 결함을
//   잡는다"를 보장한다.
//
// 버린 후보(모두 실측 후 폐기):
//   - 최소 겹침 면적 임계값: 벽 슬래브가 코너에서 교차하는 0.16x0.16 조각과 실제 결함을
//     면적만으로 가를 수 없었다 — 임계값이 팔레트·칸수마다 흔들린다. 대신 재질/이름 계열로
//     이 게이트가 소유하는 표면을 명시했다.
//   - 위에서 내리는 광선의 첫 표면으로 "노출" 판정: **불건전**했다. 처마·지붕이 기단 전체를
//     덮으므로 기단 위 어떤 면도 노출로 판정되지 않아, 실제로 눈에 보이는 기와 기단 결함을
//     놓쳤다(수직 가시성 ≠ 카메라 가시성). 상향 광선 parity 로 "솔리드 내부" 판정도 시도했지만
//     이 코드베이스의 지붕·마당이 열린 셸이라 parity 가 성립하지 않는다.
//   - 높이 밴드: 궁 기단 상면은 1.7m, 담 갑석은 1.3m — 높이로는 두 계통을 가를 수 없다.
//   - polygonOffset 사용 여부 검사: 소스 되읽기(동어반복)이고, 진짜 결함은 오프셋 없이도 생긴다.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT = process.argv.includes('--report');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');

const built = await esbuild.build({
  stdin: {
    contents: `
      export { buildParcel } from './src/layout/parcel.js';
      export { buildBuilding } from './src/builder/index.js';
      export { disposeBuilding } from './src/api/building.js';
      export { buildProp } from './src/props/index.js';
      export { PRESETS } from './src/params.js';
      export {
        COURTYARD_SURFACE_LIFT, FOUNDATION_SINK, beddedStone, sunkPrism,
      } from './src/core/surface-clearance.js';
      export * as THREE from 'three';
    `,
    resolveDir: ROOT,
    sourcefile: 'ground-stone-bedding-entry.js',
  },
  alias: {
    'three/addons': join(ROOT, 'app/node_modules/three/examples/jsm'),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

// Canvas stub: the palettes bake procedural Canvas textures. Geometry never reads them,
// so a no-op 2D context is enough to reach the real production builders in node.
function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'getImageData') {
        return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      }
      if (key === 'measureText') return () => ({ width: 0 });
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      assert.equal(type, '2d', 'a builder requested a non-2D canvas');
      return context;
    },
    toDataURL: () => 'data:,',
  };
  return canvas;
}
globalThis.document = {
  createElement(tag) {
    assert.equal(String(tag).toLowerCase(), 'canvas', 'a builder allocated a non-canvas DOM node');
    return makeCanvas();
  },
};

const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const {
  buildParcel, buildBuilding, disposeBuilding, buildProp, PRESETS,
  COURTYARD_SURFACE_LIFT, FOUNDATION_SINK, beddedStone, sunkPrism,
  THREE,
} = await import(moduleUrl);

const EPS = 1e-6;
// Two faces closer than this in Y cannot be separated by any reasonable depth buffer at
// close range, so treat them as one plane regardless of the sign of the difference.
const COPLANAR_EPS = 1e-3;
// A stone that stands less proud than this reads as a stain in the ground rather than a
// stone, and its top face sits inside the surface plane's depth neighbourhood.
const MIN_STAND_PROUD = 0.03;
const STONE_NAME = 'stepping-stone';
const GROUND_NAME = 'courtyard-ground';
// Scope: ground-contact stone and the platform (기단) it steps onto, at any height. A
// height band cannot separate a 기단 상면 (palace tier tops reach 1.7m) from a wall cap,
// so scope by what the surface *is*.
//
//   - Dressed platform/step stone by palette key, plus every mesh named `podium-*` /
//     `foundation-*` / `stepping-stone` so a locally-built material (the temple 갑석 makes
//     its own light MeshStandardMaterial) cannot slip out of scope.
//   - `fieldstone` is deliberately NOT here: it is the 막돌 담·화방벽 cladding that hugs a
//     wall, owned by `src/village/walls.js` / `src/builder/walls.js` and their wall gates,
//     not a surface anyone steps on. It has its own coplanar corner overlap (the 화방벽
//     bands double-cover each corner at y≈0.91, ~0.2m²); that is reported separately
//     rather than silently fixed from here.
const STONE_FAMILY = new Set([
  'stone', 'stoneDark', 'jeondol',
  'granite', 'graniteDark', 'graniteWarm', 'graniteMoss',
]);
const STONE_NAME_PREFIXES = ['podium-', 'foundation-'];

function testMaterials() {
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1);
  texture.needsUpdate = true;
  const materials = {};
  return new Proxy(materials, {
    get(target, key) {
      if (typeof key === 'symbol') return target[key];
      if (key === 'tileTex') return texture;
      if (!target[key]) {
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture });
        material.userData.role = key === 'door' || key === 'salchang' ? 'opening' : key;
        material.userData.paletteKey = String(key);
        target[key] = material;
      }
      return target[key];
    },
  });
}

function paletteKeyOf(object) {
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  return material?.userData?.paletteKey || material?.name || '';
}

// Is this surface one this gate owns — bedded/platform stone, or the drawn ground itself?
function isStoneSurface(object) {
  const name = object.name || '';
  return STONE_FAMILY.has(paletteKeyOf(object))
    || name === GROUND_NAME
    || name === STONE_NAME
    || STONE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function describe(object) {
  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  const key = material?.userData?.paletteKey || material?.name || material?.type || '?';
  const ancestry = [];
  for (let node = object.parent; node && ancestry.length < 3; node = node.parent) {
    if (node.name) ancestry.push(node.name);
  }
  const owner = ancestry.length ? `${ancestry.join('<')}/` : '';
  return `${owner}${object.name || '(anonymous)'}[${key}/${object.geometry.type}]`;
}

// Every near-horizontal, exactly flat world-space triangle of a subtree.
function flatFaces(root) {
  const out = [];
  root.updateWorldMatrix(true, true);
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  const ab = new THREE.Vector3(); const ac = new THREE.Vector3(); const n = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry?.attributes?.position) return;
    const position = object.geometry.attributes.position;
    const index = object.geometry.index;
    const triangles = index ? index.count : position.count;
    // An InstancedMesh keeps orientation in instanceMatrix, not matrixWorld: reading only
    // matrixWorld would report every instance at the prototype's location.
    const instances = object.isInstancedMesh ? object.count : 1;
    const label = describe(object);
    for (let instance = 0; instance < instances; instance++) {
      if (object.isInstancedMesh) {
        object.getMatrixAt(instance, local);
        world.multiplyMatrices(object.matrixWorld, local);
      } else {
        world.copy(object.matrixWorld);
      }
      // A negative determinant mirrors the winding, so the geometric normal flips.
      const flip = world.determinant() < 0 ? -1 : 1;
      for (let i = 0; i < triangles; i += 3) {
        const i0 = index ? index.getX(i) : i;
        const i1 = index ? index.getX(i + 1) : i + 1;
        const i2 = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(position, i0).applyMatrix4(world);
        b.fromBufferAttribute(position, i1).applyMatrix4(world);
        c.fromBufferAttribute(position, i2).applyMatrix4(world);
        ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
        const length = n.length();
        if (length < 1e-12) continue;
        const ny = (n.y / length) * flip;
        if (Math.abs(ny) < 0.995) continue;
        const y = (a.y + b.y + c.y) / 3;
        if (Math.max(Math.abs(a.y - y), Math.abs(b.y - y), Math.abs(c.y - y)) > 1e-5) continue;
        out.push({
          object,
          label,
          key: `${label}#${object.uuid}#${instance}`,
          y,
          up: ny > 0,
          minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
          minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z),
        });
      }
    }
  });
  return out;
}

// Coplanar up-facing stone pairs at or above the drawn surface.
function coplanarConflicts(root, surfaceY) {
  const faces = flatFaces(root)
    .filter((face) => face.up
      && face.y >= surfaceY - COPLANAR_EPS
      && isStoneSurface(face.object))
    .sort((p, q) => p.y - q.y);
  const found = new Map();
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[j].y - faces[i].y > COPLANAR_EPS) break;
      const f = faces[i]; const g = faces[j];
      if (f.key === g.key) continue;
      const x0 = Math.max(f.minX, g.minX); const x1 = Math.min(f.maxX, g.maxX);
      const z0 = Math.max(f.minZ, g.minZ); const z1 = Math.min(f.maxZ, g.maxZ);
      if (x1 - x0 <= EPS || z1 - z0 <= EPS) continue;
      const id = [f.label, g.label].sort().join('  <->  ');
      const record = found.get(id) || { id, pairs: 0, area: 0, y: f.y, dy: Infinity };
      record.pairs++;
      record.area += (x1 - x0) * (z1 - z0);
      const dy = Math.abs(g.y - f.y);
      if (dy < record.dy) { record.dy = dy; record.y = f.y; }
      found.set(id, record);
    }
  }
  return [...found.values()].sort((p, q) => q.area - p.area);
}

// The props 디딤돌 길 is merged per material by `Kit.build`, so its stones are one mesh
// named after the palette key. Renaming that inside Kit would rename every prop's meshes,
// so the gate names the selector instead and judges the merged bounds.
const MERGED_STONE = (object) => object.name === 'granite';

function groundStones(root, select = (object) => object.name === STONE_NAME) {
  const stones = [];
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (object.isMesh && select(object)) {
      const box = new THREE.Box3().setFromObject(object);
      stones.push({
        label: describe(object),
        min: box.min.y,
        max: box.max.y,
        z: (box.min.z + box.max.z) / 2,
        depth: box.max.z - box.min.z,
      });
    }
  });
  return stones;
}

// ── axis 1: beddedStone arithmetic ────────────────────────────────────────────
{
  const bed = beddedStone(COURTYARD_SURFACE_LIFT, 0.06);
  assert(Math.abs(bed.top - (COURTYARD_SURFACE_LIFT + 0.06)) < EPS,
    `beddedStone no longer measures its top from the surface (${bed.top})`);
  assert(Math.abs(bed.bottom + FOUNDATION_SINK) < EPS,
    `beddedStone stopped burying its base (${bed.bottom})`);
  assert(Math.abs(bed.height - (bed.top - bed.bottom)) < EPS, 'beddedStone height drifted');
  assert(Math.abs(bed.center - (bed.top + bed.bottom) / 2) < EPS, 'beddedStone center drifted');
  assert(Math.abs(bed.bottom - sunkPrism(bed.top).bottom) < EPS,
    'beddedStone diverged from the shared foundation sink');
  assert(FOUNDATION_SINK > MIN_STAND_PROUD,
    'a stone would be buried shallower than it stands proud');
}

// ── fixtures ──────────────────────────────────────────────────────────────────
// Every fixture rises out of the parcel courtyard surface, which is the datum the
// builders now measure a stone's standing height from. The bare props path is placed on
// terrain at site.heightAt, so its surface is y = 0.
const FIXTURES = [
  ['parcel hanok ㅡ', COURTYARD_SURFACE_LIFT, 1,
    () => buildParcel({ style: 'hanok', seed: 20260716, lanterns: false, materials: testMaterials(), roofOpts: { planShape: 'single' } })],
  ['parcel hanok ㄱ', COURTYARD_SURFACE_LIFT, 1,
    () => buildParcel({ style: 'hanok', seed: 20260716, lanterns: false, materials: testMaterials() })],
  ['parcel hanok ㄷ', COURTYARD_SURFACE_LIFT, 1,
    () => buildParcel({ style: 'hanok', seed: 20260716, lanterns: false, materials: testMaterials(), roofOpts: { planShape: 'u' } })],
  ['parcel choga', COURTYARD_SURFACE_LIFT, 1,
    () => buildParcel({ style: 'choga', seed: 20260716, lanterns: false, materials: testMaterials() })],
  ['parcel palace', COURTYARD_SURFACE_LIFT, 0,
    () => buildParcel({ style: 'palace', seed: 20260716, lanterns: false, materials: testMaterials() })],
  ['parcel temple', COURTYARD_SURFACE_LIFT, 0,
    () => buildParcel({ style: 'temple', seed: 20260716, lanterns: false, materials: testMaterials() })],
  ['building choga', COURTYARD_SURFACE_LIFT, 1,
    () => buildBuilding({ ...PRESETS.choga, mats: testMaterials() })],
  ['building giwa ㄱ', COURTYARD_SURFACE_LIFT, 0,
    () => buildBuilding({ ...PRESETS.giwa, mats: testMaterials() })],
  ['building giwa ㄷ', COURTYARD_SURFACE_LIFT, 0,
    () => buildBuilding({ ...PRESETS.giwa, mats: testMaterials(), planShape: 'u', bays: 4 })],
  ['prop stepping-stones', 0, 1, () => buildProp('stepping-stones', { seed: 3 }), MERGED_STONE],
];

// A courtyard/terrain surface must be present: a stone flush with grade is only a defect
// because the ground is drawn at that height too, so the fixture needs that surface.
function withSurface(subtree, surfaceY) {
  const root = new THREE.Group();
  if (!subtree.getObjectByName('courtyard-ground')) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0xcabfa2 }),
    );
    ground.name = 'courtyard-ground';
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = surfaceY;
    root.add(ground);
  }
  root.add(subtree);
  return root;
}

const failures = [];
for (const [name, surfaceY, minStones, make, select] of FIXTURES) {
  const subtree = make();
  const root = withSurface(subtree, surfaceY);
  const stones = groundStones(root, select);
  const conflicts = coplanarConflicts(root, surfaceY);

  if (REPORT) {
    console.log(`\n${name}  (surface y=${surfaceY})`);
    for (const stone of stones) {
      console.log(`  stone ${stone.label} y=${stone.min.toFixed(4)}..${stone.max.toFixed(4)}`
        + ` buried=${(surfaceY - stone.min).toFixed(4)} proud=${(stone.max - surfaceY).toFixed(4)}`
        + ` z=${stone.z.toFixed(3)} zDepth=${stone.depth.toFixed(3)}`);
    }
    if (!stones.length) console.log('  (no named ground stones)');
    for (const conflict of conflicts) {
      console.log(`  CONFLICT y=${conflict.y.toFixed(4)} dy=${conflict.dy.toExponential(2)}`
        + ` pairs=${conflict.pairs} area~${conflict.area.toFixed(3)}m2  ${conflict.id}`);
    }
    if (!conflicts.length) console.log('  no coplanar up-facing stone pair');
  }

  if (stones.length < minStones) {
    failures.push(`${name}: expected at least ${minStones} '${STONE_NAME}' mesh, found ${stones.length}`);
  }
  for (const stone of stones) {
    if (!(stone.min <= surfaceY - FOUNDATION_SINK + EPS)) {
      failures.push(`${name}: ${stone.label} rests on grade instead of being bedded`
        + ` (bottom y=${stone.min.toFixed(6)}, needs <= ${(surfaceY - FOUNDATION_SINK).toFixed(6)})`);
    }
    if (!(stone.max >= surfaceY + MIN_STAND_PROUD - EPS)) {
      failures.push(`${name}: ${stone.label} does not stand proud of the surface`
        + ` (top y=${stone.max.toFixed(6)}, needs >= ${(surfaceY + MIN_STAND_PROUD).toFixed(6)})`);
    }
  }
  for (const conflict of conflicts) {
    failures.push(`${name}: exposed coplanar up-facing stone surfaces at y=${conflict.y.toFixed(6)}`
      + ` (dy=${conflict.dy.toExponential(3)}, ~${conflict.area.toFixed(3)}m2) ${conflict.id}`);
  }
  if (subtree.userData?.layout || subtree.name === 'building') disposeBuilding(subtree);
}

// ── axis 3 teeth: the detector must fail on the pre-fix geometry ──────────────
// Each entry restores one shipped defect on a live fixture and asserts it is reported.
const REGRESSIONS = [
  ['choga front stepping stone flush with the courtyard',
    COURTYARD_SURFACE_LIFT,
    () => buildBuilding({ ...PRESETS.choga, mats: testMaterials() }),
    (root, surfaceY) => {
      // Pre-fix: ddong() measured its height from y = 0, so the 0.06 stone's top landed
      // exactly on the courtyard plane at COURTYARD_SURFACE_LIFT.
      const stones = [];
      root.traverse((o) => { if (o.isMesh && o.name === STONE_NAME) stones.push(o); });
      const front = stones.sort((p, q) => p.position.z - q.position.z).at(-1);
      front.geometry.dispose();
      front.geometry = new THREE.BoxGeometry(0.9, surfaceY, 0.5);
      front.position.y = surfaceY / 2;
    }],
  ['giwa podium body reaching the cap top',
    COURTYARD_SURFACE_LIFT,
    () => buildBuilding({ ...PRESETS.giwa, mats: testMaterials(), planShape: 'u', bays: 4 }),
    (root) => {
      // Pre-fix: podium-upper ended at podH, the same plane as podium-cap's top.
      const upper = root.getObjectByName('podium-upper');
      const cap = root.getObjectByName('podium-cap');
      const upperBox = new THREE.Box3().setFromObject(upper);
      const capBox = new THREE.Box3().setFromObject(cap);
      upper.position.y += capBox.max.y - upperBox.max.y;
    }],
  ['hanok foundation body reaching the gapseok top',
    COURTYARD_SURFACE_LIFT,
    () => buildParcel({ style: 'hanok', seed: 20260716, lanterns: false, materials: testMaterials() }),
    (root) => {
      const body = root.getObjectByName('foundation-body');
      const gapseok = root.getObjectByName('foundation-gapseok');
      const bodyBox = new THREE.Box3().setFromObject(body);
      const gapseokBox = new THREE.Box3().setFromObject(gapseok);
      body.position.y += gapseokBox.max.y - bodyBox.max.y;
      // The shipped defect was visible because the dark 기단 상면 cap did not cover the
      // whole ring; keep the cap where it is and only restore the body's reach.
    }],
  ['props stepping stones resting on the terrain surface',
    0,
    () => buildProp('stepping-stones', { seed: 3 }),
    (root) => {
      const granite = [];
      root.traverse((o) => { if (o.isMesh && MERGED_STONE(o)) granite.push(o); });
      for (const mesh of granite) {
        const box = new THREE.Box3().setFromObject(mesh);
        mesh.position.y -= box.min.y; // back to bottom-on-grade
      }
    },
    MERGED_STONE],
  ['palace podium tier reaching the 갑석 top',
    COURTYARD_SURFACE_LIFT,
    () => buildBuilding({ ...PRESETS.korea, mats: testMaterials() }),
    (root) => {
      // Pre-fix: every tier ended at (t+1)*podiumTierH, the same plane as its cap's top.
      for (let t = 0; ; t++) {
        const tier = root.getObjectByName(`podium-tier-${t}`);
        const cap = root.getObjectByName(`podium-cap-${t}`);
        if (!tier || !cap) break;
        const tierBox = new THREE.Box3().setFromObject(tier);
        const capBox = new THREE.Box3().setFromObject(cap);
        tier.position.y += capBox.max.y - tierBox.max.y;
      }
    }],
  ['parcel stepping-stone path crushed below its own footprint',
    COURTYARD_SURFACE_LIFT,
    () => buildParcel({ style: 'hanok', seed: 20260716, lanterns: false, materials: testMaterials() }),
    (root) => {
      // Pre-fix: `max(3, round(span / 1.4))` forced three stones into the choga's 0.9m
      // yard strip, so the 0.45m pitch was under the 1.008m stone footprint and every top
      // face overlapped its neighbour. Reproduce that pitch on a parcel that has a path.
      const stones = [];
      root.traverse((o) => {
        if (o.isMesh && o.name === STONE_NAME && o.geometry.type === 'CylinderGeometry') stones.push(o);
      });
      const anchor = stones[0];
      if (!anchor) throw new Error('the hanok parcel lost its stepping-stone path');
      stones.forEach((stone, i) => { stone.position.z = anchor.position.z - i * 0.45; });
    }],
];

for (const [label, surfaceY, make, regress, select] of REGRESSIONS) {
  const subtree = make();
  const root = withSurface(subtree, surfaceY);
  regress(root, surfaceY);
  const stones = groundStones(root, select);
  const conflicts = coplanarConflicts(root, surfaceY);
  const bedding = stones.filter((stone) => !(stone.min <= surfaceY - FOUNDATION_SINK + EPS)
    || !(stone.max >= surfaceY + MIN_STAND_PROUD - EPS));
  if (REPORT) {
    console.log(`\nREGRESSION ${label}`);
    console.log(`  bedding failures=${bedding.length} conflicts=${conflicts.length}`);
    for (const conflict of conflicts) {
      console.log(`    y=${conflict.y.toFixed(4)} dy=${conflict.dy.toExponential(2)}`
        + ` area~${conflict.area.toFixed(3)}m2 ${conflict.id}`);
    }
  }
  assert(bedding.length > 0 || conflicts.length > 0,
    `the detector no longer catches the shipped defect: ${label}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  throw new Error(`${failures.length} ground-stone bedding violation(s)`);
}

console.log(
  `ground-stone bedding OK — ${FIXTURES.length} fixtures, no coplanar up-facing stone surface`
  + ` at or above the drawn surface; sink=${FOUNDATION_SINK}m,`
  + ` min proud=${MIN_STAND_PROUD}m; ${REGRESSIONS.length} regression fixtures still caught`,
);
