import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { injectCloudShadow } from '../builder/palette.js';
import {
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from '../env/clouds.js';

// 한국 산(#113) — 금강산·설악산 화강암 산의 산수화 스타일라이즈 번역.
//   레퍼런스(refs/mountains) 형태 어휘:
//     ① 숲 = 사면을 빈틈없이 덮는 연속 벨벳 카펫(잔 수관 그레인, 짙은 채도 녹). 민둥 구멍 없음.
//     ② 바위 = 숲을 뚫고 "솟구치는" 수직 화강암 암봉/암릉(뾰족 탑, 캐노피 위로 우뚝). 반쯤 묻힌 둥근
//        바위가 아니라 캐노피 위 수직 프로미넌스 — 겸재 정선 진경산수가 스타일라이즈 중간 지점(창백한
//        뾰족 암봉 군집 + 짙은 먹 숲). ③ 능선 스카이라인: 뾰족 암봉 + 둥근 숲 능선 교대. ④ 숲/바위
//        대비: 밝은 회백 vs 짙은 녹, 선명.
//   계절은 "산이 선도"(사용자): 캐노피 정점색 4계절 버퍼 — 가을은 적·주황·황·녹 모자이크(위쪽부터
//     물듦), 봄은 신록+산비탈 진달래 분홍 패치(bloom.js 진달래와 색 정합·먼 읽기 담당), 겨울 갈회+상록
//     패치. setSeason(name, k01) 은 선도 크로스페이드(#50) 훅(하위호환, 미배선).
//
// 구성: 캐노피 쉘 1 병합 메시(1 드로우콜) + 화강암 암봉 1 InstancedMesh(1 드로우콜) = 신규 +2.
//   지형 규약(scatterTrees·bloom 동일): 공유 warp + 격자 이중선형 onMesh(#86 부유차단), 나무 mask 재사용.
//   전용 rng(plan.seed 파생, 공유 시퀀스 불침해 → determinism).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const M4 = () => new THREE.Matrix4();

// ───────────────────────── 튜닝 상수(#109/#113 시각 라운드 조정점) ─────────────────────────
// 캐노피 쉘
const CANOPY_FLOOR = 1.5;    // 숲 가장자리 최소 부유고(지형 z-fight 방지 + 검증 [1,수관] 하한)
const CANOPY_H     = 5.2;    // 빽빽한 수관 상면 기준 높이(지형 위)
const CANOPY_BUMP  = 2.3;    // 수관 요철 진폭(주 파장) — flatShading 파세트로 육안 수관 덩어리
const CANOPY_WAVE  = 6.5;    // 수관 요철 주 파장(m, 6~10 범위) — 개별 수관 덩어리 스케일
const CANOPY_GRAIN = 1.55;   // 잔 수관 그레인 진폭(보조 파장 ~3m) — 벨벳 알갱이(파세트가 서로 기울게)
const FRINGE_SPIKE = 1.2;    // 숲 아래 경계(치마) 크라운 스파이크
const CANOPY_MAX   = 8.9;    // 최종 부유고 상한(검증 [1,수관] 상한 — 범프 상향 반영)
const HILL_MIN     = 0.085;  // hillAt 이 이 아래면 분지 평지 → 숲 없음
const GROVE_FLOOR  = 0.86;   // 숲 밀도 baseline(1.0에 가깝게 = 연속 벨벳, 민둥 구멍 방지)

// 화강암 암봉(솟구치는 수직 타워 InstancedMesh) — 능선 상부에 군집(암릉), 굵은 덩어리로 캐노피를 뚫음.
const SPIRE_SLOPE_LO = 0.45;  // 이 경사(|∇h|)부터 암봉 배치 시작
const SPIRE_SLOPE_HI = 1.15;
const SPIRE_HILL_MIN = 0.48;  // 이 고도(hillAt) 이상 상부 사면·능선(중턱 이빨 방지 — 상부 집중)
const SPIRE_TARGET_K = 15;    // 암봉 목표 밀도 계수((TR/150)^2 * K) — 소수·큰 덩어리
const SPIRE_H_MIN = 8;        // 최소 암봉 높이(m) — 캐노피(~5m) 위로 확실히 솟음
const SPIRE_H_MAX = 34;       // 최대(상부·급경사 = 큰 암봉)
const SPIRE_SINK = 3.2;       // 밑동 매립(캐노피에서 자연스레 솟게, 떠 보임 방지)

// 화강암 톤(밝은 회백) — 짙은 녹 숲과 대비. terrain 경사 블렌드도 공유(populate 가 import).
export const GRANITE = 0xa5a29a;
const GRANITE_COL = linCol(GRANITE);

// ───────────────────────── 결정론 value-noise ─────────────────────────
function makeNoise(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512), base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = base[i]; base[i] = base[j]; base[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const lat = (ix, iz) => perm[(perm[ix & 255] + (iz & 255)) & 255] / 255;
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const v00 = lat(x0, z0), v10 = lat(x0 + 1, z0), v01 = lat(x0, z0 + 1), v11 = lat(x0 + 1, z0 + 1);
    const sx = sm(fx), sz = sm(fz);
    const a = v00 + (v10 - v00) * sx, b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sz;
  };
}

// ───────────────────────── 지형 메시면 샘플러 ─────────────────────────
function makeTerrainSampler(site, warp) {
  const TR = site.terrainR || site.R;
  const N = Math.max(150, Math.min(260, Math.round(TR / 1.4)));
  const cache = new Map();
  const vert = (i, j) => {
    const key = i * (N + 3) + j;
    let v = cache.get(key);
    if (!v) {
      const gx = -TR + (2 * TR) * (i / N), gz = -TR + (2 * TR) * (j / N);
      const [wx, wz] = warp(gx, gz);
      v = { x: wx, z: wz, y: site.heightAt(wx, wz) };
      cache.set(key, v);
    }
    return v;
  };
  const onMesh = (gu, gv) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor(gu))), j = Math.min(N - 1, Math.max(0, Math.floor(gv)));
    const fu = gu - i, fv = gv - j;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    const lx = (p, q) => p + (q - p) * fu;
    const k = (key) => lx(a[key], b[key]) + (lx(c[key], d[key]) - lx(a[key], b[key])) * fv;
    return { x: k('x'), y: k('y'), z: k('z') };
  };
  return { N, onMesh };
}
function makeSlopeAt(site) {
  const d = 2.0;
  return (x, z) => {
    const hx = (site.heightAt(x + d, z) - site.heightAt(x - d, z)) / (2 * d);
    const hz = (site.heightAt(x, z + d) - site.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  };
}

// ───────────────────────── 계절 정점색(모자이크) ─────────────────────────
// 산이 계절 선도. 정점별로 색을 정해 material.color(흰색) × 정점색 = 최종. 4버퍼 사전계산 후 스왑.
const SP = {
  // 여름: 짙은 채도 녹(deep→mid 변주)
  sumDeep: linCol(0x3c5a24), sumMid: linCol(0x53742e), sumDark: linCol(0x2c471d),
  // 봄: 신록(밝은 연둣빛) + 진달래 분홍
  sprA: linCol(0x74a038), sprB: linCol(0x93bb56), azalea: linCol(0xcf5e97),
  // 가을: 모자이크(녹→황→주→적) — 위쪽부터 물들되 주황·황이 섞인 다채로운 사면(순빨강 아님)
  auGreen: linCol(0x5c7030), auGold: linCol(0xd9a634), auOrange: linCol(0xd0691c), auRed: linCol(0xb64b22), auCrim: linCol(0xa14328),
  // 겨울: 갈회 + 상록(소나무) 패치
  winBrown: linCol(0x877c60), winGrey: linCol(0x9a927b), winEver: linCol(0x3b5030),
};
function seasonColorInto(season, hill, cover, n1, n2, nf, out) {
  const lum = 0.74 + 0.44 * n1;            // 수관별 휘도(점묘) — 큰 스윙 + 고주파(n1=수관 스케일)로 이웃 대비
  if (season === 'spring') {
    out.copy(SP.sprA).lerp(SP.sprB, n2);
    // 진달래 분홍 패치: 하~중 사면(bloom 진달래 밴드)의 성긴 군락 — 먼 읽기.
    const azBand = smoothstep(0.06, 0.16, hill) * (1 - smoothstep(0.40, 0.60, hill));
    const azMask = azBand * smoothstep(0.66, 0.86, nf);
    out.lerp(SP.azalea, azMask * 0.75);
    out.multiplyScalar(lum);
  } else if (season === 'autumn') {
    // 위쪽(hill↑)일수록 붉게(계절 선도)하되, 패치 변주(n2·nf)가 주도해 주황·황이 섞인 모자이크.
    //   순빨강 사면 방지: elevation bias 는 완만한 밀어올림, 색은 패치가 지배.
    const bias = smoothstep(0.22, 0.78, hill);
    const t = 0.6 * n2 + 0.34 * bias + 0.34 * (nf - 0.5);
    if (t < 0.34) out.copy(SP.auGreen).lerp(SP.auGold, smoothstep(0.10, 0.34, t));
    else if (t < 0.58) out.copy(SP.auGold).lerp(SP.auOrange, smoothstep(0.34, 0.58, t));
    else if (t < 0.80) out.copy(SP.auOrange).lerp(SP.auRed, smoothstep(0.58, 0.80, t));
    else out.copy(SP.auRed).lerp(SP.auCrim, smoothstep(0.80, 1.0, t));
    out.multiplyScalar(0.9 + 0.24 * n1);
  } else if (season === 'winter') {
    out.copy(SP.winBrown).lerp(SP.winGrey, n1);
    const ever = smoothstep(0.42, 0.14, n2);   // n2 낮은 곳 = 상록 소나무 잔존
    out.lerp(SP.winEver, ever * 0.55);
    out.multiplyScalar(0.88 + 0.14 * nf);
  } else { // summer
    out.copy(SP.sumDeep).lerp(SP.sumMid, n2);
    out.lerp(SP.sumDark, (1 - nf) * 0.35);     // 잔 그레인 음영
    out.multiplyScalar(lum);
  }
  return out;
}

// ───────────────────────── 캐노피 쉘 ─────────────────────────
function buildCanopyShell(site, sampler, slopeAt, mask, cloudU, seed, densityK) {
  const TR = site.terrainR || site.R;
  const C = site.center, bowlR = site.bowlR;
  const { N, onMesh } = sampler;

  const grove = makeNoise((seed ^ 0x0f0e57) >>> 0);
  const bumpN1 = makeNoise((seed ^ 0x1b0a01) >>> 0);
  const bumpN2 = makeNoise((seed ^ 0x2c0b02) >>> 0);
  const grainN = makeNoise((seed ^ 0x4e0d04) >>> 0);
  const tintN = makeNoise((seed ^ 0x3d0c03) >>> 0);
  const patchN = makeNoise((seed ^ 0x5f0e05) >>> 0);
  const CF = 1 / 58;

  // 연속 벨벳 숲: 분지 밖 사면을 빈틈없이 덮는다(민둥 구멍 방지). 암봉이 캐노피를 뚫고 솟으므로
  //   급경사에서도 캐노피는 그대로 유지 — 감산하면 암봉 밑동 주변이 노출돼 암봉이 떠 보인다(#113 R2).
  const coverAt = (x, z, hill, slope) => {
    if (hill < HILL_MIN) return 0;
    const rC = Math.hypot(x - C.x, z - C.z);
    const outBand = smoothstep(bowlR * 0.82, bowlR * 1.02, rC);
    if (outBand <= 0) return 0;
    const g = GROVE_FLOOR + (1 - GROVE_FLOOR) * smoothstep(0.3, 0.75, grove(x * CF, z * CF));
    return clamp(outBand * g * densityK, 0, 1);
  };
  const liftAt = (x, z, cover) => {
    const base = CANOPY_FLOOR + (CANOPY_H - CANOPY_FLOOR) * smoothstep(0.0, 0.55, cover);
    const b = (bumpN1(x / CANOPY_WAVE, z / CANOPY_WAVE) * 0.6 + bumpN2(x / (CANOPY_WAVE * 2.4) + 5, z / (CANOPY_WAVE * 2.4) - 3) * 0.4) - 0.5;
    const bump = b * 2 * CANOPY_BUMP * smoothstep(0.08, 0.4, cover);
    const grain = (grainN(x / 3.4, z / 3.4) - 0.5) * 2 * CANOPY_GRAIN * smoothstep(0.12, 0.4, cover); // 잔 수관 알갱이
    const fr = smoothstep(0.06, 0.26, cover) * (1 - smoothstep(0.26, 0.5, cover));
    const spike = fr * FRINGE_SPIKE * Math.max(0, bumpN1(x / 5.0 + 17, z / 5.0 - 9) - 0.35);
    return clamp(base + bump + grain + spike, 1.05, CANOPY_MAX);
  };

  const cell = clamp(TR / 74, 3.2, 7.4);
  const NS = Math.max(52, Math.min(156, Math.round(2 * TR / cell)));
  const edge = site.edge;

  const pos = [], edgeK = [], covArr = [];
  const idx = [];
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  const colBuf = { spring: [], summer: [], autumn: [], winter: [] };
  const tmpC = new THREE.Color();
  for (let i = 0; i <= NS; i++) {
    for (let j = 0; j <= NS; j++) {
      const gu = (i / NS) * N, gv = (j / NS) * N;
      const p = onMesh(gu, gv);
      const hill = site.hillAt(p.x, p.z);
      const slope = slopeAt(p.x, p.z);
      let cover = coverAt(p.x, p.z, hill, slope);
      if (mask && mask(p.x, p.z)) cover = 0;
      const lift = liftAt(p.x, p.z, cover);
      pos.push(p.x, p.y + lift, p.z);
      edgeK.push(edge ? edge.edgeK(p.x, p.z) : 0);
      covArr.push(cover);
      const n1 = tintN(p.x * 0.3 + 3, p.z * 0.3 - 7);      // ~3.3m 수관 스케일 휘도 dither(이웃 파세트 대비)
      const n2 = patchN(p.x * 0.045 - 4, p.z * 0.045 + 9); // ~22m 수종/향 패치(색상)
      const nf = grainN(p.x * 0.3, p.z * 0.3);
      for (const s of seasons) { seasonColorInto(s, hill, cover, n1, n2, nf, tmpC); colBuf[s].push(tmpC.r, tmpC.g, tmpC.b); }
    }
  }
  const gi = (i, j) => i * (NS + 1) + j;
  const COVER_MIN = 0.1;
  for (let i = 0; i < NS; i++) for (let j = 0; j < NS; j++) {
    const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
    const mx = Math.max(covArr[a], covArr[b], covArr[c], covArr[d]);
    if (mx < COVER_MIN) continue;
    idx.push(a, b, c, b, d, c);   // 상향 법선(buildSiteTerrain 동일 와인딩)
  }
  if (!idx.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const colArrays = {};
  for (const s of seasons) colArrays[s] = new Float32Array(colBuf[s]);
  geo.setAttribute('color', new THREE.BufferAttribute(colArrays.summer.slice(), 3));  // 라이브 버퍼(스왑/블렌드)
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeK, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // flatShading: 각 삼각형이 평면 노멀 → 범프가 뭉개지지 않고 수관 파세트(덩어리)로 육안에 읽힘(#113 R4).
  //   정점색은 여전히 보간되지만 파세트가 평면 음영이라 이웃 파세트 명도 dither 가 점묘로 드러난다.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.97, metalness: 0, flatShading: true });
  const uEdgeHaze = { value: new THREE.Vector3(0.8, 0.8, 0.85) };
  const useCloud = !!cloudU;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeHazeV = uEdgeHaze;
    if (useCloud) {
      shader.uniforms.uCloudTime = cloudU.uCloudTime;
      shader.uniforms.uCloudStr = cloudU.uCloudStr;
      shader.uniforms.uCloudBlobs = cloudU.uCloudBlobs;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aEdge;\nvarying float vEdgeF;\n${useCloud ? CLOUD_SHADOW_VERT_DECL : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvEdgeF = aEdge;\n${useCloud ? CLOUD_SHADOW_VERT_BODY : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uEdgeHazeV;\nvarying float vEdgeF;\n${useCloud ? CLOUD_SHADOW_FRAG_DECL : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${useCloud ? CLOUD_SHADOW_FRAG_BODY : ''}
        {
          float e = smoothstep(0.12, 1.0, vEdgeF);
          diffuseColor.rgb = mix(diffuseColor.rgb, uEdgeHazeV, 0.620 * e);
        }`);
  };
  mat.customProgramCacheKey = () => 'forest-shell';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'forest-shell';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const colAttr = geo.getAttribute('color');
  let shown = 'summer';
  // 계절 스왑 + 선도 크로스페이드 훅(#50): k01<1 이면 이전(shown)→name 정점색 lerp(현재 미배선).
  const setSeason = (name, k01 = 1) => {
    if (!(name in colArrays)) name = 'summer';
    if (k01 >= 1 || name === shown) { colAttr.array.set(colArrays[name]); shown = name; }
    else {
      const from = colArrays[shown], to = colArrays[name], out = colAttr.array;
      for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * k01;
    }
    colAttr.needsUpdate = true;
  };
  const setHaze = (c) => { if (c) uEdgeHaze.value.set(c.r, c.g, c.b); };
  return { mesh, setSeason, setHaze, mat, vertexCount: pos.length / 3, faceCount: idx.length / 3, colArrays };
}

// ───────────────────────── 화강암 암봉 프로토(수직 타워 군집) ─────────────────────────
// 단위 높이 1·기저 반경 ~0.5 의 뾰족 타워 2~3개 병합(군집=암릉). 정점 방사·수직 지터로 crag 파세트,
//   상단은 뾰족(뿔). 밑면 y=0. 인스턴스에서 (rW, H, rW) 스케일 + 약간 기울임으로 솟구치는 암봉.
function makeSpireProto(seed) {
  const rng = makeRng(seed);
  const parts = [];
  const nSpire = 2 + ((rng() * 2) | 0);                     // 2~3 암주 군집(암릉)
  for (let k = 0; k < nSpire; k++) {
    const hk = k === 0 ? 1.0 : rng.range(0.45, 0.8);        // 주봉 1 + 부봉(어깨)
    const sides = 5 + ((rng() * 3) | 0);                    // 5~7 각(각진 암체)
    const baseR = rng.range(0.5, 0.62) * (0.75 + 0.25 * hk); // 굵은 기저(가는 바늘 아님)
    const topR = baseR * rng.range(0.28, 0.42);             // 뭉툭~뾰족 상단(덩어리감)
    const g = new THREE.CylinderGeometry(topR, baseR, hk, sides, 4, false);
    g.translate(0, hk / 2, 0);                              // 밑면 y=0
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
      const ny = y / hk;                                    // 0(밑)~1(상단)
      // 강한 수직 파세트(각진 암주) + 위로 갈수록 살짝 좁아짐.
      const ang = Math.atan2(z, x);
      const facet = 0.72 + 0.4 * (Math.sin(ang * sides * 0.5 + k) * 0.5 + 0.5);
      const jit = 0.82 + 0.34 * rng();
      const rr = facet * jit * (1 - 0.12 * ny);
      p.setXYZ(v, x * rr, y + (rng() - 0.5) * 0.03, z * rr);
    }
    // 군집 배치 오프셋 + 살짝 기울임(레퍼런스의 기운 암봉).
    g.rotateZ((rng() - 0.5) * 0.24); g.rotateX((rng() - 0.5) * 0.2);
    g.translate((rng() - 0.5) * 0.9, 0, (rng() - 0.5) * 0.9);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  merged.computeBoundingBox();
  merged.translate(0, -merged.boundingBox.min.y, 0);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  return merged;
}

// ───────────────────────── 화강암 암봉(InstancedMesh) ─────────────────────────
// 급경사·능선 상부에 숲을 뚫고 솟는 수직 암봉. instanceColor 회백 변주. 반환 { mesh, anchors, count }.
function buildGraniteSpires(site, sampler, slopeAt, mask, cloudU, seed, densityK) {
  const TR = site.terrainR || site.R;
  const C = site.center, bowlR = site.bowlR;
  const { N, onMesh } = sampler;
  const rng = makeRng((seed ^ 0x60c17a) >>> 0);
  const clump = makeNoise((seed ^ 0x71d18b) >>> 0);
  const CF = 1 / 64;   // 큰 군집 파장 — 암봉이 능선 몇 군데 암릉으로 뭉침(균일 이빨 방지)

  const hidden = (x, z, yHere) => {
    const dx = x - C.x, dz = z - C.z;
    let mx = -Infinity;
    for (let t = 1; t <= 4; t++) { const s = t / 5, h = site.heightAt(C.x + dx * s, C.z + dz * s); if (h > mx) mx = h; }
    return mx > yHere + 6;   // 암봉은 높아 웬만한 능선 위로 솟음 → 관대한 가림 임계
  };
  const chance = (x, z, hill, slope) => {
    if (hill < SPIRE_HILL_MIN) return 0;
    const rC = Math.hypot(x - C.x, z - C.z);
    const outBand = smoothstep(bowlR * 0.9, bowlR * 1.16, rC);
    const hi = smoothstep(SPIRE_HILL_MIN, 0.82, hill);
    const st = smoothstep(SPIRE_SLOPE_LO, SPIRE_SLOPE_HI, slope);
    const prom = Math.max(hi, st * 0.85);                   // 상부 또는 급경사(상부 우선)
    const cl = smoothstep(0.52, 0.82, clump(x * CF, z * CF)); // 군집(암릉) 강하게 게이트
    return outBand * prom * (0.08 + 0.92 * cl);             // 군집 밖은 거의 0 → 능선 몇 군데로 뭉침
  };

  const target = Math.min(TR > 480 ? 200 : 150, Math.round((TR / 150) ** 2 * SPIRE_TARGET_K * densityK));
  const mats = [], colors = [], anchors = [];
  const minD = 9.0;
  const grid = new Map();
  const gkey = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = grid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };
  let attempts = 0, ridgeCount = 0;
  while (mats.length < target && attempts < target * 34) {
    attempts++;
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const hill = site.hillAt(p.x, p.z);
    const slope = slopeAt(p.x, p.z);
    if (rng() > chance(p.x, p.z, hill, slope)) continue;
    if (mask && mask(p.x, p.z)) continue;
    if (tooClose(p.x, p.z)) continue;
    // 암봉 높이: 상부·급경사일수록 큰 암봉(캐노피 위로 우뚝).
    const prom = Math.max(smoothstep(SPIRE_HILL_MIN, 0.85, hill), smoothstep(SPIRE_SLOPE_LO, SPIRE_SLOPE_HI, slope));
    const H = (SPIRE_H_MIN + (SPIRE_H_MAX - SPIRE_H_MIN) * prom) * rng.range(0.78, 1.18);
    if (hidden(p.x, p.z, p.y + H * 0.5)) continue;
    const slender = rng.range(0.26, 0.4);                    // 굵은 덩어리(가는 바늘 아님)
    const rW = H * slender;                                  // 기저 반폭
    const xz = rW / 0.55;                                    // 프로토 기저 반경 ~0.55 기준
    const sink = SPIRE_SINK + slope * 1.6;                   // 깊이 박아 캐노피에서 솟게(떠 보임 방지)
    const y = p.y - sink;
    const m = M4().makeTranslation(p.x, y, p.z)
      .multiply(M4().makeRotationY(rng() * Math.PI * 2))
      .multiply(M4().makeScale(xz, H, xz));
    mats.push(m);
    const l = 0.8 + rng() * 0.24;                            // 화강암 회백(톤다운 — blowout 방지)
    const c = GRANITE_COL.clone().multiplyScalar(l);
    c.r *= 1 + (rng() - 0.5) * 0.05; c.b *= 1 + (rng() - 0.5) * 0.05;
    colors.push(c);
    anchors.push({ x: p.x, y, z: p.z, h: H, sink, hill });
    if (hill > 0.7) ridgeCount++;
    { const k = gkey(p.x, p.z); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push({ x: p.x, z: p.z }); }
  }
  if (!mats.length) return null;

  const proto = makeSpireProto((seed ^ 0x5a17c0) >>> 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true });
  injectCloudShadow(mat, cloudU);
  const inst = new THREE.InstancedMesh(proto, mat, mats.length);
  for (let i = 0; i < mats.length; i++) { inst.setMatrixAt(i, mats[i]); inst.setColorAt(i, colors[i]); }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.name = 'forest-rocks';
  inst.castShadow = true; inst.receiveShadow = true;
  inst.frustumCulled = false;
  return { mesh: inst, anchors, count: mats.length, ridgeCount };
}

// ───────────────────────── 최상위 ─────────────────────────
export function buildForest(plan, site, warp, mask, cloudU) {
  const group = new THREE.Group(); group.name = 'village-forest';
  const seed = ((plan.seed || 0) ^ 0x0f03e5) >>> 0;
  const tuning = (plan.opts && plan.opts.tuning) || {};
  const forestK = clamp(tuning.forestDensityK != null ? tuning.forestDensityK : 1, 0, 1.6);
  const rockK = clamp(tuning.rockDensityK != null ? tuning.rockDensityK : 1, 0, 2);

  const sampler = makeTerrainSampler(site, warp);
  const slopeAt = makeSlopeAt(site);

  const shell = buildCanopyShell(site, sampler, slopeAt, mask, cloudU, (seed ^ 0xa1) >>> 0, forestK);
  if (shell) group.add(shell.mesh);
  const rocks = buildGraniteSpires(site, sampler, slopeAt, mask, cloudU, (seed ^ 0xb2) >>> 0, rockK);
  if (rocks) group.add(rocks.mesh);

  let drawCalls = 0;
  if (shell) drawCalls++;
  if (rocks) drawCalls++;

  const setSeason = (name, k01 = 1) => { shell?.setSeason(name, k01); };
  const setHaze = (c) => { shell?.setHaze(c); };
  setSeason('summer');

  group.userData = {
    drawCalls,
    shellVertexCount: shell ? shell.vertexCount : 0,
    shellFaceCount: shell ? shell.faceCount : 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
    setSeason, setHaze,
  };
  return {
    group, setSeason, setHaze, drawCalls,
    shellVertexCount: shell ? shell.vertexCount : 0,
    shellFaceCount: shell ? shell.faceCount : 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
  };
}
