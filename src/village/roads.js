import * as G from './geom.js';

// 2단계 도로 생성 (joseon-city.md 규칙 3·4·11·12·13·14·17).
//   1) 간선(대로·중로)은 결정론 골격 — 십자/T/남북대로. 곧게(등고 따라 완만 곡선 허용).
//   2) 이면(소로·골목)은 유기 — 간선/스파인에서 가지형으로 분기하며 등고에 순응해 휜다.
//   공통 원칙: 전역 격자는 결코 완성되지 않는다.
//
// planRoads(site, opts, rng) → { roads:[{level,width,pts}], nodes, spine }
//   level: 'daero'(17.5) | 'jungno'(5.0) | 'soro'(3.4) | 'golmok'(2.4)  — 경국대전 폭 등급

export const ROAD_WIDTH = { daero: 17.5, jungno: 5.0, soro: 3.4, golmok: 2.4 };

// 유기 경로: a→b 를 잇되 진행방향 수직으로 사인 합성 오프셋을 주어 완만히 휘게 한다.
// 양 끝은 sin(πt) 로 0 수렴 → 접합부 깔끔. amp 로 휨 세기 조절.
function organicPath(a, b, rng, { amp = 6, comps = 2 } = {}) {
  const L = G.dist(a, b);
  if (L < 1e-3) return [a, b];
  const steps = Math.max(6, Math.round(L / 5));
  const d = G.norm(G.sub(b, a));
  const perp = G.perpL(d);
  const waves = [];
  for (let k = 0; k < comps; k++) {
    waves.push({ w: (1.2 + 1.6 * k) * Math.PI / L * rng.range(0.7, 1.3), ph: rng.range(0, 6.28), a: amp * rng.range(0.5, 1) / (k + 1) });
  }
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const base = G.lerp(a, b, t);
    let off = 0;
    for (const wv of waves) off += wv.a * Math.sin(wv.w * (t * L) + wv.ph);
    off *= Math.sin(Math.PI * t);          // 끝 수렴
    pts.push(G.add(base, G.mul(perp, off)));
  }
  return pts;
}

// 곧은 간선(대로): 등고에 살짝만 순응. amp 작게.
function trunkPath(a, b, rng) { return organicPath(a, b, rng, { amp: G.dist(a, b) * 0.03, comps: 1 }); }

// 간선/스파인에서 가지 분기: 시작점·방향에서 유기 골목을 뻗는다. 분지 밖으로 나가면 자른다.
function branchPath(from, dir, len, rng, site) {
  const end = G.add(from, G.mul(G.norm(dir), len));
  const pts = organicPath(from, end, rng, { amp: len * 0.14, comps: 2 });
  // 분지(bowl) 밖으로 나가면 그 지점에서 종단
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    out.push(pts[i]);
    const r = G.dist(pts[i], site.center);
    if (r > site.bowlR * 1.02) break;
    if (site.stream && Math.abs(pts[i].z - site.streamZat(pts[i].x)) < site.streamHalf + 2) break; // 개울 침범 방지
  }
  return out.length >= 2 ? out : null;
}

export function planRoads(site, opts, rng) {
  const scale = opts.scale;
  const roads = [];
  const E = site.entrance;                 // 동구(남, 개울 북측)
  const C = site.center;                   // 명당(북, 종가/관아/궁)
  const push = (level, pts) => { if (pts && pts.length >= 2) roads.push({ level, width: ROAD_WIDTH[level], pts }); };

  const nodes = { entrance: E, center: C, crossing: null };

  if (scale === 'hamlet' || scale === 'village') {
    // ── 씨족 촌락: 안길(스파인) + 준방사 골목 (규칙 17·18) ──
    const spine = organicPath(E, C, rng, { amp: site.R * 0.06, comps: 2 });
    push('soro', spine);
    nodes.spine = spine;

    // 스파인 중간 지점들에서 좌우로 준방사 골목 분기
    const branchN = scale === 'hamlet' ? 4 : 7;
    const samples = G.resample(spine, G.polylineLength(spine) / (branchN + 1));
    let bi = 0;
    for (let s = 1; s < samples.length - 1 && bi < branchN; s++) {
      const smp = samples[s];
      const side = (bi % 2 === 0) ? 1 : -1;
      const perp = G.mul(G.perpL(smp.tan), side);
      // 위로 갈수록(중심 근처) 골목 짧게, 초입은 길게
      const len = site.R * (0.16 + 0.14 * rng());
      const dir = G.norm(G.add(perp, G.mul(smp.tan, rng.range(-0.25, 0.25))));
      push('golmok', branchPath(smp.pt, dir, len, rng, site));
      bi++;
    }
    // 중심(종가 앞)에서 좌우로 짧은 안길 — 마을이 중심 안길로 북/남촌 갈림(규칙 17)
    for (const side of [1, -1]) {
      const dir = G.mul(G.perpL(G.norm(G.sub(C, E))), side);
      push('golmok', branchPath(C, dir, site.R * 0.20, rng, site));
    }
    if (scale === 'village') {
      // 마을급: 개울과 평행한 하단 가로(동서) 하나 추가 — 논·물가 접근로
      const midZ = G.lerp(E, C, 0.28);
      const west = { x: -site.bowlR * 0.62, z: midZ.z }, east = { x: site.bowlR * 0.62, z: midZ.z };
      push('soro', organicPath(west, east, rng, { amp: site.R * 0.03, comps: 2 }));
    }
  } else if (scale === 'town') {
    // ── 읍치: 십자 또는 T 간선(규칙 14) + 유기 충전 ──
    const cross = rng() < 0.5 ? 'cross' : 'T';
    // 남북 간선: 동구 → 관아 코어(C)
    const ns = trunkPath(E, C, rng);
    push('jungno', ns);
    nodes.spine = ns;
    // 동서 간선: 관아 앞(C 남쪽 조금)에서 좌우로
    const xz = G.lerp(E, C, 0.66);
    nodes.crossing = xz;
    const ew = organicPath({ x: -site.bowlR * 0.82, z: xz.z }, { x: site.bowlR * 0.82, z: xz.z }, rng, { amp: site.R * 0.03, comps: 2 });
    push('jungno', ew);
    if (cross === 'cross') {
      // 십자: 동서 간선이 남북축을 관통(이미 관통). 추가로 관아 뒤 짧은 가로.
    }
    // 유기 골목 충전: 두 간선에서 가지 분기 — 골목 밀도↑(읍치 이면부 채움 → 도로변 프론티지 확대,
    //   #45 부정형 여파로 성겼던 town 밀도 보강). town 전용이라 타 규모 회귀 무관.
    fillGolmok(roads, [ns, ew], site, rng, 22, push);
  } else if (scale === 'capital') {
    // ── 도성풍: 남북대로 + 동서 간선 T + 피맛길 + 골목 (규칙 3·4·12·13) ──
    // 궁/관아 코어 = C(주산 남쪽 기슭). 남북대로는 궁 앞에서 남으로.
    const palaceFront = { x: 0, z: C.z + site.R * 0.13 };  // 궁 정문 앞
    const tJoin = G.lerp(palaceFront, E, 0.62);            // 동서 간선과 만나는 T 지점
    nodes.crossing = tJoin;
    nodes.palaceFront = palaceFront;
    // 남북대로(육조거리형)
    const daero = trunkPath(palaceFront, tJoin, rng);
    push('daero', daero);
    nodes.spine = daero;
    // 동서 간선(종로형) — T 지점에서 좌우로, 지형 따라 완만 곡선
    const ew = organicPath({ x: -site.bowlR * 0.92, z: tJoin.z }, { x: site.bowlR * 0.92, z: tJoin.z }, rng, { amp: site.R * 0.035, comps: 3 });
    push('daero', ew);
    // 남북대로를 T 아래로 조금 더 연장(동구까지) — 진입
    push('jungno', trunkPath(tJoin, E, rng));
    // 피맛길(규칙 12): 동서 간선 뒤(북)로 평행한 소로 1줄 — 상가 배후
    const pima = ew.map((p) => ({ x: p.x, z: p.z - (ROAD_WIDTH.daero / 2 + 4) }));
    push('soro', pima);
    // 관청 블록 좌우: 남북대로 양편 짧은 소로(관아군 접근)
    for (const side of [1, -1]) {
      for (const t of [0.35, 0.7]) {
        const smp = G.lerp(palaceFront, tJoin, t);
        const dir = G.mul(G.perpL(G.norm(G.sub(tJoin, palaceFront))), side);
        push('soro', branchPath(smp, dir, site.R * 0.18, rng, site));
      }
    }
    // 유기 골목: 동서 간선·피맛길·남북대로에서 대량 분기(북촌/남촌 채움)
    fillGolmok(roads, [ew, pima, daero], site, rng, 26, push);
  } else if (scale === 'hanyang') {
    // ── 한양 도성: 궁 앵커 + 주작대로(육조거리) + 종로 T + 사대문 연결 + 피맛길 + 북촌/남촌 중로 ──
    const W = opts.cityWall;
    const gate = (n) => (W ? W.gates.find((g) => g.name === n) : null);
    const gS = gate('south'), gN = gate('north'), gE = gate('east'), gW = gate('west');
    const palaceFront = { x: 0, z: C.z + site.R * 0.11 };   // 궁 정문 앞(주작대로 북단)
    const tJoin = { x: 0, z: C.z + site.R * 0.42 };          // 종로와 만나는 T 지점
    nodes.palaceFront = palaceFront; nodes.crossing = tJoin;
    // 주작대로(육조거리형, 최대폭): 궁 정문 → T
    const daero = trunkPath(palaceFront, tJoin, rng);
    push('daero', daero); nodes.spine = daero;
    // 종로(동서 대간선): 서문 → 동문, T 높이에서 지형 완만 곡선
    const jongW = gW ? { x: gW.x, z: tJoin.z } : { x: -site.bowlR * 0.95, z: tJoin.z };
    const jongE = gE ? { x: gE.x, z: tJoin.z } : { x: site.bowlR * 0.95, z: tJoin.z };
    const jongno = organicPath(jongW, jongE, rng, { amp: site.R * 0.03, comps: 3 });
    push('daero', jongno);
    // 남대문로: T → 숭례문(주작대로 남측 연장, 진입 척추)
    if (gS) { const s2 = trunkPath(tJoin, { x: gS.x, z: gS.z }, rng); push('jungno', s2); }
    else push('jungno', trunkPath(tJoin, E, rng));
    // 숙정문(북)은 북악 고지라 접근로가 미미 — 성벽 위 문만 두고 연결로는 생략(급경사 실선 방지).
    // 피맛길: 종로 뒤(북) 평행 소로 — 시전 배후
    const pima = jongno.map((p) => ({ x: p.x, z: p.z - (ROAD_WIDTH.daero / 2 + 4.5) }));
    push('soro', pima);
    // 육조 관청 좌우 소로(주작대로 양편, 대칭 열)
    for (const side of [1, -1]) for (const t of [0.3, 0.6, 0.85]) {
      const smp = G.lerp(palaceFront, tJoin, t);
      const dir = G.mul(G.perpL(G.norm(G.sub(tJoin, palaceFront))), side);
      push('soro', branchPath(smp, dir, site.R * 0.17, rng, site));
    }
    // 북촌 중로(궁 동서, 고지대 반가역) + 남촌 중로(종로 남, 초가 우세역)
    push('jungno', organicPath({ x: -site.bowlR * 0.74, z: C.z }, { x: site.bowlR * 0.74, z: C.z }, rng, { amp: site.R * 0.028, comps: 2 }));
    push('jungno', organicPath({ x: -site.bowlR * 0.82, z: tJoin.z + site.R * 0.19 }, { x: site.bowlR * 0.82, z: tJoin.z + site.R * 0.19 }, rng, { amp: site.R * 0.03, comps: 2 }));
    // 유기 골목 대량 분기(도성 전역 이면부 충전)
    fillGolmok(roads, roads.map((r) => r.pts), site, rng, 64, push);
  }

  return { roads, nodes };
}

// 간선들에서 골목을 가지형으로 분기해 블록 내부를 유기 충전. 등고 순응·개울/분지 밖 자름.
function fillGolmok(roads, trunks, site, rng, count, push) {
  let made = 0, guard = 0;
  while (made < count && guard < count * 6) {
    guard++;
    const trunk = trunks[Math.floor(rng() * trunks.length)];
    const smps = G.resample(trunk, 8);
    if (smps.length < 3) continue;
    const smp = smps[1 + Math.floor(rng() * (smps.length - 2))];
    const side = rng() < 0.5 ? 1 : -1;
    const perp = G.mul(G.perpL(smp.tan), side);
    const dir = G.norm(G.add(perp, G.mul(smp.tan, rng.range(-0.35, 0.35))));
    const len = site.R * (0.10 + 0.12 * rng());
    const p = branchPath(smp.pt, dir, len, rng, site);
    if (p) { push('golmok', p); made++; }
  }
}
