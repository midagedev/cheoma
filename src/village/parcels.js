import * as G from './geom.js';
import { makeRng } from '../rng.js';

// 도로변 필지 분할 + 신분 위계 그라디언트 (joseon-city.md 규칙 7·8·9·10).
//   - 필지는 도로 파사드를 따라 양편에 앉고, 집은 도로(로컬 +z)를 향한다(규칙 7).
//   - 신분(rank 0..1) → 필지 면적·칸수·유형(기와/초가) 매핑. 1품↔서인 면적차(가대제한).
//   - 중심(종가/관아/궁)·주산(북)·간선에 가까울수록 rank↑(크고 기와), 멀·남·외곽일수록 rank↓
//     (작고 초가). 그라디언트는 단조. 격자는 결코 완성되지 않는다.
//
// planParcels(site, roadsResult, opts, rng, blockers) → parcels[]
//   parcel: { poly, center, frontDir, rank, kind, plotW, plotD, hero?, heroStyle?, seed }

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const SCALE_TARGET = { hamlet: 10, village: 32, town: 70, capital: 104, hanyang: 340 };

// 공간 해시 그리드 — 필지 겹침 판정을 O(배치수)에서 O(근접셀)로. 도성(수백 필지)에서 필수:
//   기존 전수검사(모든 placed 폴리곤 대비 SAT)는 후보수×배치수 = O(n²)라 hanyang 에서 수초 소요.
//   각 폴리곤을 bbox 가 걸치는 셀들에 등록하고, 후보는 자기 bbox 근접 셀의 폴리곤만 대조한다.
//   셀 크기는 최대 필지 치수 상당(≈28m) — 폴리곤이 걸치는 셀이 소수로 유지된다.
function makePlacedGrid(cell = 28) {
  const grid = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const bboxCells = (poly) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
    return { cx0: Math.floor(minX / cell), cx1: Math.floor(maxX / cell), cz0: Math.floor(minZ / cell), cz1: Math.floor(maxZ / cell) };
  };
  return {
    add(poly) {
      const b = bboxCells(poly);
      for (let cx = b.cx0; cx <= b.cx1; cx++) for (let cz = b.cz0; cz <= b.cz1; cz++) {
        const k = key(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(poly);
      }
    },
    overlaps(poly) {
      const b = bboxCells(poly);
      const seen = new Set();
      for (let cx = b.cx0; cx <= b.cx1; cx++) for (let cz = b.cz0; cz <= b.cz1; cz++) {
        const arr = grid.get(key(cx, cz)); if (!arr) continue;
        for (const q of arr) { if (seen.has(q)) continue; seen.add(q); if (G.polysOverlap(poly, q)) return true; }
      }
      return false;
    },
  };
}
// 간선 우선 배정 순서(대로변 프라임 파사드부터).
const LEVEL_ORDER = { daero: 0, jungno: 1, soro: 2, golmok: 3 };
// 도로 등급별 파사드 간격(전면 폭 + 여유).
const FRONT_STEP = { daero: 17, jungno: 15, soro: 13, golmok: 11.5 };
const ARTERIAL_BONUS = { daero: 0.26, jungno: 0.18, soro: 0.06, golmok: 0.0 };

// rank + character(char01) → 필지 치수·유형.
//   char01: 민촌(0)일수록 기와 임계를 올려(초가↑) + 필지 축소, 반촌(1)일수록 기와↑ + 필지 확대.
//   상위=대형 기와, 하위=초가. hero 는 상위 극소수(종가·반가).
function dimsFor(rank, char01) {
  const kindRank = rank + (char01 - 0.5) * 0.62;      // 반촌 +0.31(기와↑) / 민촌 -0.31(초가↑)
  const sizeMul = 0.84 + char01 * 0.40;               // 민촌 0.84 / 여염 1.04 / 반촌 1.24
  let kind, w, d;
  if (kindRank >= 0.58) { kind = 'giwa'; w = 17; d = 16; }
  else if (kindRank >= 0.40) { kind = 'giwa'; w = 14; d = 13; }
  else if (kindRank >= 0.26) { kind = 'choga'; w = 12; d = 11; }
  else { kind = 'choga'; w = 10; d = 9.5; }
  return { kind, plotW: w * sizeMul, plotD: d * sizeMul };
}

const lerpN = (a, b, t) => a + (b - a) * t;

// 같은 rank 라도 필지 대소를 변주(찍어낸 인상 완화). 대칭·소폭이라 집 측여백(≈0.20·plotW)을
//   침범하지 않는다. reg 낮을수록(민촌·하급) 변주 큼.
function sizeVary(dims, reg, sr) {
  const sw = 1 + (sr() * 2 - 1) * lerpN(0.13, 0.04, reg);
  const sd = 1 + (sr() * 2 - 1) * lerpN(0.11, 0.035, reg);
  return { kind: dims.kind, plotW: dims.plotW * sw, plotD: dims.plotD * sd };
}

// ── R-P1 필지 부정형화 ──────────────────────────────────────────────
// 정연도(reg): 0=민촌·하급(불규칙) … 1=반가·정연. 신분(rank)·성격(char01) 함수.
//   반가/히어로는 정연(정사각에 가깝게), 민촌 하급은 크게 꺾인 부정형.
//   #54 체감 상향: 앱 부감(oblique·원거리)에서 부정형이 안 읽혀 하한을 대폭 인하하고 곡선을 아래로
//   내렸다. 여염(char01=0.5)도 저·중 rank 는 reg≈0.06~0.29 로 확연히 손그림, 반가 고rank 만 정연.
const regOf = (rank, char01, hero) =>
  hero ? 0.90 : Math.max(0, Math.min(1, 0.06 + rank * 0.46 + (char01 - 0.5) * 0.34));

// 방향 벡터(frontDir) 를 xz 평면에서 ang(rad) 회전 — 필지 방향 지터. frontDir 에 얹으면
//   worldPolyFromShape(=facingY)·parcelRotY 가 모두 이 각을 공유 → poly·담·패드·프록시 정합 유지.
function rotDir(d, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c };
}
// reg → 필지 방향 지터 최대각(rad). 정연 마을(격자 지향) 규칙을 완화해 손배치 인상.
const facingJitter = (reg, sr) => (sr() * 2 - 1) * lerpN(0.34, 0.09, reg);   // ±19.5°(민촌)~±5°(반가)

// 로컬 부정형 필지 폴리곤(docs R-P1). 좌표: X=좌우(도로 접선), Z=앞(+hd 도로변)~뒤(-hd).
//   집은 뒤(z=-hd 근처)에 앉고 앞(+hd)은 마당·대문쪽. 앞변(파사드)은 직선·전폭 고정 —
//   담 렌더(walls.buildFrontEdge)가 z=+hd 전폭 직선을 전제하고, 고증상 도로변은 곧은 파사드 +
//   불규칙 후면이 실제 지적 형상에 부합한다. 부정형은 측변 전단·뒷변 오므림/꺾임에 싣고,
//   격자 인상은 필지 방향 지터(호출부 frontDir)가 깬다.
//   · 측변: 전단(lean, 평행사변형 기욺 — 앞·뒤 함께 이동해 폭 보존)으로 크게 꺾음(reg 낮을수록 큼).
//   · 뒷변: 오므림(bn) 은 #45 검증한도(합 ≤0.21·plotW) 내로 클램프(집 뒤폭 보존) + 확률적 바깥
//     (-z) 꺾임(볼록·집 반대로 확장 → 안전, 손그림 능선순응). + 뒤깊이 지터로 좌우 비대칭.
//   결정론: 호출부가 시드 rng 주입. 반환 pts 는 볼록(SAT 겹침판정·offset 패드 안전).
// 반환: { pts:[{x,z}...], roles:[...] } — pts[k]→pts[k+1] 변의 역할 roles[k].
function localParcelShape(plotW, plotD, reg, sr) {
  const hw = plotW / 2, hd = plotD / 2;
  const sym = () => sr() * 2 - 1;
  // 전단: 평행사변형 기욺(앞·뒤 함께 이동 → 뒷폭 보존, 집 안전). 민촌 ±0.22W~반가 ±0.06W
  //   (#45 검증 상한 0.20W 근처 유지 — 집이 앉는 뒷측 여백 보존).
  const lean = sym() * plotW * lerpN(0.22, 0.06, reg);
  // 뒷변 오므림(집 뒤): 좌우 합이 0.21·plotW 를 넘지 않게 각각 0.105·plotW 클램프(#45 검증한도).
  const bnCap = plotW * 0.105;
  const bnL = Math.min(sr() * plotW * lerpN(0.17, 0.04, reg), bnCap);
  const bnR = Math.min(sr() * plotW * lerpN(0.17, 0.04, reg), bnCap);
  // 뒤 깊이 지터(뒷변·측변이 평행하지 않게). 뒤로(-z) 물러남만 허용해 뒷폭·집여백 보존.
  const zjL = -sr() * plotD * lerpN(0.18, 0.045, reg);
  const zjR = -sr() * plotD * lerpN(0.18, 0.045, reg);
  const FR = { x: hw, z: hd }, FL = { x: -hw, z: hd };        // 앞변(직선·전폭 고정)
  const BL = { x: -hw + lean + bnL, z: -hd + zjL };
  const BR = { x: hw + lean - bnR, z: -hd + zjR };
  const pts = [FR, FL, BL];
  const roles = ['front', 'left'];                           // FR→FL 앞, FL→BL 좌
  if (sr() < lerpN(0.72, 0.16, reg)) {
    // 뒷변 꺾임: 중점을 바깥(-z)으로만 밀어 볼록 유지(집 반대 방향 → 관통 무관).
    const mid = { x: (BL.x + BR.x) / 2 + sym() * plotW * 0.10,
                  z: (BL.z + BR.z) / 2 - plotD * (0.07 + sr() * 0.17) };
    pts.push(mid); roles.push('back');
  }
  pts.push(BR); roles.push('back');
  roles.push('right');                                       // BR→FR 우
  return { pts, roles };
}

// 정연한 사각 필지(히어로·폴백). roles 는 부정형과 동일 4역.
function rectShape(plotW, plotD) {
  const hw = plotW / 2, hd = plotD / 2;
  return {
    pts: [{ x: hw, z: hd }, { x: -hw, z: hd }, { x: -hw, z: -hd }, { x: hw, z: -hd }],
    roles: ['front', 'left', 'back', 'right'],
  };
}

// 로컬 shape 점을 월드로 — parcelMatrix(instancing.js)와 동일한 T(center)·Ry(facingY(frontDir)).
//   yaw 는 배치 변환에서만 얹히므로(현 poly 규약과 동일) 여기선 제외 — 담·패드·프록시가 이 poly 로 정렬.
function worldPolyFromShape(center, frontDir, pts) {
  const th = Math.atan2(frontDir.x, frontDir.z);
  const cos = Math.cos(th), sin = Math.sin(th);
  return pts.map((p) => ({ x: center.x + p.x * cos + p.z * sin, z: center.z - p.x * sin + p.z * cos }));
}

// ── R-P2 고샅(골목) 폭 ──────────────────────────────────────────────
// 이웃 담 사이 틈 = 고샅. 소로급 1.0~3.4m 변주(민촌·하급 좁게, 반가·반촌 넓게).
function gapWidth(rank, char01, rng) {
  const base = 0.85 + (0.55 * rank + 0.45 * char01) * 2.5;   // 0.85(하급 좁은 고샅) ~ 3.35(반가·반촌)
  return Math.max(0.7, Math.min(3.9, base + rng.range(-0.35, 0.35)));
}

// 점 p 에서 폴리곤 poly(변 집합)까지 최단거리.
function polyDist(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = G.distToSeg(p, poly[i], poly[(i + 1) % poly.length]).d;
    if (d < best) best = d;
  }
  return best;
}

export function planParcels(site, roadsResult, opts, rng, blockers = []) {
  const scale = opts.scale;
  const char01 = typeof opts.char01 === 'number' ? opts.char01 : 0.5;
  const roads = roadsResult.roads;
  const C = site.center;
  // 필지 목표수: 연속 스케일(#89)은 plan 이 siteR 파생 연속값(opts.target)을 주입 → tier 경계에서
  //   호수(戶數)가 튀지 않는다. 미주입(구 호출)이면 이산 SCALE_TARGET 폴백(회귀 안전).
  const target = (typeof opts.target === 'number' && opts.target > 0) ? Math.round(opts.target) : (SCALE_TARGET[scale] || 30);
  const parcels = [];
  const placed = makePlacedGrid();                              // 충돌 폴리곤 공간해시(예약분 포함)
  for (const b of blockers) if (b.poly) placed.add(b.poly);

  const northRef = C.z - site.bowlR * 0.35;    // 최북 거주선(주산 기슭)

  const rankAt = (center, level) => {
    const dC = G.dist(center, C);
    const nearC = 1 - smoothstep(0, site.bowlR * 0.95, dC);
    const north = 1 - smoothstep(northRef, site.streamZ, center.z);  // 북(주산측)→1, 남(개울측)→0
    let r = 0.12 + 0.50 * nearC + 0.22 * north + (ARTERIAL_BONUS[level] || 0);
    r += rng.range(-0.07, 0.07);
    return Math.max(0, Math.min(1, r));
  };

  // 필지 유효성: 분지 안 · 개울/논 회피 · 남한선 · 급경사 회피 · 타도로/타필지 비겹침.
  // 필지 중심이 다른 도로 위(또는 바짝)에 앉지 않도록만 막는다. 뒷모서리는 이웃 도로에
  // 근접해도 허용(블록이 좁아도 채워지게) — 완전 겹침은 아래 overlap 검사가 담당.
  const clearOfRoads = (center, ownRoad) => {
    for (const r of roads) {
      if (r === ownRoad) continue;
      if (G.distToPolyline(center, r.pts).d < r.width / 2 + 2.5) return false;
    }
    return true;
  };
  const validate = (center, poly, ownRoad) => {
    if (G.dist(center, C) > site.bowlR * 1.06) { dbg.bowl++; return false; }
    if (site.stream && Math.abs(center.z - site.streamZat(center.x)) < site.streamHalf + 4.5) { dbg.stream++; return false; }
    if (site.paddyRegion) {
      const pr = site.paddyRegion;
      if (center.x > pr.xMin - 2 && center.x < pr.xMax + 2 && center.z > pr.zNear - 2 && center.z < pr.zFar + 2) { dbg.paddy++; return false; }
    }
    // 남한선: 씨족촌은 개울 북쪽만, 도성/읍치는 남촌 일부 허용
    const southLimit = (scale === 'hamlet' || scale === 'village')
      ? site.streamZ - 5
      : site.streamZ + site.bowlR * 0.26;
    if (center.z > southLimit) { dbg.south++; return false; }
    if (site.hillAt(center.x, center.z) > 0.52) { dbg.hill++; return false; }    // 능선·안산 급경사 제외
    // 급경사 필지 배제: footprint 지형 낙차가 한 계단(성토 패드)으로 감당 안 되면 제외.
    //   → 거대 축대·집 공중부양 방지. 완경사·언듈레이션 위(낙차 작음)만 통과.
    {
      let gmin = Infinity, gmax = -Infinity;
      for (const c of poly) { const g = site.heightAt(c.x, c.z); if (g < gmin) gmin = g; if (g > gmax) gmax = g; }
      if (gmax - gmin > 1.6) { dbg.steep++; return false; }
    }
    if (!clearOfRoads(center, ownRoad)) { dbg.road++; return false; }
    if (placed.overlaps(poly)) { dbg.overlap++; return false; }
    return true;
  };

  const ordered = roads.slice().sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]));
  let heroCount = 0;
  // 반가(hero) 밀도: 민촌은 0(예약 종가만), 반촌은 다수 — 빈부의 핵심 시각신호.
  const baseCap = scale === 'hanyang' ? 6 : scale === 'capital' ? 6 : scale === 'town' ? 4 : scale === 'village' ? 2 : 1;
  const heroCap = char01 < 0.34 ? 0 : Math.max(1, Math.round(baseCap * (0.3 + char01)));
  const heroRankMin = 0.86 - char01 * 0.16;    // 반촌일수록 반가 승격 문턱 낮음
  const heroDistK = 0.45 + char01 * 0.28;      // 반촌일수록 반가가 중심에서 더 넓게
  const dbg = { candidates: 0, bowl: 0, stream: 0, paddy: 0, south: 0, hill: 0, steep: 0, road: 0, overlap: 0, placed: 0 };
  planParcels.lastDebug = dbg;

  const FS = 2.0;              // 커서 정밀도(m)
  for (const road of ordered) {
    if (parcels.length >= target) break;
    const fine = G.resample(road.pts, FS);
    if (fine.length < 4) continue;
    const endPad = Math.round((road.width * 0.6 + 4) / FS);   // 교차·끝부 회피
    for (const side of [1, -1]) {
      // 도로를 따라 커서 전진: 배치 성공 시 필지폭+골 만큼, 실패 시 FS 씩.
      let i = endPad;
      while (i < fine.length - endPad) {
        if (parcels.length >= target) break;
        const smp = fine[i];
        const inward = G.mul(G.perpL(smp.tan), side);
        const provisional = G.add(smp.pt, G.mul(inward, road.width / 2 + 8));
        let rank = rankAt(provisional, road.level);
        let dims = dimsFor(rank, char01);
        let hero = false, heroStyle;
        if (rank >= heroRankMin && heroCount < heroCap && G.dist(provisional, C) < site.bowlR * heroDistK) {
          hero = true; heroStyle = 'hanok';
          dims = { kind: 'giwa', plotW: 26, plotD: 24 };
        }
        const pseed = (opts.seed ^ (parcels.length * 2654435761)) >>> 0;
        const reg = regOf(rank, char01, hero);
        if (!hero) dims = sizeVary(dims, reg, makeRng((pseed ^ 0x51fa) >>> 0));  // 같은 rank 내 대소 변주
        const base = G.add(smp.pt, G.mul(inward, road.width / 2 + 1.2));
        const center = G.add(base, G.mul(inward, dims.plotD / 2));
        const inwardDir = G.norm(G.mul(inward, -1));            // 도로를 향한 기본 방향
        const frontDir = hero ? inwardDir
          : rotDir(inwardDir, facingJitter(reg, makeRng((pseed ^ 0x77d1) >>> 0)));  // 방향 지터(격자 완화)
        const shape = hero ? rectShape(dims.plotW, dims.plotD)
          : localParcelShape(dims.plotW, dims.plotD, reg, makeRng((pseed ^ 0xa53f) >>> 0));
        const poly = worldPolyFromShape(center, frontDir, shape.pts);
        dbg.candidates++;
        if (validate(center, poly, road)) {
          dbg.placed++;
          parcels.push({
            poly, shape, center, frontDir, rank, kind: dims.kind,
            plotW: dims.plotW, plotD: dims.plotD, hero, heroStyle, seed: pseed,
          });
          placed.add(poly);
          if (hero) heroCount++;
          const gap = gapWidth(rank, char01, rng);              // R-P2 고샅 폭 변주
          i += Math.max(1, Math.round((dims.plotW + gap) / FS)); // 필지폭 + 고샅만큼 전진
        } else {
          i += 1;                                                   // 다음 자리 시도
        }
      }
    }
  }

  // ── 내부 충전(Poisson) ── 도로 회랑(≤maxRoadDist) 안에 남은 자리를 채운다. 각 집은
  // 가장 가까운 도로를 바라봐 방향 정합 유지 → 안길을 따라 두툼한 유기 군집이 된다.
  const maxRoadDist = site.R * 0.16 + 6;
  // 중심 편향: 작은 마을은 중심 응집, 큰 도성/읍치는 분지 전역으로 고르게 확산.
  const radExp = scale === 'capital' ? 0.62 : scale === 'town' ? 0.66 : 0.72;
  let guard = 0;
  while (parcels.length < target && guard < target * 90) {
    guard++;
    const ang = rng.range(0, Math.PI * 2);
    const rad = site.bowlR * Math.pow(rng(), radExp);      // 중심 편향(밀도↑)
    const p0 = { x: C.x + Math.cos(ang) * rad, z: C.z + Math.sin(ang) * rad };
    let best = { d: Infinity, pt: null };
    for (const r of roads) { const q = G.distToPolyline(p0, r.pts); if (q.d < best.d) best = q; }
    if (!best.pt || best.d > maxRoadDist) continue;
    const rank = rankAt(p0, 'golmok');
    const pseed = (opts.seed ^ (parcels.length * 2654435761)) >>> 0;
    const reg = regOf(rank, char01, false);
    const dims = sizeVary(dimsFor(rank, char01), reg, makeRng((pseed ^ 0x51fa) >>> 0));
    if (best.d < dims.plotD * 0.5 + 1.5) continue;         // 도로 위/침범 방지
    const frontDir = rotDir(G.norm(G.sub(best.pt, p0)), facingJitter(reg, makeRng((pseed ^ 0x77d1) >>> 0)));  // 도로 지향 + 지터
    const shape = localParcelShape(dims.plotW, dims.plotD, reg, makeRng((pseed ^ 0xa53f) >>> 0));
    const poly = worldPolyFromShape(p0, frontDir, shape.pts);
    dbg.candidates++;
    if (!validate(p0, poly, null)) continue;
    dbg.placed++;
    parcels.push({
      poly, shape, center: p0, frontDir, rank, kind: dims.kind,
      plotW: dims.plotW, plotD: dims.plotD, hero: false, seed: pseed,
    });
    placed.add(poly);
  }

  // ── R-P2 담 변별·공유(고샅 모델) ── 각 변의 이웃 근접도로 담 높이 차등 + 밀착 경계 담 1줄.
  //   앞변(도로/골목변)=높음, 이웃변(측·뒤)=낮음. 밀착(<SHARE)은 낮은 index 필지만 담을 남겨 1줄 공유.
  assignEdgeShare(parcels);

  return parcels;
}

const SHARE_DIST = 1.15;   // 이 이하로 붙은 경계 = 담 1줄 공유(중복 링 제거)
const ALLEY_DIST = 3.8;    // 이 이하 = 고샅/이웃변(담 낮춤), 이상 = 개방·거리변(담 살짝 높임)

// 각 필지 shape 변에 { role, heightK, share } 메타를 채운다(월드 poly 기준 이웃 근접 판정).
//   heightK: 앞 1.0 / 밀착 0.62 / 이웃 0.66 / 개방·거리변 0.85. share: 밀착 시 높은 index 가 담 생략.
function assignEdgeShare(parcels) {
  parcels.forEach((p, i) => { p._idx = i; });
  const nonHero = parcels.filter((p) => !p.hero && p.shape && p.poly);
  for (const P of nonHero) {
    const poly = P.poly, roles = P.shape.roles, n = poly.length;
    const sr = makeRng((P.seed ^ 0x1122b) >>> 0);
    const edges = new Array(n);
    for (let k = 0; k < n; k++) {
      const role = roles[k];
      if (role === 'front') { edges[k] = { role, heightK: 1.0, share: false }; continue; }
      const a = poly[k], b = poly[(k + 1) % n];
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      let nearest = Infinity, nearIdx = -1;
      for (const Q of nonHero) {
        if (Q === P) continue;
        const d = polyDist(m, Q.poly);
        if (d < nearest) { nearest = d; nearIdx = Q._idx; }
      }
      let heightK, share = false;
      if (nearest < SHARE_DIST) { heightK = 0.62; share = P._idx > nearIdx; }   // 밀착: 담 1줄
      else if (nearest < ALLEY_DIST) heightK = 0.66;                            // 고샅/이웃변
      else heightK = 0.85;                                                      // 개방·거리변
      heightK *= 0.97 + sr() * 0.06;                                            // 미세 편차
      edges[k] = { role, heightK, share };
    }
    P.shape.edges = edges;
  }
}
