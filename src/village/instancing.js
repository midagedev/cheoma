import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as G from './geom.js';
import { toneOf } from './variants.js';

// 부위(role)별 톤 선택(#55): parcel 의 부위별 곱틴트(roofTone/wallTone/woodTone/stoneTone)에서 고른다.
//   미지정(레거시 parcel·부위 톤 없음)이면 단일 톤(toneOf(toneIdx))로 하위호환. role 없음(개구부 등)=중립.
const NEUTRAL = [1, 1, 1];
function roleTone(kind, parcel, role) {
  const rt = role === 'roof' ? parcel.roofTone
    : role === 'wall' ? parcel.wallTone
    : role === 'wood' ? parcel.woodTone
    : role === 'stone' ? parcel.stoneTone
    : null;
  if (rt) return rt;
  if (role) return NEUTRAL;                         // 태그는 있으나 parcel 톤 미설정 → 중립
  // 역할 태그 자체가 없는 재질: 레거시 단일 톤 유지(구 parcel) 또는 중립.
  return parcel.roofTone ? NEUTRAL : toneOf(kind, parcel.toneIdx || 0);
}

// 마을 성능 코어 — 드로우콜 붕괴 전략.
//   현 populate 는 집마다 프로토타입을 clone(true) 해 배치 → capital 68호 = 8,700+ 드로우콜.
//   집 본체는 프로토(giwa/choga) 1벌과 완전 동일(배치 변환만 다름)이므로:
//     ① 정규 주택 → 재질별 InstancedMesh (호수 무관 상수 드로우콜 + 지오메트리 메모리 1벌)
//     ② 담·도로·논·랜드마크(종가·궁·절·정자 등 유일 지오) → 재질별 정적 병합
//   두 경로 모두 드로우콜을 "재질 수" 규모로 눌러 CPU 병목을 제거한다(레스터 삼각형 수는 동일).
//
// 픽킹·편집은 인스턴스 매트릭스 은닉(hide)로 개별성 유지 — 프록시 레이캐스트는 adapter.js.

const M4 = () => new THREE.Matrix4();
// 배치 회전 = 정면(frontDir) + yaw 지터(±수도). 집·담·프록시가 모두 같은 각으로 앉게 공유.
export function parcelRotY(parcel) { return G.facingY(parcel.frontDir) + (parcel.yaw || 0); }
// 집 본체 배치 변환: T(중심,지면) · Ry(정면+yaw) · T(0,0,back) · S(변주 스케일). placeParcel 과 픽셀 동일.
//   S 는 마지막(로컬 지오 스케일) — back 오프셋은 스케일 영향 없음.
export function houseMatrix(parcel) {
  const back = -parcel.plotD / 2 + (parcel.kind === 'giwa' ? 5.2 : 3.4);
  const t1 = M4().makeTranslation(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  const r = M4().makeRotationY(parcelRotY(parcel));
  const t2 = M4().makeTranslation(0, 0, back);
  const s = M4().makeScale(parcel.sx || 1, parcel.sy || 1, parcel.sz || 1);
  return t1.multiply(r).multiply(t2).multiply(s);
}
// 필지 그룹(담·마당) 배치 변환: T(중심,지면) · Ry(정면+yaw). 담은 필지 치수에 맞으므로 스케일 제외.
export function parcelMatrix(parcel) {
  const t1 = M4().makeTranslation(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  const r = M4().makeRotationY(parcelRotY(parcel));
  return t1.multiply(r);
}

// 지오메트리를 병합 가능한 균일 레이아웃으로 정규화: non-indexed + position/normal/uv(+color).
// keepColor 는 vertexColors 재질일 때만(그 외 color 는 렌더에 안 쓰이므로 제거해 병합 충돌 방지).
function normalizeGeo(src, worldMatrix, keepColor) {
  let g = src.index ? src.toNonIndexed() : src.clone();
  if (src.index) g = g.clone();            // toNonIndexed 는 새 지오지만 방어적으로 clone
  g.applyMatrix4(worldMatrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (keepColor && !g.attributes.color) {
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  }
  // 병합 충돌 원인이 되는 여분 속성 제거(uv2·tangent·skinning 등, color 는 조건부)
  for (const key of Object.keys(g.attributes)) {
    if (key === 'position' || key === 'normal' || key === 'uv') continue;
    if (key === 'color' && keepColor) continue;
    g.deleteAttribute(key);
  }
  g.morphAttributes = {};
  return g;
}

// 비인덱스 지오의 삼각 와인딩 반전(정점 1↔2 스왑) — 미러(음determinant)로 뒤집힌 앞면 복원.
function reverseWinding(g) {
  for (const key of Object.keys(g.attributes)) {
    const a = g.attributes[key], it = a.itemSize, arr = a.array;
    for (let t = 0; t + 2 < a.count; t += 3) {
      const i1 = (t + 1) * it, i2 = (t + 2) * it;
      for (let k = 0; k < it; k++) { const tmp = arr[i1 + k]; arr[i1 + k] = arr[i2 + k]; arr[i2 + k] = tmp; }
    }
    a.needsUpdate = true;
  }
}

// decomp(재질별 프로토로컬 지오)를 X-미러 사본으로. 재질 refs 재사용(텍스처 증분 0) — ㄱ자 방향 플립.
export function mirrorDecomp(decomp) {
  return decomp.map(({ material, geometry, castShadow, receiveShadow }) => {
    const g = geometry.clone();
    const pos = g.attributes.position.array; for (let i = 0; i < pos.length; i += 3) pos[i] = -pos[i];
    g.attributes.position.needsUpdate = true;
    if (g.attributes.normal) { const nr = g.attributes.normal.array; for (let i = 0; i < nr.length; i += 3) nr[i] = -nr[i]; g.attributes.normal.needsUpdate = true; }
    reverseWinding(g);   // 반사로 뒤집힌 와인딩 복원(앞면 유지)
    return { material, geometry: g, castShadow, receiveShadow };
  });
}

// 변주 decomp 가 canon 과 재질 역할·순서가 같으면(빌더 결정론 → 동일 순서) 재질 refs 를 canon 으로 통일.
//   → 같은 kind 의 여러 평면 변주가 재질셋 1벌만 써 텍스처·재질 수를 고정(드로우콜은 변주×재질).
//   keepOwn(material): true 인 변주 재질은 통일에서 제외(변주별 고유 유지) — 예: 이엉 상태(thatchAge)별 thatch.
export function shareMaterials(canon, variant, keepOwn = null) {
  if (!canon || canon.length !== variant.length) return variant;   // 역할 불일치 → 변주 자체 재질 유지
  return variant.map((e, i) => (keepOwn && keepOwn(e.material)) ? e : { ...e, material: canon[i].material });
}

// root(프로토 또는 이미 월드배치된 객체)를 재질별 병합 지오메트리로 분해.
//   preMatrix: root 로컬을 어떤 기준으로 구울지(프로토는 항등 → 프로토로컬 유지).
//   opts.trackSrc(#148): true 면 재질별 병합 지오 안에서 소스별(o/조상 userData.__mergeSrc) 정점
//     레인지를 함께 반환(srcRanges: Map<srcId,{start,count}> — 정점 단위). 병합 담의 필지별 은닉용.
//     traverse 는 깊이우선(root→o0 서브트리→o1…)이라 재질 리스트 내 같은 src 기여가 연속 → 단일 레인지.
// 반환: [{ material, geometry, castShadow, receiveShadow, srcRanges? }]
export function decomposeByMaterial(root, preMatrix = null, opts = {}) {
  const trackSrc = !!opts.trackSrc;
  root.updateMatrixWorld(true);
  const groups = new Map();   // material -> { list:[geo], cast, recv, runs:[{src,count}] }
  const push = (mat, geo, cast, recv, src) => {
    let e = groups.get(mat);
    if (!e) { e = { list: [], cast: false, recv: false, runs: [] }; groups.set(mat, e); }
    e.list.push(geo); e.cast = e.cast || cast; e.recv = e.recv || recv;
    if (trackSrc) e.runs.push({ src, count: geo.attributes.position.count });
  };
  const baseInv = preMatrix ? preMatrix.clone().invert() : null;
  const srcOf = (o) => {   // o 또는 조상에서 최근접 __mergeSrc 태그
    let a = o;
    while (a && a !== root) { if (a.userData && a.userData.__mergeSrc !== undefined) return a.userData.__mergeSrc; a = a.parent; }
    return undefined;
  };

  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    // 멀티머티리얼(groups)까지 완벽 지원하려면 group 분해 필요하나, 이 코드베이스 메시는
    // 전부 단일 재질이라 첫 재질만 사용(측정으로 확인).
    const mat = mats[0];
    if (!mat) return;
    const keepColor = !!mat.vertexColors;
    const src = trackSrc ? srcOf(o) : undefined;
    // 월드행렬을 preMatrix 기준으로 환산(프로토면 baseInv=null → 프로토로컬 그대로)
    const wm = baseInv ? baseInv.clone().multiply(o.matrixWorld) : o.matrixWorld;
    if (o.isInstancedMesh) {
      const im = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, im);
        const full = wm.clone().multiply(im);
        push(mat, normalizeGeo(o.geometry, full, keepColor), o.castShadow, o.receiveShadow, src);
      }
    } else {
      push(mat, normalizeGeo(o.geometry, wm, keepColor), o.castShadow, o.receiveShadow, src);
    }
  });

  const out = [];
  for (const [material, e] of groups) {
    const geometry = e.list.length === 1 ? e.list[0] : mergeGeometries(e.list, false);
    if (!geometry) continue;
    const rec = { material, geometry, castShadow: e.cast, receiveShadow: e.recv };
    if (trackSrc) {
      const ranges = new Map();   // srcId -> {start,count}(정점). 연속 run 이라 누적=단일 레인지.
      let cursor = 0;
      for (const r of e.runs) {
        if (r.src !== undefined) {
          let rr = ranges.get(r.src);
          if (!rr) { rr = { start: cursor, count: 0 }; ranges.set(r.src, rr); }
          rr.count += r.count;
        }
        cursor += r.count;
      }
      rec.srcRanges = ranges;
    }
    out.push(rec);
  }
  return out;
}

// 정규 주택 인스턴싱(변주 풀): 한 종류(kind)를 평면 변주(parcel.variant)별로 묶어 각 변주 decomp 를
//   재질별 InstancedMesh 로 만든다. 인스턴스 행렬(위치·yaw·스케일) + instanceColor(톤 곱틴트)로
//   집집이 서로 다른 표정. 드로우콜 = Σ(변주별 재질 수) — 호수 무관 상수(capital 도 수십 규모).
//   반환 핸들의 setHidden 은 변주 그룹을 가로질러 id→(메시들, 인덱스) 로 은닉/복원(편집 반영).
//   decomps: 변주 인덱스별 decompose 결과 배열([{material,geometry,cast,recv}], 미러 포함).
export function buildHouseInstances(kind, parcels, decomps) {
  const group = new THREE.Group();
  group.name = `houses-${kind}`;
  const ZERO = M4().makeScale(0, 0, 0);               // 은닉용(축소 소거)
  const clampV = (v) => (decomps[v] ? v : 0);
  const byVariant = new Map();
  for (const p of parcels) {
    const v = clampV(Math.max(0, p.variant || 0));
    let e = byVariant.get(v); if (!e) { e = []; byVariant.set(v, e); } e.push(p);
  }
  const locate = new Map();   // id -> { meshes:[InstancedMesh], index, mat:Matrix4 }
  const col = new THREE.Color();
  for (const [v, plist] of byVariant) {
    const decomp = decomps[v] || decomps[0];
    const n = plist.length;
    const mats = plist.map(houseMatrix);
    const meshes = [];
    for (let g = 0; g < decomp.length; g++) {
      const { material, geometry, castShadow, receiveShadow } = decomp[g];
      const inst = new THREE.InstancedMesh(geometry, material, n);
      inst.name = `inst-${kind}-v${v}-m${g}`;
      inst.castShadow = castShadow; inst.receiveShadow = receiveShadow;
      // #55: 부위별 독립 곱틴트 — 이 메시 재질의 역할(roof/wall/wood/stone)에 맞는 parcel 톤을
      //   instanceColor 로. 재질 복제 없이(각 역할=이미 별도 InstancedMesh) 드로우콜 불변. 개구부·
      //   기타(role 없음)는 중립(1,1,1) — 야간 창호광(emissive)·아궁이 불빛과 충돌 방지.
      const role = material && material.userData ? material.userData.role : null;
      for (let i = 0; i < n; i++) {
        inst.setMatrixAt(i, mats[i]);
        const t = roleTone(kind, plist[i], role);
        col.setRGB(t[0], t[1], t[2]); inst.setColorAt(i, col);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      meshes.push(inst); group.add(inst);
    }
    plist.forEach((p, i) => locate.set(p.id, { meshes, index: i, mat: mats[i] }));
  }
  const hidden = new Set();
  function setHidden(id, on) {
    const rec = locate.get(id);
    if (!rec) return;
    if (on) hidden.add(id); else hidden.delete(id);
    const m = on ? ZERO : rec.mat;
    for (const inst of rec.meshes) { inst.setMatrixAt(rec.index, m); inst.instanceMatrix.needsUpdate = true; }
  }
  group.userData = { kind, setHidden, isHidden: (id) => hidden.has(id), locate };
  return group;
}

// ── 원경 청크 임포스터(LOD, #47) ──────────────────────────────────────────────
//   문제: 청크별 풀디테일 인스턴싱은 재질 수(giwa≈54·choga≈32)를 청크마다 곱해 드로우콜·삼각형이
//   폭증한다(hanyang 실측 3400콜·20M삼각). 부감·원경에서 개별 집의 공포·창호·기와골은 픽셀 이하라
//   무의미 — 지붕 덩어리와 벽 매스만 읽힌다. 그래서 원경 청크의 정규 주택을 한 채당 저폴리 프록시
//   (몸통 박스 + 맞배 지붕 프리즘)로 대체하고 청크 전체를 vertexColor 단일 메시로 병합한다
//   → 청크당 1 드로우콜, 채당 ~30 삼각. 색은 집 종류 기저색 × 필지 부위 톤(roofTone/wallTone)으로
//   실제 집과 근사(부감에서 지붕색 다양성 유지). 그림자 비캐스트(원경).
// 기저색은 선형(linear) 근사값 — 마을 지오와 톤 정합. 부감 지붕 매스가 실제 집과 비슷하게 읽히도록.
const IMP = {
  giwa:  { roof: [0.20, 0.23, 0.27], wall: [0.70, 0.67, 0.60], bodyH: 3.4, roofH: 2.5, wK: 0.60, dK: 0.54 },
  choga: { roof: [0.40, 0.33, 0.21], wall: [0.40, 0.31, 0.20], bodyH: 2.5, roofH: 2.1, wK: 0.62, dK: 0.50 },
};
const _v = new THREE.Vector3();
function pushImpostorHouse(P, N, C, parcel) {
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const cfg = IMP[kind];
  const m = houseMatrix(parcel);   // T(center,baseY)·Ry·T(0,0,back)·S — 풀디테일 집과 동일 배치
  const W = (parcel.plotW || 10) * cfg.wK, D = (parcel.plotD || 9) * cfg.dK;
  const bh = cfg.bodyH, rh = cfg.roofH, hw = W / 2, hd = D / 2;
  const rt = parcel.roofTone || [1, 1, 1], wt = parcel.wallTone || [1, 1, 1];
  const rc = [cfg.roof[0] * rt[0], cfg.roof[1] * rt[1], cfg.roof[2] * rt[2]];
  const wc = [cfg.wall[0] * wt[0], cfg.wall[1] * wt[1], cfg.wall[2] * wt[2]];
  // 로컬 정점을 houseMatrix 로 월드화해 누적. 노멀은 computeVertexNormals 로 최종 산출(여기선 0 채움).
  const emit = (lx, ly, lz, col) => {
    _v.set(lx, ly, lz).applyMatrix4(m);
    P.push(_v.x, _v.y, _v.z); N.push(0, 0, 0); C.push(col[0], col[1], col[2]);
  };
  const tri = (a, b, c, col) => { emit(a[0], a[1], a[2], col); emit(b[0], b[1], b[2], col); emit(c[0], c[1], c[2], col); };
  const quad = (a, b, c, d, col) => { tri(a, b, c, col); tri(a, c, d, col); };
  // 몸통 박스(윗면 제외 — 지붕이 덮음). 4벽 + 바닥 생략.
  const y0 = 0, y1 = bh;
  const c0 = [-hw, y0, -hd], c1 = [hw, y0, -hd], c2 = [hw, y0, hd], c3 = [-hw, y0, hd];
  const t0 = [-hw, y1, -hd], t1 = [hw, y1, -hd], t2 = [hw, y1, hd], t3 = [-hw, y1, hd];
  quad(c3, c2, t2, t3, wc);  // +z
  quad(c1, c0, t0, t1, wc);  // -z
  quad(c0, c3, t3, t0, wc);  // -x
  quad(c2, c1, t1, t2, wc);  // +x
  // 맞배 지붕(용마루 로컬 x). 처마가 몸통 밖으로.
  const rW = W + 1.6, rD = D + 1.8, rhw = rW / 2, rhd = rD / 2, ry = bh, ryt = bh + rh;
  const b0 = [-rhw, ry, -rhd], b1 = [rhw, ry, -rhd], b2 = [rhw, ry, rhd], b3 = [-rhw, ry, rhd];
  const g0 = [-rhw, ryt, 0], g1 = [rhw, ryt, 0];
  tri(b3, b2, g1, rc); tri(b3, g1, g0, rc);   // +z 슬로프
  tri(b1, b0, g0, rc); tri(b1, g0, g1, rc);   // -z 슬로프
  tri(b0, b3, g0, rc); tri(b2, b1, g1, rc);   // 박공 삼각
}

// buildChunkImpostor(parcels) → THREE.Group(단일 vertexColor 메시). 원경 청크 전용.
export function buildChunkImpostor(parcels, name = 'chunk-impostor') {
  const P = [], N = [], C = [];
  for (const p of parcels) pushImpostorHouse(P, N, C, p);
  const group = new THREE.Group(); group.name = name;
  if (!P.length) return group;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `${name}-m`;
  mesh.castShadow = false; mesh.receiveShadow = true;
  group.add(mesh);
  group.userData.impostor = true;
  return group;
}

// 유일 지오(랜드마크·담·도로·논)를 재질별로 정적 병합. objects 는 이미 월드에 배치된 상태.
//   opts.ids(#148): objects 와 평행한 소스 id 배열. 주면 병합 메시 안에 소스별 정점 레인지를 기록해
//     group.userData.setHidden(id, on)/isHidden(id)/srcIds 를 노출한다 → focus 필지의 병합 담을 접어
//     오버레이 담과의 동일평면 이중 렌더(플리커)를 없앤다. 드로우콜 불변(레인지 접기, 메시 분할 아님).
// 반환: 병합 메시들을 담은 Group(자기 변환은 항등, 지오가 월드좌표를 품음).
export function mergeStatic(objects, name = 'merged-static', opts = {}) {
  const ids = opts.ids || null;
  const combined = new THREE.Group(); combined.name = 'tmp';
  // decomposeByMaterial 는 단일 root 를 받으므로 임시 부모로 묶는다(원본 부모 보존).
  const parents = objects.map((o) => ({ o, parent: o.parent }));
  if (ids) objects.forEach((o, i) => { if (ids[i] !== undefined) o.userData.__mergeSrc = ids[i]; });
  for (const { o } of parents) combined.add(o);
  const decomp = decomposeByMaterial(combined, null, { trackSrc: !!ids });
  // 원복(원본 트리 훼손 금지 — 병합은 사본 지오만 사용)
  for (const { o, parent } of parents) { if (parent) parent.add(o); else combined.remove(o); }
  if (ids) objects.forEach((o) => { delete o.userData.__mergeSrc; });

  const group = new THREE.Group(); group.name = name;
  const meshRanges = [];   // [{ mesh, ranges:Map<id,{start,count}> }]
  decomp.forEach(({ material, geometry, castShadow, receiveShadow, srcRanges }, i) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${name}-m${i}`;
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    group.add(mesh);
    if (srcRanges && srcRanges.size) meshRanges.push({ mesh, ranges: srcRanges });
  });
  if (ids && meshRanges.length) attachSourceHideHandle(group, meshRanges);
  return group;
}

// 병합 메시의 소스별 정점 레인지를 접었다/펴는(픽셀 일치 복원) 핸들을 group.userData 에 부착.
//   접기 = 레인지 정점 위치를 레인지 첫 정점으로 붕괴(퇴화 삼각 → 프래그먼트 0). 원본은 최초 접을 때
//   1회 slice 로 보관 → 펼 때 그대로 복사(byte 일치). 색·재질·드로우콜 불변(지오 position 부분 갱신만).
function attachSourceHideHandle(group, meshRanges) {
  const hidden = new Set();
  const srcIds = new Set();
  for (const mr of meshRanges) { for (const id of mr.ranges.keys()) srcIds.add(id); mr.saved = new Map(); }
  function setHidden(id, on) {
    if (on ? hidden.has(id) : !hidden.has(id)) return;   // 이미 목표 상태
    for (const mr of meshRanges) {
      const r = mr.ranges.get(id);
      if (!r || !r.count) continue;
      const pos = mr.mesh.geometry.attributes.position, arr = pos.array;
      const s = r.start * 3, cnt = r.count * 3;
      if (on) {
        if (!mr.saved.has(id)) mr.saved.set(id, arr.slice(s, s + cnt));   // 원본 1회 보관
        const ax = arr[s], ay = arr[s + 1], az = arr[s + 2];
        for (let k = 0; k < cnt; k += 3) { arr[s + k] = ax; arr[s + k + 1] = ay; arr[s + k + 2] = az; }
      } else {
        const sv = mr.saved.get(id); if (sv) arr.set(sv, s);
      }
      pos.needsUpdate = true;
    }
    if (on) hidden.add(id); else hidden.delete(id);
  }
  group.userData.setHidden = setHidden;
  group.userData.isHidden = (id) => hidden.has(id);
  group.userData.srcIds = srcIds;
}
