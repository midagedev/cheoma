import * as THREE from 'three';
import { markSharedResource } from '../core/three-resources.js';
import { makeRng } from '../rng.js';
export { pickWallType } from './variants.js';   // 담 유형 선택은 순수 로직(variants.js)에 둔다

// 마을 담장 어휘 — 신분·성격별 담 유무·유형을 확률(variants.pickWallType R-P3)로 뽑아 세운다.
//   조사(docs/village-walls-parcels.md Q3·Q4): "모든 집에 담"은 고증 오류. 서민은 개방 마당·울(생울/싸리)이
//   흔했다. wallType 6종:
//     'tile'  (반가·상급 기와): 사괴석 하단 + 회벽 상단 + 기와 지붕띠 + 솟을대문 힌트
//     'stone' (여염 돌담): 막돌 fieldstone + 몸채지붕 일치 coping(초가=이엉/기와=기와띠) + 평대문
//     'mud'   (토담): 흙+짚 다짐 박스 + 몸채지붕 일치 coping + 평대문
//     'brush' (싸리/바자울): 통나무 기둥 + 수직 스틱 열 + 가로 엮음(어깨 높이) + 사립문 힌트
//     'hedge' (생울/산울타리): 관목 열(탱자·개나리 감각) — 담 아닌 식재 경계
//     'open'  (개방 마당): 담 링 생략 — 사립문 기둥 + 텃밭 힌트만(서민 반개방)
//   담 지붕(coping)=몸채 지붕 일치(R-P4): opts.kind 로 초가(이엉)/기와(기와띠) 분기.
//   모든 스타일은 단일 공유 재질셋(wallMats)만 써서 병합 후 드로우콜이 "재질 수" 규모로 눌린다.
//
// 좌표 규약: 로컬 +z = 앞(도로·대문), -z = 뒤. hw=plotW/2, hd=plotD/2. 대문 개구는 +z 앞면 중앙.
//   담은 필지 배치 변환(parcelMatrix) 전 로컬 y=0(성토 패드 상면)에 선다.
//   필지는 부정형 다각형(parcels.js localParcelShape) — 담은 변(edge) 단위로 세운다. 앞변은 직선.

const DEG = Math.PI / 180;

// 유형별 담 기본 높이(m, R-P4). char01(빈부)·rng 로 미세 가감. 변별 높이는 edge.heightK 가 곱해짐.
const STYLE_H = { tile: 2.2, stone: 1.8, mud: 1.7, brush: 1.25, hedge: 1.1 };

// 생울(관목) 공유 재질·지오 — 모든 필지 공유 1벌이라 병합 후 1 드로우콜.
const HEDGE_MAT = markSharedResource(new THREE.MeshStandardMaterial({
  color: 0x4d6a33, roughness: 0.96, metalness: 0, flatShading: true,
}));
const HEDGE_GEO = markSharedResource(new THREE.IcosahedronGeometry(1, 0));
// 옹기(장독) 공유 지오 — 둥근 항아리 근사(스케일로 개체차). 병합 대상이라 재질은 wallMats 재사용.
const JAR_GEO = markSharedResource(new THREE.SphereGeometry(0.3, 10, 8));

// shape 폴백(부정형 미지정 시 정사각): parcels.rectShape 와 동일 규약.
function rectShape(plotW, plotD) {
  const hw = plotW / 2, hd = plotD / 2;
  return {
    pts: [{ x: hw, z: hd }, { x: -hw, z: hd }, { x: -hw, z: -hd }, { x: hw, z: -hd }],
    roles: ['front', 'left', 'back', 'right'],
  };
}

// 담+마당(어휘 격상) — populate 가 parcelMatrix 로 배치 후 병합. wallMats 는 전 필지 공유 1벌.
//   shape: { pts:[{x,z}...](로컬), roles:[...], edges?:[{role,heightK,share}] } — parcels.js 산출.
//   opts: { style, kind, seed, char01, aux, plotW, plotD }
export function buildVillageWall(shape, wallMats, opts = {}) {
  const style = opts.style || 'stone';
  const kind = opts.kind === 'giwa' ? 'giwa' : 'choga';
  const seed = (opts.seed | 0) || 7;
  const rng = makeRng((seed ^ 0x51de) >>> 0);
  const char01 = typeof opts.char01 === 'number' ? opts.char01 : 0.5;
  const plotW = opts.plotW, plotD = opts.plotD;
  const M = wallMats;
  const shp = (shape && shape.pts && shape.pts.length >= 3) ? shape : rectShape(plotW, plotD);
  const pts = shp.pts, roles = shp.roles, edges = shp.edges || null;
  const n = pts.length;

  const g = new THREE.Group();
  g.name = `wall-${style}`;
  const hd = plotD / 2;
  const gap = Math.min(plotW * 0.34, style === 'tile' ? 3.0 : 2.6);   // 대문 개구 폭

  // 개방 마당(open): 담 링 없음 — 사립문 기둥 + 텃밭 힌트만(서민 반개방 실루엣).
  if (style === 'open') {
    gatePosts(g, gap, hd, 1.25, M.mud, M.jipjul, 'brush');
    g.add(makeGardenPatch(plotW, plotD, M));               // 개방 마당의 정체성(텃밭) — 항상
    if (opts.aux) g.add(makeAux(plotW, plotD, 'brush', M, rng));
    g.add(makeYardProps(plotW, plotD, { ...opts, vegBed: false }, M, rng));  // 장독대·낟가리·빨래줄
    return g;
  }

  // 담 높이: 유형 기본 × 성격 × (연속 변주 wallHeightK[부유 상관] 또는 rng 폴백).
  const baseH = STYLE_H[style] * (0.88 + char01 * 0.2) * (opts.wallHeightK != null ? opts.wallHeightK : (0.96 + rng() * 0.1));
  const coping = style === 'tile' ? 'tile' : (kind === 'giwa' ? 'tile' : 'thatch');
  const th = style === 'tile' ? 0.42 : 0.5;

  // centroid(바깥 법선 판정용)
  let cx = 0, cz = 0; for (const p of pts) { cx += p.x; cz += p.z; } cx /= n; cz /= n;

  // 측·뒷변(role != 'front'): 변 단위 run. 높이 차등(edge.heightK) + 밀착 담 공유(edge.share) 생략.
  for (let k = 0; k < n; k++) {
    if (roles[k] === 'front') continue;                    // 앞변은 대문과 함께 아래에서
    const ed = edges ? edges[k] : null;
    if (ed && ed.share) continue;                          // 밀착 경계 담 1줄 공유(이 필지 생략)
    const hK = ed ? ed.heightK : (roles[k] === 'back' ? 0.72 : 0.7);
    const H = baseH * hK;
    const a = pts[k], b = pts[(k + 1) % n];
    g.add(makeEdgeRun(style, coping, a, b, H, th, cx, cz, M, rng));
  }

  // 앞변(도로/골목변): 대문 개구 + 양쪽 짧은 담(항상 최고 높이). 앞변은 (±hw,+hd) 직선.
  buildFrontEdge(g, style, coping, plotW, hd, baseH, th, gap, M, rng);

  // 모서리 기둥(솔리드): 실 모서리(인접 변 역할이 다른 꼭짓점)에만 — 뒷변 꺾임점 제외.
  if (style === 'stone' || style === 'mud' || style === 'tile') {
    for (let i = 0; i < n; i++) {
      if (roles[(i - 1 + n) % n] === roles[i]) continue;   // 같은 역할 사이(뒷변 중점) → 기둥 생략
      cornerPostAt(g, pts[i].x, pts[i].z, baseH, th, style, M);
    }
  }

  // 부속채(광·헛간): 앞마당 한쪽 구석에 낮은 작은 채. 병합 대상(공유 재질).
  if (opts.aux) g.add(makeAux(plotW, plotD, style, M, rng));

  // 마당 부속 소품(장독대·낟가리·빨래줄·텃밭) — 공유 재질 병합(0 신규 드로우콜).
  g.add(makeYardProps(plotW, plotD, opts, M, rng));

  return g;
}

// 임의의 로컬 변(a→b)에 담 한 run 을 앉힌다 — run 로컬 +X=변 방향, +Z=바깥 법선(두께).
//   style 별 run 지오는 기존 헬퍼 재사용(makeSolidRun/makeBrushRun/makeHedgeRun).
function makeEdgeRun(style, coping, a, b, H, th, cx, cz, M, rng) {
  const ex = b.x - a.x, ez = b.z - a.z;
  const L = Math.hypot(ex, ez);
  if (L < 0.05) return new THREE.Group();
  let dx = ex / L, dz = ez / L;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  // 바깥 법선 perpR(e)=(-dz,dx) 가 centroid 반대(바깥)를 향하게 변 방향 정렬
  if ((-dz) * (mx - cx) + dx * (mz - cz) < 0) { dx = -dx; dz = -dz; }
  const rotY = Math.atan2(-dz, dx);                        // +X→(dx,dz), +Z→perpR(e)=바깥
  const solid = style !== 'brush' && style !== 'hedge';
  const grow = solid ? 0.4 : 0;                            // 모서리 겹침(기둥이 이음새 가림)
  const child = style === 'brush' ? makeBrushRun(L + grow, H, M.mud, M.jipjul, rng)
    : style === 'hedge' ? makeHedgeRun(L + grow, H, rng)
    : makeSolidRun(style, coping, L + grow, H, th, M, rng);
  child.position.set(mx, 0, mz); child.rotation.y = rotY;
  return child;
}

// 앞변(도로변): 대문 개구를 가운데 두고 좌우 짧은 담 + 대문. 앞변은 항상 (±hw,+hd) 직선.
function buildFrontEdge(g, style, coping, plotW, hd, H, th, gap, M, rng) {
  const side = (plotW - gap) / 2;
  const extra = (style === 'brush' || style === 'hedge') ? 0 : 0.5;
  const mkRun = (L) => style === 'brush' ? makeBrushRun(L, H, M.mud, M.jipjul, rng)
    : style === 'hedge' ? makeHedgeRun(L, H, rng)
    : makeSolidRun(style, coping, L, H, th, M, rng);
  for (const sgn of [-1, 1]) {
    const run = mkRun(side + extra);
    run.position.set(sgn * (gap / 2 + side / 2), 0, hd);   // rotY 0: +X 좌우, +Z 앞(바깥)
    g.add(run);
  }
  if (style === 'brush' || style === 'hedge') gatePosts(g, gap, hd, H, M.mud, M.jipjul, 'brush');
  else gatePosts(g, gap, hd, H, M.wood, M.woodDark, style === 'tile' ? 'tile' : 'stone', M);
}

// 솔리드 담 한 스팬(로컬 X=길이). stone=막돌 돌담, mud=토담(흙+짚), tile=사괴석+회벽.
//   coping: 'tile'(기와 지붕띠) | 'thatch'(이엉 지붕띠) | 'none'. 몸채 지붕과 일치(R-P4).
function makeSolidRun(style, coping, L, H, th, M, rng) {
  const s = new THREE.Group();
  const wallTop = H - 0.18;
  if (style === 'stone') {
    // 막돌 돌담: fieldstone 텍스처 박스.
    const body = new THREE.Mesh(new THREE.BoxGeometry(L, wallTop, th), M.fieldstone);
    body.position.y = wallTop / 2; body.castShadow = body.receiveShadow = true; s.add(body);
  } else if (style === 'mud') {
    // 토담: 흙+짚 다짐(mud 톤) + 낮은 막돌 밑동(비 튐 방지 굽) — 하부 fieldstone 굽.
    const foot = Math.min(0.4, H * 0.22);
    const base = new THREE.Mesh(new THREE.BoxGeometry(L, foot, th * 1.04), M.fieldstone);
    base.position.y = foot / 2; base.castShadow = base.receiveShadow = true; s.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(L, wallTop - foot, th), M.mud);
    body.position.y = (foot + wallTop) / 2; body.castShadow = body.receiveShadow = true; s.add(body);
  } else {
    // tile(반가): 사괴석 하단 + 회벽 상단.
    const baseH = Math.min(0.72, H * 0.36);
    const base = new THREE.Mesh(new THREE.BoxGeometry(L, baseH, th * 1.04), M.fieldstone);
    base.position.y = baseH / 2; base.castShadow = base.receiveShadow = true; s.add(base);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(L, wallTop - baseH, th * 0.9), M.plaster);
    upper.position.y = (baseH + wallTop) / 2; upper.castShadow = upper.receiveShadow = true; s.add(upper);
  }
  if (coping === 'tile') s.add(makeTileCoping(L, wallTop, th, M));
  else if (coping === 'thatch') s.add(makeThatchCoping(L, wallTop, th, M));
  return s;
}

// 이엉 지붕띠(초가 필지 담 coping, R-P4): 짚 두께층 + 둥근 짚 마루. M.thatch 재사용.
function makeThatchCoping(L, eaveY, th, M) {
  const c = new THREE.Group();
  const w = th + 0.32;
  const body = new THREE.Mesh(new THREE.BoxGeometry(L + 0.06, 0.2, w), M.thatch);
  body.position.y = eaveY + 0.1; body.castShadow = true; c.add(body);
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.42, w * 0.42, L + 0.04, 9), M.thatch);
  ridge.rotation.z = Math.PI / 2; ridge.position.y = eaveY + 0.24; ridge.castShadow = true; c.add(ridge);
  return c;
}

// 생울 한 run(로컬 X=길이): 관목 덩어리 열. 공유 재질·지오(HEDGE_*) → 병합 1 드로우콜.
function makeHedgeRun(L, H, rng) {
  const s = new THREE.Group();
  const n = Math.max(2, Math.round(L / 1.05));
  for (let i = 0; i <= n; i++) {
    const x = -L / 2 + L * (i / n) + (rng() - 0.5) * 0.12;
    const r = 0.52 + rng() * 0.18;
    const blob = new THREE.Mesh(HEDGE_GEO, HEDGE_MAT);
    blob.scale.set(r * 1.15, H * 0.5 * (0.88 + rng() * 0.24), r);
    blob.position.set(x, H * 0.5, (rng() - 0.5) * 0.08);
    blob.castShadow = blob.receiveShadow = true;
    s.add(blob);
  }
  return s;
}

// 텃밭 힌트(개방 마당): 앞마당 한쪽 흙 이랑 몇 줄. 공유 재질.
function makeGardenPatch(plotW, plotD, M) {
  const g = new THREE.Group(); g.name = 'garden';
  const w = Math.min(plotW * 0.46, 4.6), d = Math.min(plotD * 0.3, 3.4);
  const cx = -plotW * 0.16, cz = plotD * 0.18;
  const soil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), M.stoneDark);
  soil.position.set(cx, 0.04, cz); soil.receiveShadow = true; g.add(soil);
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const row = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.07, 0.14), M.mud);
    row.position.set(cx, 0.11, cz - d * 0.3 + i * (d * 0.3)); g.add(row);
  }
  return g;
}

// ── 마당 부속 소품(#55): 장독대·낟가리·빨래줄·텃밭 ──────────────────────────────
//   집집이 마당 살림이 다르게. 전부 공유 wallMats 재질만 써서 병합 후 드로우콜 불변(0 신규).
//   구역 분할(로컬 +z=앞·도로, -z=뒤안): 장독대=뒤안 좌, 낟가리=뒤안 우(부속채와 배타),
//   빨래줄=앞마당 좌, 텃밭=앞마당 우. 신분(부유도)·rng 로 규모·유무가 상관 샘플됨(variants.js).
function makeYardProps(plotW, plotD, opts, M, rng) {
  const g = new THREE.Group(); g.name = 'yard-props';
  const hw = plotW / 2, hd = plotD / 2;

  // 장독대: 뒤안 좌측 낮은 돌단 + 옹기 열(규모 jangdok 0~3 → 열·항아리 수).
  const jd = opts.jangdok || 0;
  if (jd > 0) {
    const rows = jd, perRow = 2 + jd;
    const platW = Math.min(plotW * 0.4, perRow * 0.62 + 0.4);
    const platD = rows * 0.56 + 0.3;
    const px = -hw + platW / 2 + 0.5, pz = -hd + platD / 2 + 0.5;
    const plat = new THREE.Mesh(new THREE.BoxGeometry(platW, 0.14, platD), M.fieldstone);
    plat.position.set(px, 0.07, pz); plat.receiveShadow = true; g.add(plat);
    for (let r = 0; r < rows; r++) {
      const n = Math.max(1, perRow - r);            // 뒤열일수록 큰 독 적게
      for (let c = 0; c < n; c++) {
        const js = 0.62 + rng() * 0.7;
        const jar = new THREE.Mesh(JAR_GEO, M.woodDark);   // 옹기(어두운 유약) — woodDark 재사용
        jar.scale.set(js, js * (1.05 + rng() * 0.35), js);
        const jx = px + (n === 1 ? 0 : (-platW / 2 + 0.3 + c * (platW - 0.6) / (n - 1)));
        jar.position.set(jx, 0.14 + 0.26 * js, pz - platD / 2 + 0.32 + r * 0.52);
        jar.castShadow = jar.receiveShadow = true; g.add(jar);
      }
    }
  }

  // 낟가리(볏가리): 뒤안 우측 뭉툭한 짚 원뿔 + 눌림 마루. 부속채(같은 구석)와 배타 배치.
  if (opts.yardStack && !opts.aux) {
    const R = 0.7 + rng() * 0.35, H = 1.5 + rng() * 0.6;
    const cx = hw - R - 0.6, cz = -hd + R + 0.7;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(R, H, 9), M.thatch);
    cone.position.set(cx, H / 2, cz); cone.castShadow = cone.receiveShadow = true; g.add(cone);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.5, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.jipjul);
    cap.position.set(cx, H, cz); cap.castShadow = true; g.add(cap);
  }

  // 빨래줄: 앞마당 좌측 통나무 기둥 2 + 줄 + 널린 천 몇 폭(흰 회벽 재질 재사용).
  if (opts.clothesline) {
    const span = Math.min(plotW * 0.44, 3.6), ph = 1.7;
    const lx = -hw * 0.5, lz = hd * 0.45;             // 앞마당 좌
    const ang = (rng() - 0.5) * 0.5;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, ph, 6), M.wood);
      post.position.set(lx + dx * s * span / 2, ph / 2, lz + dz * s * span / 2);
      post.castShadow = true; g.add(post);
    }
    const line = new THREE.Mesh(new THREE.BoxGeometry(span, 0.02, 0.02), M.woodDark);
    line.position.set(lx, ph - 0.05, lz); line.rotation.y = -ang; g.add(line);
    const nCloth = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < nCloth; i++) {
      const t = (i + 0.7) / (nCloth + 0.4) - 0.5;
      const ch = 0.5 + rng() * 0.4;
      const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.42, ch, 0.03), M.plaster);
      cloth.position.set(lx + dx * t * span, ph - 0.08 - ch / 2, lz + dz * t * span);
      cloth.rotation.y = -ang; cloth.castShadow = cloth.receiveShadow = true; g.add(cloth);
    }
  }

  // 텃밭: 앞마당 우측 흙 이랑 몇 줄(makeGardenPatch 재사용 배치).
  if (opts.vegBed) {
    const patch = makeGardenPatch(plotW, plotD, M);
    patch.position.set(plotW * 0.3, 0, hd * 0.2);    // 앞마당 우(기본 patch 의 반대편)
    g.add(patch);
  }

  return g;
}

// 담 위 기와 지붕띠: 얕은 맞배(양면 기왓골) + 용마루. 처마가 담두께보다 살짝 나온다.
function makeTileCoping(L, eaveY, th, M) {
  const c = new THREE.Group();
  const over = 0.16;                       // 처마 내밀기(z)
  const halfSpan = th / 2 + over;
  const rise = 0.28;                        // 용마루 솟음
  const ridgeY = eaveY + rise;
  // 처마 단(어두운 띠) — 양쪽 처마선
  for (const sz of [1, -1]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(L + 0.1, 0.07, 0.06), M.eaveBand);
    band.position.set(0, eaveY + 0.02, sz * halfSpan); c.add(band);
  }
  // 양면 기왓골(경사 판) — tileConvex 밝은 기와톤
  const slope = Math.atan2(rise, halfSpan);
  const planeLen = Math.hypot(halfSpan, rise) + 0.02;
  for (const sz of [1, -1]) {
    const plane = new THREE.Mesh(new THREE.BoxGeometry(L + 0.08, 0.05, planeLen), M.tileConvex);
    plane.position.set(0, (eaveY + ridgeY) / 2 - 0.01, sz * halfSpan / 2);
    plane.rotation.x = sz * slope;         // 용마루→처마로 흘러내림
    plane.castShadow = true; c.add(plane);
  }
  // 용마루(적층 마루) — 어두운 마루톤 각봉
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(L + 0.06, 0.14, 0.16), M.tileRidge);
  ridge.position.y = ridgeY; ridge.castShadow = true; c.add(ridge);
  return c;
}

// 싸리울 한 run: 통나무 기둥 + 가로 엮음(2줄) + 가는 수직 잔가지 열.
function makeBrushRun(L, H, postMat, twigMat, rng) {
  const s = new THREE.Group();
  const postR = 0.07;
  const nPosts = Math.max(2, Math.round(L / 2.2));
  for (let i = 0; i <= nPosts; i++) {
    const x = -L / 2 + L * (i / nPosts);
    const ph = H + 0.12;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR * 1.15, ph, 6), postMat);
    post.position.set(x, ph / 2, 0); post.castShadow = true; s.add(post);
  }
  // 수직 잔가지 — 촘촘하되 부감/스틸에 충분한 밀도(과밀 회피)
  const nStick = Math.max(6, Math.round(L / 0.22));
  const stickH = H - 0.1;
  const geo = new THREE.CylinderGeometry(0.016, 0.014, stickH, 4);
  const im = new THREE.InstancedMesh(geo, twigMat, nStick);
  const m = new THREE.Matrix4();
  for (let i = 0; i < nStick; i++) {
    const x = -L / 2 + L * ((i + 0.5) / nStick) + (rng() - 0.5) * 0.02;
    const lean = (rng() - 0.5) * 0.06;
    m.makeRotationZ(lean); m.setPosition(x, stickH / 2 + 0.04, (rng() - 0.5) * 0.02);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true; im.castShadow = true; s.add(im);
  // 가로 엮음 2줄
  for (const yy of [H * 0.4, H * 0.82]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, L, 5), twigMat);
    bar.rotation.z = Math.PI / 2; bar.position.set(0, yy, 0); bar.castShadow = true; s.add(bar);
  }
  return s;
}

// 모서리 기둥(솔리드 담 마감) — 로컬 (x,z) 한 꼭짓점. tile=회벽+기와 캡, stone=돌 기둥.
function cornerPostAt(g, x, z, H, th, style, M) {
  const p = new THREE.Group();
  if (style === 'tile') {
    const baseH = Math.min(0.72, H * 0.36), top = H - 0.1;
    const b = new THREE.Mesh(new THREE.BoxGeometry(th * 1.2, baseH, th * 1.2), M.fieldstone);
    b.position.y = baseH / 2; b.castShadow = true; p.add(b);
    const u = new THREE.Mesh(new THREE.BoxGeometry(th * 1.1, top - baseH, th * 1.1), M.plaster);
    u.position.y = (baseH + top) / 2; u.castShadow = true; p.add(u);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(th * 0.95, 0.3, 4), M.tileRidge);
    cap.rotation.y = Math.PI / 4; cap.position.y = top + 0.12; cap.castShadow = true; p.add(cap);
  } else {
    const b = new THREE.Mesh(new THREE.BoxGeometry(th * 1.15, H * 0.98, th * 1.15), M.fieldstone);
    b.position.y = H * 0.49; b.castShadow = true; p.add(b);
  }
  p.position.set(x, 0, z);
  g.add(p);
}

// 대문 힌트: 기둥 2 + 상방. tile=솟을(높은 기둥+작은 기와 지붕), stone=평대문(판문틀), brush=사립문(가는 통나무).
function gatePosts(g, gap, hd, H, postMat, barMat, style, M) {
  const raise = style === 'tile' ? H * 0.45 : style === 'brush' ? 0.15 : 0.2;
  const pH = H + raise;
  const pr = style === 'brush' ? 0.09 : 0.13;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr * 1.1, pH, style === 'brush' ? 7 : 8), postMat);
    post.position.set(sx * gap / 2, pH / 2, hd); post.castShadow = true; g.add(post);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(gap + 0.34, style === 'brush' ? 0.08 : 0.2, 0.2),
    style === 'brush' ? barMat : M.woodDark);
  lintel.position.set(0, pH - 0.18, hd); lintel.castShadow = true; g.add(lintel);
  if (style === 'tile') {
    // 솟을대문 힌트: 상방 위 작은 기와 지붕(용마루 + 양면 골)
    const cap = makeTileCoping(gap + 0.7, pH + 0.05, 0.5, M);
    cap.position.set(0, 0, hd);
    g.add(cap);
  }
}

// 부속채(광·헛간): 앞마당 우측 구석 낮은 작은 채(벽 + 얕은 맞배 지붕). 병합용 공유 재질.
function makeAux(plotW, plotD, style, M, rng) {
  const a = new THREE.Group(); a.name = 'aux';
  const w = Math.min(plotW * 0.3, 3.2), d = Math.min(plotD * 0.22, 2.6), h = 1.7 + rng() * 0.2;
  const wallMat = style === 'brush' ? M.mud : M.plaster;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  body.position.y = h / 2; body.castShadow = body.receiveShadow = true; a.add(body);
  // 얕은 맞배 지붕: 초가풍(brush)=이엉, 그 외=기와톤
  const roofMat = style === 'brush' ? M.thatch : M.tileConvex;
  const rise = 0.6, over = 0.28;
  for (const sx of [1, -1]) {
    const plane = new THREE.Mesh(new THREE.BoxGeometry(w + over * 2, 0.1, d / 2 + over), roofMat);
    plane.position.set(0, h + rise / 2, sx * (d / 4));
    plane.rotation.x = sx * Math.atan2(rise, d / 2 + over);
    plane.castShadow = true; a.add(plane);
  }
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.12, 0.14), style === 'brush' ? M.jipjul : M.tileRidge);
  ridge.position.y = h + rise; ridge.castShadow = true; a.add(ridge);
  // 앞마당 우측 뒤 구석(도로 반대편 -z, +x)에 배치 — 본채·대문과 겹치지 않게
  a.position.set(plotW / 2 - w / 2 - 0.4, 0, -plotD / 2 + d / 2 + 0.6);
  a.rotation.y = (rng() - 0.5) * 0.2;
  return a;
}
