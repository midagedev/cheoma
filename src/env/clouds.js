import { smoothstep } from '../core/math/scalar.js';
import { disposeObjectTree } from '../core/three-resources.js';
import { edgeMistViewWeight, ridgeMistViewWeight } from './edge-mist-view.js';
import * as THREE from 'three';

// 산 구름·물안개 + 흐르는 구름 그림자 (태스크 #51 축② → #68 재설계로 형태·대응 강화).
//   setupClouds(group, { sun, edge, terrainMax }) → { group, uniforms, update(dt), setEnabled }
//
// 구성:
//   - 상공 뭉게구름 최대 5장: 카메라를 보는 알파 빌보드(적운 텍스처 — 평평한 바닥·봉긋한 상부·상단
//     밝음/하단 그늘 베이크). 마을·씬 중앙 상공에 배치돼 표류하며 지면에 그림자를 드리운다.
//   - 원경 구름 링 1 draw call: 월드 방위에 고정된 16개 인스턴스가 카메라 이동만 따라가므로
//     줌 화각에서도 빈 하늘이 되지 않는다. 같은 태양 상태로 HDR 림과 틈새 빛줄기를 만든다.
//   - 산허리 물안개 2장: 능선을 감는 넓고 낮은 소프트 플레인(수평), 함께 표류.
//   - 구름 그림자: 각 빌보드의 실제 위치를 태양 방향으로 지면에 투영한 XZ 를 블롭 uniform(uCloudBlobs)에
//     기록 → 지형 재질(onBeforeCompile)이 그 블롭들의 가우시안 합을 감산. 빌보드와 "정확히 대응"해
//     함께 흐른다("저 구름의 그림자"로 읽힘). 이전엔 fbm 스크롤이라 빌보드와 무관했다.
//
// 시간대: 태양 상태(sun.position 방향·sun.color·sun.intensity)를 매 프레임 읽어 구름 라이팅·
//   그림자 세기를 산출한다(하드코딩 시간표 없음 → #50 환경 트윈 전환 중에도 자동 정합).
// shot 모드(?shot=1): 표류 t=0 고정(결정론). ?clouds=0: 옵트아웃(빌보드·그림자 모두 정지·소등).

const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const SHOT = q.get('shot') === '1';
const CLOUDS_ON = q.get('clouds') !== '0';
const NOOP_BEFORE_RENDER = () => {};

// 지형/지면 재질이 공유하는 구름 그림자 uniform. index.js 가 만들어 buildTerrain 과 setupClouds
// 양쪽에 넘긴다(물 uniform 공유 패턴과 동일). 값은 setupClouds.update 가 매 프레임 갱신.
//
// #68 재설계: 그림자는 이제 상공 구름 빌보드와 "구조적으로 대응"한다. 빌보드의 실제 월드 위치를
//   태양 방향으로 지면에 투영한 XZ 를 블롭 uniform(uCloudBlobs)에 매 프레임 기록 → 지형 재질이
//   그 블롭들의 가우시안 합을 감산. 빌보드가 표류하면 블롭도 함께 이동 → "저 구름의 그림자"로 읽힘.
//   (이전엔 빌보드=사인표류·그림자=fbm스크롤 로 완전히 무관했다.)
export const MAX_CLOUD_BLOBS = 5;                    // 셰이더 언롤 상수(동적 인덱싱 금지 함정 회피)
export function createCloudUniforms() {
  const blobs = [];
  for (let i = 0; i < MAX_CLOUD_BLOBS; i++) blobs.push(new THREE.Vector4(0, 0, 0, 0));
  return {
    uCloudTime: { value: 0 },                        // 표류 누적 시계(초) — 그림자 가장자리 흔들림용
    uCloudStr: { value: 0 },                          // 그림자 전역 세기 0..1 (시간대 연동)
    // xy = 지면 투영 XZ 중심, z = 반경(월드 단위), w = 블롭 세기(0 = 비활성). update 가 매 프레임 채움.
    uCloudBlobs: { value: blobs },
  };
}

// ── 지형 재질 fragment 에 삽입할 구름 그림자 GLSL 조각 (terrain.js 가 import) ──
// #221 / look-audit U5: 예전 하드 플레이트(반경 42%까지 평탄 암부 원반 + 가파른 rim)는
//   샷 모드(t=0)에서 마을 레인 배치 블롭 4장이 겹치면 지면에 "기하 줄무늬 띠"로 읽혔다.
//   원인은 shadow-map cascade/texel 이 아니라 이 구름 발자국 프로필. 중심 피크 + 제곱 감쇠로
//   연속 그라디언트를 주고, 가장자리 fbm 은 숨만 쉬게 줄여 띠 윤곽을 깨지 않는다.
//   태양 평행 그림자(DirectionalLight shadow map)는 건드리지 않는다.
export const CLOUD_SHADOW_FRAG_DECL = `
uniform float uCloudTime; uniform float uCloudStr;
uniform vec4 uCloudBlobs[${MAX_CLOUD_BLOBS}];   // xy=지면중심 z=반경 w=세기
varying vec3 vCloudWorld;
float csHash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p, p+34.345); return fract(p.x*p.y); }
float csNoise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float a=csHash(i),b=csHash(i+vec2(1.,0.)),c=csHash(i+vec2(0.,1.)),d=csHash(i+vec2(1.,1.));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float csFbm(vec2 p){ float v=0.,a=0.55; for(int i=0;i<4;i++){ v+=a*csNoise(p); p=p*2.03+7.1; a*=0.5;} return v; }
// Soft cumulus footprint: peak at centre, continuous gradient, no hard plateau disc.
// #50 B (P1' dawn verdict 2026-08-01: 산 중턱 그늘이 "부드러운 사각 판"): the radial profile was
//   already soft, but the footprint was a **circle**, and five circles summed then clamped read as
//   one rounded slab. So the distance is measured in a deformed frame instead:
//     ① per-slot rotated basis — derived from the unroll index, never from b.xy. A centre-derived
//        hash would repick every time the drifting blob crossed a hash cell and pop the outline.
//        The slot argument is a literal at every call site, so the basis constant-folds away.
//     ② area-preserving elongation (1.28 × 0.80 ≈ 1) so no slot is a circle to begin with.
//     ③ blob-local trig fold — travels rigidly with the blob (this is "저 구름의 그림자"), bends
//        the outline into lobes rather than displacing it.
//     ④ shared world-space warp vectors, rotated into each slot's basis. Sampled once per
//        fragment in the body below and only rotated here, so five differently-lobed footprints
//        cost two noise taps, not ten. Overlapping slots therefore never share an outline.
//   The radial falloff itself is untouched (soft centre peak, squared rim) — this is shape, not
//   attenuation, so the continuity contract with the terrain is unchanged.
float cloudBlob(vec4 b, vec2 wp, float wob, vec2 w1, vec2 w2, float slot){
  if (b.z < 0.5) return 0.0;                     // 비활성 슬롯
  vec2 d = (wp - b.xy) / b.z;                    // 0=중심 .. ~1=반경끝
  float ang = 6.2831853 * csHash(vec2(slot * 13.7 + 3.1, slot * 7.3 + 1.9));
  vec2 ex = vec2(cos(ang), sin(ang)), ey = vec2(-ex.y, ex.x);
  vec2 q = vec2(dot(d, ex) * 1.28, dot(d, ey) * 0.80);
  // Deform the outline, not the core. Warping uniformly displaced the centre too, and since the
  //   0.5 iso-contour sits at only |q|≈0.32 the core came apart — measured iso-0.5 radial CV 1.02,
  //   i.e. a shadow with holes punched in it. Ramping by |q| keeps one coherent dark centre and
  //   spends the deformation where the silhouette is actually read.
  float lobe = smoothstep(0.14, 0.55, length(q));
  q += lobe * (0.10 * vec2(sin(q.y * 2.7 + slot * 2.1), sin(q.x * 3.1 + slot * 4.7))
    + vec2(dot(w1, ex), dot(w1, ey)) * 0.29 + vec2(dot(w2, ex), dot(w2, ey)) * 0.12);
  float r = max(0.0, length(q) + wob);
  float a = 1.0 - smoothstep(0.0, 1.12, r);
  return b.w * a * a;                            // 제곱 감쇠 → 코어는 살아 있고 rim 은 부드럽게
}
`;
// color_fragment '뒤'(최종 색)에 얹는 감산 — 계절·적설·들판 금빛이 다 적용된 색을 어둡게.
//   블롭 5개를 상수 인덱스로 언롤(동적 인덱싱 금지). 가장자리 숨결은 저주파 fbm 으로 공용.
export const CLOUD_SHADOW_FRAG_BODY = `
{
  vec2 wp = vCloudWorld.xz;
  // Mild edge breath only (±0.08). Stronger wobble + hard plateau used to carve concentric
  // ring / stripe contours across the courtyard under frozen shot clocks.
  float wob = (csFbm(wp * 0.007 + uCloudTime * 0.003) - 0.5) * 0.16;
  // Shape vectors for cloudBlob ④ — two scales: the first bends the outline into lobes, the
  //   second crenellates it. Sampled once here and rotated per slot, so cost is independent of
  //   MAX_CLOUD_BLOBS. Drift is ~500 s per period (near-static field) — the visible morph comes
  //   from the blob travelling through it, which is what an evolving cloud edge looks like.
  vec2 wdr = vec2(uCloudTime * 0.0021, uCloudTime * -0.0013);
  vec2 w1 = vec2(csNoise(wp * 0.0094 + wdr), csNoise(wp * 0.0094 + wdr + 37.19)) - 0.5;
  vec2 w2 = vec2(csNoise(wp * 0.0295 + wdr), csNoise(wp * 0.0295 + wdr + 11.73)) - 0.5;
  // Multiplicative union. The additive sum clamped at 1.0 flattened every overlap into a
  //   saturated slab with a soft outline — that slab is what read as a plate, not the falloff.
  //   A product union keeps each lobe's own gradient and can never plateau.
  float shade = 1.0
    - (1.0 - cloudBlob(uCloudBlobs[0], wp, wob, w1, w2, 0.0))
    * (1.0 - cloudBlob(uCloudBlobs[1], wp, wob, w1, w2, 1.0))
    * (1.0 - cloudBlob(uCloudBlobs[2], wp, wob, w1, w2, 2.0))
    * (1.0 - cloudBlob(uCloudBlobs[3], wp, wob, w1, w2, 3.0))
    * (1.0 - cloudBlob(uCloudBlobs[4], wp, wob, w1, w2, 4.0));
  shade = clamp(shade, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - uCloudStr * shade;
}
`;
export const CLOUD_SHADOW_VERT_DECL = `varying vec3 vCloudWorld;`;
// 그림자 블롭은 월드 XZ 로 판정하므로 정점의 월드 좌표가 필요하다. 인스턴싱(#110 지붕·부재:
//   집은 InstancedMesh)에서는 각 인스턴스가 자기 instanceMatrix 를 가지므로 modelMatrix 만으로는
//   모든 인스턴스가 같은 자리로 접혀 그림자가 부정확했다 → USE_INSTANCING 시 instanceMatrix 를
//   합성한다. 지형·병합(merged) 지오는 인스턴싱이 아니라 #else(=기존 modelMatrix 경로) 그대로라
//   완전 하위호환(#include <begin_vertex> 삽입점에서 transformed=오브젝트 로컬, instanceMatrix 는
//   three 가 USE_INSTANCING 시 선언).
export const CLOUD_SHADOW_VERT_BODY = `
#ifdef USE_INSTANCING
  vCloudWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
`;

// 소프트 원형 구름 텍스처(캔버스) — 중심 불투명 → 가장자리 투명, 결정론(고정 시드 배치).
function makeCloudTexture(seed = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // 결정론 소형 PRNG
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  g.clearRect(0, 0, 256, 256);
  // 여러 소프트 로브를 겹쳐 뭉게구름 실루엣(가로로 퍼진 덩어리)
  for (let i = 0; i < 9; i++) {
    const x = 128 + (rnd() - 0.5) * 150;
    const y = 138 + (rnd() - 0.5) * 60;
    const rr = 40 + rnd() * 54;
    const rg = g.createRadialGradient(x, y, 0, x, y, rr);
    const a = 0.16 + rnd() * 0.14;
    rg.addColorStop(0, `rgba(255,255,255,${a})`);
    rg.addColorStop(0.55, `rgba(255,255,255,${a * 0.5})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── 구름 데이터 텍스처(#50 실루엣·석양색·태양 인지 림) ──────────────────────
// 예전 두 베이커는 RGB 에 **색**을 구웠다(흰 상부 하이라이트 + 청회 하부 그늘). 그러면 시간대
//   표현 수단이 재질 color 전체 곱뿐이라 "볕 받는 쪽은 웜 · 반대쪽·바닥은 청회"가 원리적으로
//   불가능하고(석양 구름은 흰색이 아니다), 림도 태양 방위와 무관하게 늘 같은 세기로 섰다.
//   그래서 RGB 를 색이 아니라 **데이터**로 바꾼다:
//     r,g = 빌보드 평면 법선 xy(0.5 중심, +y = 위). 밀도장 기울기에서 유도하며, 길이 |xy| 가
//           그대로 외곽 근접도다(코어 0 = 카메라 정면, 실루엣 1 = 평면 내 측면).
//     b   = 천공 개방도(위쪽 밀도의 지수 감쇠) — 밑면과 로브 사이 골이 하늘빛을 덜 받는다.
//     a   = 실루엣.
//   프래그먼트(patchCloudRim)가 이 법선을 뷰공간 태양 방향과 dot 해 볕면/그늘면·역광 투과·림을
//   계산한다. 색은 전부 uniform 이므로 환경 크로스페이드가 그대로 따라온다(팝 없음).
// 실루엣도 원형 로브 '그리기'에서 **메타볼 밀도장 + 노이즈 침식**으로 바꿨다. 로브를 겨우 이어지는
//   간격(≈1.4r)으로 놓으면 이음부가 잘록해져 양배추 결이 생기고, 저·고주파 노이즈가 등고선을 굽혀
//   원호 아이콘이 사라진다. 시드마다 총폭·기둥 수·기둥 높이·크라운 수가 달라 5 장이 서로 다른
//   구름으로 읽힌다.
// CanvasTexture 가 아니라 DataTexture 인 이유: 캔버스는 내부 저장이 프리멀티플라이라 저알파 픽셀의
//   RGB 가 양자화로 파괴된다 — 정작 법선이 가장 중요한 곳이 그 외곽 구간이다. 부수 효과로 베이크가
//   DOM 무의존이 되어 순수 노드에서 같은 함수를 호출해 실루엣·채널을 검증할 수 있다(도구는
//   bakeCloudData 를 직접 import 한다). DataTexture 는 flipY=false 이므로 버퍼를 y-up(행 0 = 구름
//   바닥)으로 채워 uv.y 와 정합시킨다. colorSpace 는 NoColorSpace — sRGB 로 두면 하드웨어 sRGB
//   디코딩이 법선·AO 값을 왜곡한다.
export const CLOUD_TEX_SIZE = 256;

// 결정론 값노이즈(해시 격자 + smoothstep 보간). Math.random 금지 계약 — 시드만 쓴다.
function cloudValueNoise(seed, cycles, S) {
  const G = Math.max(2, Math.round(cycles));
  const grid = new Float32Array((G + 1) * (G + 1));
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < grid.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    grid[i] = s / 4294967296;
  }
  const step = S / G;
  return (x, y) => {
    const fx = Math.min(G - 1e-4, Math.max(0, x / step));
    const fy = Math.min(G - 1e-4, Math.max(0, y / step));
    const ix = fx | 0, iy = fy | 0;
    const tx = fx - ix, ty = fy - iy;
    const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
    const i0 = iy * (G + 1) + ix;
    const a = grid[i0], b = grid[i0 + 1], c = grid[i0 + G + 1], d = grid[i0 + G + 2];
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  };
}

// 로브 합 밀도장. 커널은 (1-d²)² — 유한 지지라 로브별 바운딩박스만 순회한다(전체 순회 대비 ~10×).
//   sy>1 은 세로 납작(적운 바닥 덩어리), w 는 임계 대비 돌출량(작은 크라운은 낮게 잡아 봉우리로만).
function cloudLobeField(S, lobes) {
  const f = new Float32Array(S * S);
  for (const L of lobes) {
    const sy = L.sy || 1;
    const ry = L.r / sy;
    const x0 = Math.max(0, Math.floor(L.x - L.r)), x1 = Math.min(S - 1, Math.ceil(L.x + L.r));
    const y0 = Math.max(0, Math.floor(L.y - ry)), y1 = Math.min(S - 1, Math.ceil(L.y + ry));
    const inv = 1 / (L.r * L.r);
    for (let y = y0; y <= y1; y++) {
      const dy = (y - L.y) * sy;
      const dy2 = dy * dy;
      const row = y * S;
      for (let x = x0; x <= x1; x++) {
        const dx = x - L.x;
        const d2 = (dx * dx + dy2) * inv;
        if (d2 >= 1) continue;
        const t = 1 - d2;
        f[row + x] += L.w * t * t;
      }
    }
  }
  return f;
}

// ── 형상 패밀리(#53 S6) ─────────────────────────────────────────────────────
// A2·A3 의 실루엣 문법은 **하나**였다: 기단 열 → 지배 봉우리 → 적층 → 어깨 → 스캘럽. 시드가 바꾸는
//   것은 그 문법 안의 계수뿐이라 한 프레임에 세 장이 들어오면 같은 도장 세 개로 읽혔다(비전 판정
//   2026-08-04: "전부 '작은 조약돌 더미가 수평 소시지 위에 얹힌' 동일 실루엣, 크기 위계 없음").
//   시드를 더 뽑아서는 원리적으로 해소되지 않는다 — 배치 **문법 자체**를 여러 개 두어야 한다.
// 네 패밀리는 서로 다른 문법을 쓰되 같은 회화 문법 안에 있다(실루엣 우선·부드러운 로브 합집합):
//   towering  봉우리형   — 좁은 기단 위 단일 지배 봉우리 + 3 단 적층(A2 문법의 직계)
//   anvil     전단·모루형 — 지배 봉우리 상부가 바람에 한쪽으로 흐르며 넓고 납작한 모루로 퍼진다
//   decked    이중 덱형   — 납작한 아래 덱 + 어긋나게 얹힌 위 덱(층적운). 봉우리 위계가 얕다
//   fractured 파편형     — 반경비 1 : 0.55 : 0.32 의 3 덩이 클러스터. 침식이 강하고 텍스처를 덜 채운다
// 상공 적운과 원경 뱅크는 A3 까지 **서로 다른 베이커**를 썼는데 두 함수가 같은 문법의 계수만 달랐다.
//   문법이 넷으로 갈린 뒤에는 그 구분이 남길 것이 없으므로 코드 경로를 합치고 네 타일을 한 아틀라스에
//   담아 두 층이 공유한다(베이크 6 장 → 4 장, 텍스처 메모리 1.57MB → 1MB, 드로우콜 불변).
// 공통 물리 제약은 헬퍼가 소유한다: 임계 0.32 에서 두 로브는 간격 ≲1.55r 일 때만 이어지므로 모든
//   간격을 **반경에서 파생**(≤1.36r)해 공중에 뜬 동그라미가 애초에 생기지 않게 한다.
export const CLOUD_FAMILY_ORDER = Object.freeze(['towering', 'anvil', 'decked', 'fractured']);
// 바닥선(y-up, 0 = 텍스처 바닥). 강수 없는 적운 바닥은 수평으로 잘리므로 네 패밀리가 같은 높이를
//   공유한다 — 아틀라스 타일이 한 하늘에 함께 뜨는데 바닥선이 다르면 층고가 어긋나 보인다.
const CLOUD_BASE_Y = 0.235;

const lerpRnd = (rnd, a) => a[0] + rnd() * (a[1] - a[0]);

// 기단 열 — 납작한 바닥 슬래브. 반환 배열이 지배 로브·어깨의 앵커가 된다.
function plinthRow(rnd, lobes, o) {
  const row = [];
  const x0 = o.cx - o.gap * o.r0 * (o.n - 1) * 0.5;
  for (let i = 0; i < o.n; i++) {
    const r = o.r0 * lerpRnd(rnd, o.rJit);
    const sy = lerpRnd(rnd, o.sy);
    const lobe = {
      x: x0 + o.gap * o.r0 * i + (rnd() - 0.5) * o.r0 * 0.14,
      y: o.baseY + (r / sy) * lerpRnd(rnd, o.yMul),
      r, sy, w: o.w != null ? o.w : 1.0,
    };
    row.push(lobe);
    lobes.push(lobe);
  }
  return row;
}

// 볼(cheek) — 지배 로브 측면에 걸쳐 큰 원호를 깬다. 거리 0.72r 에서 부모 필드가 0.74 라 합집합이
//   확실히 이어지고 실루엣만 양배추처럼 부푼다. oneSide 는 전단형이 한쪽으로만 흐르게 한다.
function cheekPair(rnd, lobes, o) {
  for (let c = 0; c < 2; c++) {
    const s = o.oneSide ? o.side : (c === 0 ? o.side : -o.side);
    const ang = lerpRnd(rnd, o.ang) * s;
    lobes.push({
      x: o.x + Math.sin(ang) * o.r * o.dist,
      y: o.y + Math.cos(ang) * o.ry * o.rise,
      r: o.r * lerpRnd(rnd, o.rMul),
      sy: 1.04 + rnd() * 0.10, w: 0.98,
    });
  }
}

// 적층 — 반경·간격 모두 부모 반경 파생. skew·drift 가 크면 층이 한쪽으로 흘러 전단(모루)이 된다.
function tierStack(rnd, lobes, o) {
  let ty = o.y, tyR = o.ry;
  for (let k = 0; k < o.radii.length; k++) {
    const r = o.r * o.radii[k] * (0.92 + rnd() * 0.18);
    const sy = lerpRnd(rnd, o.sy);
    const ry = r / sy;
    ty += (tyR + ry) * o.step;
    tyR = ry;
    const count = o.counts[k];
    for (let j = 0; j < count; j++) {
      lobes.push({
        x: o.x + o.skew * (k + 1) * o.drift + (j - (count - 1) * 0.5) * r * o.sep
          + (rnd() - 0.5) * r * 0.22,
        y: ty + (rnd() - 0.5) * ry * 0.18,
        r, sy, w: 0.97 - 0.05 * k,
      });
    }
  }
  return { y: ty, ry: tyR };
}

// 스캘럽 — 기존 로브 윗면에 걸치는 작은 봉우리(윤곽만 크레늘레이션). 무작위 좌표에 흩으면 떠 있는
//   반점이 되므로 반드시 부모 위에 얹고, 크기도 **부모 반경 파생**이다(절대 크기는 fit 이후 사라진다).
function scallops(rnd, lobes, S, o) {
  const pool = lobes.slice();
  const n = o.n[0] + Math.floor(rnd() * (o.n[1] - o.n[0] + 1));
  for (let i = 0; i < n; i++) {
    let pick = pool[Math.floor(rnd() * pool.length)];
    const alt = pool[Math.floor(rnd() * pool.length)];
    if (alt.y > pick.y) pick = alt;                  // 두 번 뽑아 높은 쪽 — 상단 편향
    const ang = (rnd() - 0.5) * 1.9;                 // 상단 반구 위 방위
    lobes.push({
      x: pick.x + Math.sin(ang) * pick.r * 0.62,
      y: pick.y + Math.cos(ang) * (pick.r / (pick.sy || 1)) * 0.60,
      r: Math.min(S * o.cap, Math.max(S * 0.024, pick.r * lerpRnd(rnd, o.rMul))),
      sy: 1.0, w: 0.76 + rnd() * 0.16,
    });
  }
}

// 실루엣을 텍스처에 맞춰 등방 스케일(바닥선 고정). 등방이라 종횡비는 여기서 변하지 않고 화면 점유만
//   맞춰진다. fitW·fitH 를 패밀리별로 벌리는 것이 **씬 배치 위계의 절반**이다 — 텍스처를 덜 채운
//   파편형은 같은 크기 쿼드에서 그만큼 작은 구름으로 읽힌다(나머지 절반은 쿼드 크기 자체).
function fitSilhouette(lobes, S, cx, baseY, fitW, fitH) {
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of lobes) {
    minX = Math.min(minX, L.x - L.r);
    maxX = Math.max(maxX, L.x + L.r);
    maxY = Math.max(maxY, L.y + L.r / (L.sy || 1));
  }
  // 상한 하드 가드: 실루엣이 텍스처 테두리에 닿으면 아틀라스에서 이웃 타일이 밉·바이리니어로 새어
  //   든다(실측: decked 가 fitH 0.82 로 상단 알파 255 까지 차 위쪽 테두리를 물었다). fitH 는 바닥선
  //   **위쪽** 여유를 재는 값이므로 baseY 를 빼고, 스캘럽·wisp 가 더 얹힐 5.5% 를 남긴다.
  const fitHSafe = Math.min(fitH, 1 - baseY / S - 0.055);
  const fit = Math.min(S * Math.min(fitW, 0.96) / (maxX - minX), S * fitHSafe / (maxY - baseY));
  const mid = (minX + maxX) * 0.5;
  for (const L of lobes) {
    L.x = cx + (L.x - mid) * fit;
    L.y = baseY + (L.y - baseY) * fit;
    L.r *= fit;
  }
  return fit;
}

// ① 봉우리형 — 기단 반경의 1.84~2.14 배짜리 지배 로브 하나에 3 단 적층. 봉우리 위계는 **반경비**로만
//    생긴다(층을 더 쌓거나 노이즈를 키우는 것으로 대체되지 않는다 — A2 FIX① 실측).
function toweringLobes(rnd, S) {
  const lobes = [];
  const baseY = S * CLOUD_BASE_Y, cx = S * 0.5;
  const rP = S * (0.086 + rnd() * 0.020);
  const nP = 3 + (rnd() < 0.45 ? 1 : 0);
  const skew = (rnd() - 0.5) * S * 0.075;
  const plinth = plinthRow(rnd, lobes, {
    cx, baseY, r0: rP, n: nP, gap: 1.14, rJit: [0.84, 1.14], sy: [1.55, 1.85], yMul: [0.82, 0.98],
  });
  const rD = rP * (1.84 + rnd() * 0.30);
  const ai = nP >= 4 ? (rnd() < 0.5 ? 1 : 2) : (rnd() < 0.5 ? 0 : 1);
  const ax = plinth[ai].x + (rnd() - 0.5) * rP * 0.30;
  const syD = 1.06 + rnd() * 0.12;
  const ryD = rD / syD;
  const dy0 = baseY + ryD * 0.74;
  lobes.push({ x: ax, y: dy0, r: rD, sy: syD, w: 1.0 });
  cheekPair(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, dist: 0.72, rise: 0.46,
    rMul: [0.40, 0.54], ang: [0.74, 1.14], side: rnd() < 0.5 ? -1 : 1,
  });
  const tiers = rnd() < 0.55 ? [0.52, 0.35, 0.25] : [0.52, 0.35];
  tierStack(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, radii: tiers, counts: [2, 2, 1],
    sep: 1.22, step: 0.60, sy: [1.02, 1.12], skew, drift: 0.34,
  });
  // 이웃 어깨 — 지배 덩어리 반대쪽에 낮게. 지배와 경쟁하지 않는 반경대라 위계를 흐리지 않으면서
  //   실루엣을 비대칭으로 벌린다.
  const si = ai <= 1 ? nP - 1 : 0;
  const rS = rD * (0.62 + rnd() * 0.16);
  const syS = 1.08 + rnd() * 0.12;
  const sy0 = baseY + (rS / syS) * 0.70;
  lobes.push({ x: plinth[si].x, y: sy0, r: rS, sy: syS, w: 1.0 });
  lobes.push({
    x: plinth[si].x + skew * 0.3, y: sy0 + (rS / syS) * 0.92, r: rS * 0.56, sy: 1.04, w: 0.95,
  });
  const fit = fitSilhouette(lobes, S, cx, baseY, 0.90 + rnd() * 0.06, 0.72);
  scallops(rnd, lobes, S, { n: [8, 12], rMul: [0.24, 0.38], cap: 0.072 });
  return {
    lobes, baseY, family: 'towering',
    erosionCycles: 8, crinkleCycles: 21, wobble: 0.36,
    skyK: 2.60, threshold: 0.32, feather: 0.130,
    wispAmp: 0.58, wispBand: S * 0.060, wispCycles: 26,
    plinthR: rP * fit, domR: rD * fit, nPlinth: nP,
  };
}

// ② 전단·모루형 — 성숙 적운. 지배 봉우리는 towering 보다 크지만 적층이 **한쪽으로 흐르고** 층마다
//    납작해져(sy 1.5~1.8) 상부가 모루처럼 퍼진다. 볼도 한쪽만 달아 좌우 비대칭을 극대화한다.
//    어깨 로브가 없어 위계가 봉우리 하나로 몰리므로 towering 과 실루엣 모멘트가 뚜렷이 갈린다.
function anvilLobes(rnd, S) {
  const lobes = [];
  const baseY = S * CLOUD_BASE_Y, cx = S * 0.5;
  const rP = S * (0.078 + rnd() * 0.016);
  const nP = 3 + (rnd() < 0.3 ? 1 : 0);
  const side = rnd() < 0.5 ? -1 : 1;
  const skew = side * S * (0.070 + rnd() * 0.030);   // 전단은 부호가 고정 — 바람 방향이 하나이므로
  const plinth = plinthRow(rnd, lobes, {
    cx, baseY, r0: rP, n: nP, gap: 1.10, rJit: [0.82, 1.10], sy: [1.70, 2.00], yMul: [0.78, 0.94],
  });
  const rD = rP * (1.95 + rnd() * 0.30);
  const ai = Math.max(0, Math.min(nP - 1, side < 0 ? nP - 2 : 1));
  const ax = plinth[ai].x + (rnd() - 0.5) * rP * 0.24;
  const syD = 1.02 + rnd() * 0.10;
  const ryD = rD / syD;
  const dy0 = baseY + ryD * 0.70;
  lobes.push({ x: ax, y: dy0, r: rD, sy: syD, w: 1.0 });
  cheekPair(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, dist: 0.70, rise: 0.40,
    rMul: [0.38, 0.52], ang: [0.52, 0.92], side, oneSide: true,
  });
  // 모루: 반경이 거의 줄지 않는 3 단(0.60/0.54/0.46)을 크게 흘려 얹는다. 납작한 sy 와 큰 drift 가
  //   함께 있어야 "퍼진 상부"가 되고, 어느 하나만으로는 그냥 기울어진 봉우리가 된다.
  tierStack(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, radii: [0.60, 0.54, 0.46], counts: [2, 2, 1],
    sep: 1.18, step: 0.56, sy: [1.50, 1.80], skew, drift: 0.48,
  });
  const fit = fitSilhouette(lobes, S, cx, baseY, 0.88 + rnd() * 0.06, 0.74);
  scallops(rnd, lobes, S, { n: [6, 9], rMul: [0.22, 0.34], cap: 0.062 });
  return {
    lobes, baseY, family: 'anvil',
    erosionCycles: 9, crinkleCycles: 24, wobble: 0.40,
    skyK: 2.44, threshold: 0.32, feather: 0.130,
    wispAmp: 0.66, wispBand: S * 0.064, wispCycles: 22,
    plinthR: rP * fit, domR: rD * fit, nPlinth: nP,
  };
}

// ③ 이중 덱형 — 층적운. 아주 납작한 아래 덱 위에 **측방으로 어긋난** 위 덱이 얹히고, 봉우리는 덱
//    반경의 1.2~1.4 배로만 솟는다(지배 경쟁 없음 = 얕은 위계). 대신 폭을 좁게 fit 해 종횡비가
//    소시지로 가지 않게 한다 — 화면 실루엣 종횡비는 쿼드 종횡비 × 베이크 종횡비이므로 납작함을
//    베이크에서 벌면 곧바로 A3 가 되돌린 그 결함이 된다.
function deckedLobes(rnd, S) {
  const lobes = [];
  const baseY = S * CLOUD_BASE_Y, cx = S * 0.5;
  const rP = S * (0.088 + rnd() * 0.016);
  const nP = 3;
  const skew = (rnd() - 0.5) * S * 0.06;
  plinthRow(rnd, lobes, {
    cx, baseY, r0: rP, n: nP, gap: 1.10, rJit: [0.88, 1.12], sy: [1.85, 2.15], yMul: [0.84, 0.98],
  });
  // 위 덱 — 측방으로 어긋나게 얹어 "같은 열의 반복"이 아니라 두 층으로 읽히게 한다.
  //   납작한 로브(sy≈2)는 세로 반경이 절반이라 두 덱을 층고만큼 띄우면 **합집합이 끊긴다**(실측:
  //   위 덱 이상이 통째로 고립 성분 4877px 으로 잘려 나갔다). 그래서 라이저(수직 목) 두 개로 잇는다 —
  //   실제 층적운도 상승 기류가 지나는 자리만 두 층을 잇고 나머지는 골로 남는다.
  const rB = rP * (0.74 + rnd() * 0.12);
  const n2 = 3;
  const deck = [];
  const deckY = baseY + (rP / 1.9) * 2.60;
  const bx0 = cx + skew * 1.4 + (rnd() - 0.5) * rB * 0.4 - rB * 1.20 * (n2 - 1) * 0.5;
  for (let i = 0; i < n2; i++) {
    const r = rB * (0.90 + rnd() * 0.18);
    const sy = 1.50 + rnd() * 0.26;
    const lobe = {
      x: bx0 + rB * 1.20 * i + (rnd() - 0.5) * rB * 0.14,
      y: deckY + (r / sy) * 0.54, r, sy, w: 0.96,
    };
    deck.push(lobe);
    lobes.push(lobe);
  }
  // 라이저는 **한 개**다. 두 개를 세우면 두 덱과 함께 고리가 닫혀 그 안쪽이 내부 홀이 되고, 홀 채움이
  //   그것을 메워(실측 2060px) 두 층이 한 덩어리로 붙어 버린다. 하나면 반대쪽이 하늘로 열린 만입(bay)
  //   으로 남아 위상은 단순연결인데 실루엣은 두 층으로 읽힌다 — 층적운의 처진 아래 덱이 그 형태다.
  const di = rnd() < 0.5 ? 0 : n2 - 1;
  {
    const at = deck[di];
    const rR = rP * (0.72 + rnd() * 0.14);
    lobes.push({
      x: at.x + (rnd() - 0.5) * rP * 0.3,
      y: baseY + (deckY - baseY) * (0.58 + rnd() * 0.12), r: rR, sy: 1.02 + rnd() * 0.10, w: 0.94,
    });
  }
  const rD = rB * (1.20 + rnd() * 0.22);
  const ax = deck[di].x + (rnd() - 0.5) * rB * 0.3;
  const syD = 1.24 + rnd() * 0.18;
  const ryD = rD / syD;
  const dy0 = deck[di].y + (deck[di].r / deck[di].sy + ryD) * 0.42;
  lobes.push({ x: ax, y: dy0, r: rD, sy: syD, w: 1.0 });
  cheekPair(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, dist: 0.68, rise: 0.40,
    rMul: [0.42, 0.54], ang: [0.80, 1.20], side: rnd() < 0.5 ? -1 : 1,
  });
  tierStack(rnd, lobes, {
    x: ax, y: dy0, r: rD, ry: ryD, radii: [0.52, 0.40, 0.30], counts: [2, 1, 1],
    sep: 1.24, step: 0.58, sy: [1.10, 1.24], skew, drift: 0.30,
  });
  const fit = fitSilhouette(lobes, S, cx, baseY, 0.86 + rnd() * 0.05, 0.82);
  scallops(rnd, lobes, S, { n: [10, 14], rMul: [0.20, 0.30], cap: 0.052 });
  return {
    lobes, baseY, family: 'decked',
    erosionCycles: 11, crinkleCycles: 26, wobble: 0.32,
    skyK: 2.81, threshold: 0.32, feather: 0.126,
    wispAmp: 0.60, wispBand: S * 0.062, wispCycles: 30,
    plinthR: rP * fit, domR: rD * fit, nPlinth: nP,
  };
}

// ④ 파편형 — 반경비 1 : 0.55 : 0.32 의 세 덩이. 간격은 문턱(≤1.36r) 안이라 목으로 이어지지만
//    침식·wobble 이 커서 그 목이 찢겨 성긴 조각처럼 읽힌다. fit 을 작게 잡아 텍스처를 덜 채우므로
//    같은 쿼드에서 **작은 구름**이 된다 — 씬 배치 위계를 텍스처 쪽에서 버는 축이다.
function fracturedLobes(rnd, S) {
  const lobes = [];
  const baseY = S * CLOUD_BASE_Y, cx = S * 0.5;
  const side = rnd() < 0.5 ? -1 : 1;
  const rA = S * (0.108 + rnd() * 0.020);
  const syA = 1.16 + rnd() * 0.16;
  const ryA = rA / syA;
  const ax = cx - side * rA * (0.24 + rnd() * 0.16);
  const ay = baseY + ryA * (0.80 + rnd() * 0.12);
  lobes.push({ x: ax, y: ay, r: rA, sy: syA, w: 1.0 });
  cheekPair(rnd, lobes, {
    x: ax, y: ay, r: rA, ry: ryA, dist: 0.74, rise: 0.44,
    rMul: [0.34, 0.48], ang: [0.60, 1.30], side,
  });
  lobes.push({
    x: ax + side * rA * 0.30, y: ay + ryA * (0.72 + rnd() * 0.14),
    r: rA * (0.44 + rnd() * 0.10), sy: 1.08 + rnd() * 0.10, w: 0.96,
  });
  // 둘째 덩이(0.55) — 첫 덩이 어깨에서 1.30r 떨어져 목으로만 이어진다.
  const rB = rA * (0.50 + rnd() * 0.10);
  const syB = 1.10 + rnd() * 0.14;
  const bx = ax + side * rA * 0.86;
  const by = baseY + ryA * (1.78 + rnd() * 0.26);
  lobes.push({ x: bx, y: by, r: rB, sy: syB, w: 0.98 });
  lobes.push({
    x: bx + side * rB * 0.42, y: by + (rB / syB) * 0.78,
    r: rB * (0.52 + rnd() * 0.14), sy: 1.06, w: 0.94,
  });
  // 셋째 덩이(0.32) — 반대쪽 낮은 조각. 세 덩이의 반경대가 겹치지 않는 것이 이 패밀리의 정체다.
  const rC = rA * (0.28 + rnd() * 0.08);
  const cx3 = ax - side * rA * (0.86 + rnd() * 0.12);
  const cy3 = baseY + rC * (0.94 + rnd() * 0.22);
  lobes.push({ x: cx3, y: cy3, r: rC, sy: 1.04 + rnd() * 0.12, w: 0.98 });
  lobes.push({
    x: cx3 + side * rC * 0.50, y: cy3 + rC * 0.62, r: rC * (0.56 + rnd() * 0.16), sy: 1.0, w: 0.92,
  });
  const fit = fitSilhouette(lobes, S, cx, baseY, 0.68 + rnd() * 0.06, 0.60);
  scallops(rnd, lobes, S, { n: [7, 11], rMul: [0.26, 0.40], cap: 0.048 });
  return {
    lobes, baseY, family: 'fractured',
    erosionCycles: 13, crinkleCycles: 30, wobble: 0.46,
    skyK: 2.24, threshold: 0.34, feather: 0.159,
    wispAmp: 0.78, wispBand: S * 0.078, wispCycles: 20,
    plinthR: rC * fit, domR: rA * fit, nPlinth: 1,
  };
}

const CLOUD_FAMILY_BUILDERS = {
  towering: toweringLobes, anvil: anvilLobes, decked: deckedLobes, fractured: fracturedLobes,
};

// ── 위상·형태 정리 유틸(순수 함수, DOM/three 무의존) ────────────────────────────
// 임계 미만 픽셀 중 **테두리에서 도달 가능한** 것만 '외부'다. 나머지는 실루엣 내부의 홀이다.
function cloudExterior(f, S, level) {
  const out = new Uint8Array(S * S);
  const stack = new Int32Array(S * S);
  let sp = 0;
  const push = (p) => { if (!out[p] && f[p] < level) { out[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < S; x++) { push(x); push((S - 1) * S + x); }
  for (let y = 0; y < S; y++) { push(y * S); push(y * S + S - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % S, y = (p / S) | 0;
    if (x > 0) push(p - 1);
    if (x < S - 1) push(p + 1);
    if (y > 0) push(p - S);
    if (y < S - 1) push(p + S);
  }
  return out;
}

// 8-이웃 연결 성분 라벨링(f ≥ level). 고립 돌기 판별·제거용.
function cloudComponents(f, S, level) {
  const lab = new Int32Array(S * S).fill(-1);
  const sizes = [];
  const stack = new Int32Array(S * S);
  for (let start = 0; start < S * S; start++) {
    if (lab[start] !== -1 || f[start] < level) continue;
    const id = sizes.length;
    sizes.push(0);
    let sp = 0;
    stack[sp++] = start;
    lab[start] = id;
    while (sp) {
      const p = stack[--sp];
      sizes[id]++;
      const x = p % S, y = (p / S) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 0 || xx >= S) continue;
          const qq = yy * S + xx;
          if (lab[qq] !== -1 || f[qq] < level) continue;
          lab[qq] = id;
          stack[sp++] = qq;
        }
      }
    }
  }
  return { lab, sizes };
}

// 분리형 그레이스케일 형태학(정사각 구조요소, 테두리는 복제). max→min = 클로징.
//   비교는 Math.max/min 3 인자 호출이 아니라 명시 분기로 쓴다 — 베이크는 진입 로딩 창에서 6 장을
//   굽고, 3 인자 호출판은 그 구간에 200ms 를 더 얹었다(실측 12.4ms/장 → 3.4ms/장).
function cloudMorph(src, S, R, isMax) {
  const a = new Float32Array(S * S), b = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      let v = src[row + x];
      for (let d = 1; d <= R; d++) {
        const l = src[row + (x - d < 0 ? 0 : x - d)];
        const r = src[row + (x + d >= S ? S - 1 : x + d)];
        if (isMax) { if (l > v) v = l; if (r > v) v = r; } else { if (l < v) v = l; if (r < v) v = r; }
      }
      a[row + x] = v;
    }
  }
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      let v = a[row + x];
      for (let d = 1; d <= R; d++) {
        const u = a[(y - d < 0 ? 0 : y - d) * S + x];
        const w = a[(y + d >= S ? S - 1 : y + d) * S + x];
        if (isMax) { if (u > v) v = u; if (w > v) v = w; } else { if (u < v) v = u; if (w < v) v = w; }
      }
      b[row + x] = v;
    }
  }
  return b;
}
const cloudClose = (src, S, R) => cloudMorph(cloudMorph(src, S, R, true), S, R, false);

// 분리형 박스 블러(두 번 통과 = 준가우시안). 저주파 로브 기울기 = 부피 셰이딩의 입력.
function cloudBlur(src, S, R) {
  const a = new Float32Array(S * S), b = new Float32Array(S * S);
  const inv = 1 / (2 * R + 1);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      let sum = 0;
      for (let d = -R; d <= R; d++) sum += src[row + (x + d < 0 ? 0 : x + d >= S ? S - 1 : x + d)];
      a[row + x] = sum * inv;
    }
  }
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      let sum = 0;
      for (let d = -R; d <= R; d++) sum += a[(y + d < 0 ? 0 : y + d >= S ? S - 1 : y + d) * S + x];
      b[row + x] = sum * inv;
    }
  }
  return b;
}

// smoothstep 의 역함수(이분법 12 회 — 0.0003 정밀도면 알파 바이트 한 눈금보다 촘촘하다). 알파
//   눈금에서 필드 레벨로 되돌릴 때 쓴다.
function invSmoothstep01(a) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 12; k++) {
    const m = (lo + hi) * 0.5;
    if (m * m * (3 - 2 * m) < a) lo = m; else hi = m;
  }
  return (lo + hi) * 0.5;
}

// 종자 집합까지의 체임퍼 거리(전방·후방 2 패스, 8-이웃 근사). 실루엣 안쪽으로 재면 외곽 밴드
//   (shore)이고 바깥쪽으로 재면 wisp 밴드다 — 두 곳이 같은 함수를 쓴다.
function cloudChamfer(seedMask, S) {
  const BIG = 1e6;
  const d = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) d[i] = seedMask[i] ? 0 : BIG;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) v = Math.min(v, d[i - S] + 1, x > 0 ? d[i - S - 1] + 1.4142 : BIG,
        x < S - 1 ? d[i - S + 1] + 1.4142 : BIG);
      d[i] = v;
    }
  }
  for (let y = S - 1; y >= 0; y--) {
    for (let x = S - 1; x >= 0; x--) {
      const i = y * S + x;
      let v = d[i];
      if (x < S - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < S - 1) v = Math.min(v, d[i + S] + 1, x < S - 1 ? d[i + S + 1] + 1.4142 : BIG,
        x > 0 ? d[i + S - 1] + 1.4142 : BIG);
      d[i] = v;
    }
  }
  return d;
}

// 로브 배치만 뽑는 경로(순수 함수). 형태 게이트는 픽셀뿐 아니라 **배치 자체**(반경대 위계·연결
//   문턱·미러)를 단언해야 하므로 베이커와 같은 함수에서 스펙을 받아 간다 — 게이트가 제품과 다른
//   식을 재구현하면 그 순간 계측기가 자기증명이 된다.
export function cloudFamilySpec(seed = 1, family = 'towering', S = CLOUD_TEX_SIZE, { mirror = false } = {}) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const build = CLOUD_FAMILY_BUILDERS[family];
  if (!build) throw new Error(`unknown cloud family: ${family}`);
  const spec = build(rnd, S);
  if (mirror) for (const L of spec.lobes) L.x = S - L.x;
  return spec;
}

// 도구가 직접 호출하는 순수 베이커(DOM 무의존). → { size, data: Uint8Array(RGBA, y-up) }
//   family = CLOUD_FAMILY_ORDER 의 배치 문법, mirror = 로브 x 좌표 반사(같은 문법의 좌우 반전).
//   미러는 로브 좌표만 뒤집고 침식 노이즈는 그대로 두므로 **거울상이 아닌** 다른 구름이 나온다 —
//   같은 프레임에 원본과 미러가 함께 있어도 반사로 인지되지 않는다.
export function bakeCloudData(seed = 1, family = 'towering', S = CLOUD_TEX_SIZE, opts = {}) {
  const spec = cloudFamilySpec(seed, family, S, opts);
  const { mirror = false } = opts;
  const f = cloudLobeField(S, spec.lobes);
  const TH = spec.threshold, FE = spec.feather;

  // 1) 침식 — 곱연산(내부 밀도 변주 → 법선 요철)과 마스크된 덧셈(등고선 굽힘 → 실루엣 파괴)을
  //    함께 쓴다. 곱만으로는 임계 근처 이동량이 1px 대라 실루엣이 그대로 원호로 남는다.
  //    **깎기는 외곽 근처에서만** 한다(FIX② 2026-08-03). 1 차는 v<0.45 를 '얇은 곳'으로 보고
  //    깎았는데 로브 이음부의 골(0.32~0.45)은 실루엣 내부에도 널려 있어서, 그 자리에 하늘이
  //    뚫린 선명한 홀과 S 자 음영 홈이 생겼다("확대 시 우습다"의 최대 기여자). 외곽까지의
  //    거리로 게이트하면 윤곽 굽힘은 그대로 남고 내부는 손대지 않는다.
  // 외부 종자는 테두리 연결 성분만 쓰므로 기하적 내부 홀이 이미 있어도 그 홀을 키우지 않는다.
  const outside = cloudExterior(f, S, TH);
  const shore = new Float32Array(S * S);
  {
    const d = cloudChamfer(outside, S);
    for (let i = 0; i < S * S; i++) shore[i] = 1 - smoothstep(4, 12, d[i]);
  }
  const nA = cloudValueNoise(seed * 7919 + 13, spec.erosionCycles, S);
  const nB = cloudValueNoise(seed * 104729 + 71, spec.crinkleCycles, S);
  const baseFade = S * 0.085;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      if (f[i] <= 1e-4) continue;
      const a = nA(x, y), b = nB(x, y);
      let v = f[i] * (0.88 + 0.24 * a);
      const mask = smoothstep(0.02, 0.30, v);
      const grow = ((a - 0.5) + (b - 0.5) * 0.45) * spec.wobble;
      v += grow > 0 ? grow * mask : grow * mask * shore[i];
      // 바닥 평탄화: 강수 없는 적운 바닥은 수평으로 잘린다. 컬럼별 미세 요동으로 자를 대지 않는다.
      const cut = spec.baseY + (nA(x, 4) - 0.5) * S * 0.016;
      if (y < cut) v *= Math.max(0, 1 - (cut - y) / baseFade);
      f[i] = v > 0 ? v : 0;
    }
  }

  // 1b) 내부 클로징 — 로브 이음부의 좁은 골을 **필드 단계에서** 메운다. 알파를 사후 보정하는
  //    것과 달리 법선·천공 개방도가 모두 메워진 필드에서 나오므로 이음선이 남지 않는다.
  //    외곽 밴드(shore)는 원본을 유지해 침식이 만든 윤곽 크레늘레이션을 지우지 않는다.
  //    구조요소(11px)보다 넓은 만입 — 크라운 사이의 진짜 골 — 은 그대로 살아 왕관이 뭉개지지 않는다.
  {
    const closed = cloudClose(f, S, 5);
    for (let i = 0; i < S * S; i++) f[i] = closed[i] * (1 - shore[i]) + f[i] * shore[i];
  }

  // 1c) 위상 정리. ① 고립 성분 제거(FIX③): 알파가 뜨는 성분이 여러 개면 최대 성분만 남긴다 —
  //    기단 위에 떠 있던 가느다란 장기말/호로병형 단독 nub 이 여기서 사라진다. 페이드 잔상까지
  //    지우려고 판정 임계를 알파 하한(TH−FE)으로 잡는다. ② 내부 홀 채움(FIX②): 테두리에서
  //    도달 못 하는 임계 미만 성분을 큰 구조요소 클로징 값으로 메워(절벽 없이) 알파를 올린다.
  const stats = { isolatedPx: 0, holePx: 0, components: 1, wispPx: 0, wispDropPx: 0 };
  {
    const { lab, sizes } = cloudComponents(f, S, TH - FE);
    stats.components = sizes.length;
    if (sizes.length > 1) {
      let keep = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[keep]) keep = k;
      for (let i = 0; i < S * S; i++) {
        if (lab[i] >= 0 && lab[i] !== keep) { f[i] = 0; stats.isolatedPx++; }
      }
    }
    const ext = cloudExterior(f, S, TH);
    let holes = 0;
    for (let i = 0; i < S * S; i++) if (f[i] < TH && !ext[i]) holes++;
    if (holes) {
      const big = cloudClose(f, S, 18);
      for (let i = 0; i < S * S; i++) {
        if (f[i] < TH && !ext[i]) { f[i] = Math.max(big[i], TH + FE * 0.25); stats.holePx++; }
      }
    }
  }

  // 1d) wisp 외곽(#53 S6) — A3 까지 실루엣 경계는 feather 폭(≈6px) 안에서 알파 0 → 1 로 끝났고,
  //    비전은 그것을 "외곽에 흩어지는 wisp 없이 경계가 딱 끊김 → 클립아트 스티커"로 판정했다.
  //    그래서 실루엣 **밖** 저밀도 밴드를 노이즈로 찢어 붙인다. 값은 임계 근처까지만 올라가므로
  //    알파 0.05~0.35 의 증기로 남고(코어는 불침해), v4 레이마칭이 그 낮은 상한을 얇은 반투명
  //    두께로 풀어 준다. 두 옥타브를 쓰는 이유는 저주파만으로는 매끈한 후광(halo)이 되기 때문이다.
  //    문턱을 거리(1−t)에 따라 올려 밴드 끝으로 갈수록 살아남는 촉수가 줄어든다.
  if (spec.wispAmp > 0) {
    const solid = new Uint8Array(S * S);
    for (let i = 0; i < S * S; i++) solid[i] = f[i] >= TH ? 1 : 0;
    const dOut = cloudChamfer(solid, S);
    const nW = cloudValueNoise(seed * 31337 + 7, spec.wispCycles, S);
    const nW2 = cloudValueNoise(seed * 7717 + 91, Math.round(spec.wispCycles * 2.4), S);
    const band = spec.wispBand;
    for (let y = 0; y < S; y++) {
      const row = y * S;
      for (let x = 0; x < S; x++) {
        const i = row + x;
        const d = dOut[i];
        if (d <= 0 || d > band) continue;
        const t = Math.pow(1 - d / band, 0.7);       // 1 = 경계, 0 = 밴드 끝
        const n = nW(x, y) * 0.66 + nW2(x, y) * 0.34;
        const torn = n - 0.26 - (1 - t) * 0.42;
        if (torn <= 0) continue;
        // 바닥선 아래로는 증기도 내려가지 않는다(평평한 적운 바닥 계약).
        if (y < spec.baseY) continue;
        // 목표는 **알파**다. 필드에 증분을 더하는 방식은 실패했다(실측: 밴드 중반에서 기저 필드가
        //   증분보다 빨리 떨어져 알파가 0 으로 잘려, 경계 밖 꼬리 중앙값이 2.8px 에 머물렀다).
        //   알파 램프의 역함수로 필요한 필드값을 직접 세워야 증기가 의도한 농도로 남는다.
        const want = TH - FE + Math.min(0.42, spec.wispAmp * torn * t) * 2 * FE;
        if (want > f[i]) { f[i] = want; stats.wispPx++; }
      }
    }
    // wisp 는 실루엣 밖에서 자라므로 ① 떨어진 조각과 ② 증기에 둘러싸인 주머니를 만들 수 있다.
    // ① 조각: **작은 증기 조각은 남기고 큰 것만 지운다**(1c 는 크기와 무관하게 최대 성분만 남긴다).
    //    1c 가 겨냥한 결함은 기단 위에 떠 있던 **불투명한** 장기말/호로병 nub 이고, 알파 0.1~0.3 의
    //    증기 파편은 오히려 이 라운드가 요구받은 것이다("외곽에 흩어지는 wisp"). 그래서 조각은
    //    본체 대비 면적 상한으로만 묶는다 — 임계는 게이트가 재고 넘으면 실패한다.
    const WISP_FRAGMENT_MAX = 0.006;                 // 본체 면적 대비 조각 하나의 상한
    const { lab, sizes } = cloudComponents(f, S, TH - FE);
    if (sizes.length > 1) {
      let keep = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[keep]) keep = k;
      const limit = sizes[keep] * WISP_FRAGMENT_MAX;
      for (let i = 0; i < S * S; i++) {
        if (lab[i] >= 0 && lab[i] !== keep && sizes[lab[i]] > limit) { f[i] = 0; stats.wispDropPx++; }
      }
    }
    // ② 주머니: 봉인 판정을 **알파 눈금 여러 점**에서 한다. 낮은 레벨에서는 '빈' 집합이 더 좁아
    //    높은 레벨엔 없던 주머니가 생긴다 — A3 게이트가 씨드 97 에서 잡아낸 "거의 봉인된 주머니"가
    //    정확히 그 현상이고(임계 26~102 상존, 128 에서만 소멸), wisp 촉수가 만입을 감싸면 재발한다.
    //    알파 바이트로 레벨을 세는 이유는 게이트도 알파로 판정하기 때문이다 — 필드값으로 세면 두
    //    눈금이 미세하게 엇갈려 경계에서 홀이 살아남는다(실측: fractured 가 T=26 에서 1 개 남았다).
    //    레벨은 **내림차순**으로 돈다. 봉인은 f 를 올리므로 낮은 레벨에서 먼저 메우면 그 결과가 높은
    //    레벨에 새 주머니를 만들고 다시 검사되지 않는다(실측: T=26 에 1~3 개 잔존). 높은 레벨부터
    //    내려오면 낮은 레벨의 검사가 항상 최신 f 를 보므로 한 번의 통과로 고정점에 도달한다.
    for (const alphaByte of [160, 128, 102, 77, 64, 51, 40, 32, 26, 16, 8, 4]) {
      // 알파 바이트는 round() 로 양자화되므로 실제 판정 경계는 (byte − 0.5)/255 다. 그보다 살짝
      //   아래를 레벨로 잡아야 '빈' 집합이 게이트의 것과 같거나 더 좁아져(=엄격) 주머니를 놓치지
      //   않는다(실측: byte/255 를 그대로 쓰면 fractured 가 T=26 에서 1 개 살아남았다).
      const level = TH - FE + invSmoothstep01((alphaByte - 0.75) / 255) * 2 * FE;
      const ext = cloudExterior(f, S, level);
      let pocket = 0;
      for (let i = 0; i < S * S; i++) if (f[i] < level && !ext[i]) pocket++;
      if (!pocket) continue;
      for (let i = 0; i < S * S; i++) {
        if (f[i] < level && !ext[i]) { f[i] = level + FE * 0.02; stats.holePx++; }
      }
    }
  }

  // 2) 천공 개방도 — 위에서 아래로 밀도를 적분한 지수 감쇠. 바닥·틈이 하늘빛을 덜 받는다.
  //    바닥값 0.06 은 칠흑 금지(룩 문법: 그림자면도 읽혀야 한다) 하한이다.
  const skyRaw = new Float32Array(S * S);
  const k = spec.skyK / S;
  for (let x = 0; x < S; x++) {
    let acc = 0;
    for (let y = S - 1; y >= 0; y--) {
      const i = y * S + x;
      acc += f[i];
      skyRaw[i] = 0.06 + 0.94 * Math.exp(-acc * k);
    }
  }
  // 순수 수직 광선은 딱딱하므로 가로 5탭으로 눌러 확산 하늘광에 가깝게.
  const sky = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      let sum = 0, wsum = 0;
      for (let d = -2; d <= 2; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= S) continue;
        const w = d === 0 ? 3 : (Math.abs(d) === 1 ? 2 : 1);
        sum += skyRaw[row + xx] * w; wsum += w;
      }
      sky[row + x] = sum / wsum;
    }
  }

  // 3) 법선 = 밀도 감소 방향(외향). 두 스케일을 함께 인코딩한다.
  //    · 고주파(2px 중앙차분): 실루엣 근접도 — 알파 윤곽 림·컷아웃 방지.
  //    · 저주파(블러 필드 기울기): **로브 곡률** — 볕면/그늘면이 테두리가 아니라 부피로 읽히게
  //      하는 유일한 입력이다(FIX④ 2026-08-03). 1 차는 길이를 pow(1−thick,0.65) 로만 눌러
  //      코어가 전부 (0,0,1) 이 됐고, 그래서 역광 프레임의 바디가 스프라이트를 가로지르는 단일
  //      램프 하나로 평평했다.
  //    두께 프록시는 **길이 구간 분할**로 유지한다: 내부 로브 기울기는 [0, 0.46], 실루엣 근접도는
  //      거기서 1 까지 올라가고, 셰이더는 slope>0.52 만 '얇은 곳'으로 읽는다(patchCloudRim 참조).
  //    기울기 크기는 이미지마다 다르므로 표본 p95 로 정규화한다(변종·시드 무관 일관 강도).
  const INTERIOR_TILT = 0.46;
  const blur = cloudBlur(cloudBlur(f, S, 7), S, 7);
  const gxs = new Float32Array(S * S), gys = new Float32Array(S * S);
  const bxs = new Float32Array(S * S), bys = new Float32Array(S * S);
  const mags = [], bmags = [];
  const at = (src, x, y) => src[Math.min(S - 1, Math.max(0, y)) * S + Math.min(S - 1, Math.max(0, x))];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (f[i] <= 1e-4) continue;
      const gx = at(f, x + 2, y) - at(f, x - 2, y);
      const gy = at(f, x, y + 2) - at(f, x, y - 2);
      gxs[i] = gx; gys[i] = gy;
      const bx = at(blur, x + 3, y) - at(blur, x - 3, y);
      const by = at(blur, x, y + 3) - at(blur, x, y - 3);
      bxs[i] = bx; bys[i] = by;
      if ((i & 7) === 0) { mags.push(Math.hypot(gx, gy)); bmags.push(Math.hypot(bx, by)); }
    }
  }
  mags.sort((p, r) => p - r);
  bmags.sort((p, r) => p - r);
  const gRef = Math.max(1e-3, mags.length ? mags[Math.floor(mags.length * 0.95)] * 0.55 : 1);
  const bRef = Math.max(1e-4, bmags.length ? bmags[Math.floor(bmags.length * 0.90)] * 0.62 : 1);

  // feather 는 실루엣 '모양'이 아니라 알파 램프 폭이다. 임계 기울기(≈0.042/px)로 0.13 은 약 6px
  //   램프 — 0.06 대로 좁히면 커버 픽셀의 93% 가 완전 불투명이 되어 종이 컷아웃으로 읽혔다(실측).
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const fv = f[i];
    const alpha = smoothstep(TH - FE, TH + FE, fv);
    const p = i * 4;
    data[p + 2] = Math.round(255 * Math.min(1, Math.max(0, sky[i])));
    data[p + 3] = Math.round(255 * alpha);
    if (alpha <= 0.002) { data[p] = 128; data[p + 1] = 128; continue; }
    const gx = gxs[i], gy = gys[i];
    const gl = Math.hypot(gx, gy);
    const bx = bxs[i], by = bys[i];
    const bl = Math.hypot(bx, by);
    // 두께: 임계에서 0(외곽) → 임계의 2배에서 1(코어).
    const thick = Math.min(1, Math.max(0, (fv - TH) / TH));
    const edge = Math.pow(1 - thick, 0.65) * Math.min(1, gl / gRef);
    const w = smoothstep(0.28, 0.95, edge);          // 0 = 코어, 1 = 실루엣
    const lobe = Math.min(1, bl / bRef) * INTERIOR_TILT;
    const ex = gl > 1e-5 ? -gx / gl : 0, ey = gl > 1e-5 ? -gy / gl : 0;
    const ix = bl > 1e-7 ? -bx / bl : 0, iy = bl > 1e-7 ? -by / bl : 0;
    const mx = ix * (1 - w) + ex * w, my = iy * (1 - w) + ey * w;
    const ml = Math.hypot(mx, my);
    const mag = lobe * (1 - w) + w;
    const nx = ml > 1e-6 ? (mx / ml) * mag : 0;
    const ny = ml > 1e-6 ? (my / ml) * mag : 0;
    data[p] = Math.round(255 * (0.5 + 0.5 * Math.max(-1, Math.min(1, nx))));
    data[p + 1] = Math.round(255 * (0.5 + 0.5 * Math.max(-1, Math.min(1, ny))));
  }
  return {
    size: S, data,
    // 형태 게이트(순수 노드)가 읽는 실측값. 검증 대상과 제품 경로가 같은 함수가 되도록
    //   렌더러 없는 소비자에게 그대로 넘긴다.
    meta: {
      family, seed, mirror: !!mirror, plinthR: spec.plinthR, domR: spec.domR, nPlinth: spec.nPlinth,
      domRatio: spec.plinthR > 0 ? spec.domR / spec.plinthR : 0,
      rawComponents: stats.components, isolatedPx: stats.isolatedPx, holeFillPx: stats.holePx,
      wispPx: stats.wispPx, wispDropPx: stats.wispDropPx, wispBand: spec.wispBand,
      threshold: TH, feather: FE,
    },
  };
}

// ── 패밀리 아틀라스(#53 S6) ──────────────────────────────────────────────────
// 네 패밀리를 2×2 로 한 장에 담는다. 층마다 텍스처를 따로 굽는 대신 아틀라스를 두는 이유는 원경 뱅크가
//   InstancedMesh(1 드로우콜) 라서 인스턴스별로 map 을 바꿀 수 없기 때문이다 — A3 의 뱅크 16 장은
//   전부 같은 텍스처였고, 그것이 "한 프레임에 같은 형상 3 개"의 직접 원인이다. 타일 사각형을
//   인스턴스 속성으로 내리면 드로우콜·재질·프로그램 계열은 그대로이고 텍스처 메모리만 쓴다.
// 타일 좌표는 uv 로 내려가므로 실루엣이 타일 경계에 닿으면 밉/바이리니어에서 이웃 타일이 새어든다.
//   fit 단계가 각 실루엣을 ≥2% 여백 안에 넣고 셰이더가 타일 내부로 clamp 하므로 그 경계는 알파 0 이다.
export const CLOUD_ATLAS_COLS = 2;
export function cloudAtlasRect(tile) {
  const i = ((tile | 0) % (CLOUD_ATLAS_COLS * CLOUD_ATLAS_COLS) + 4) % 4;
  const scale = 1 / CLOUD_ATLAS_COLS;
  return { x: (i % CLOUD_ATLAS_COLS) * scale, y: Math.floor(i / CLOUD_ATLAS_COLS) * scale, scale };
}

// 아틀라스 타일 = 패밀리 순서. 시드는 타일마다 다르게 두되 패밀리가 문법을 이미 갈라놓았으므로
//   시드는 잔결 변주만 담당한다(A2 의 실패: 시드만으로는 문법이 갈리지 않는다).
export const CLOUD_ATLAS_TILES = Object.freeze(CLOUD_FAMILY_ORDER.map((family, i) => ({
  tile: i, family, seed: [11, 29, 47, 63][i],
})));

export function bakeCloudAtlas(T = CLOUD_TEX_SIZE) {
  const S = T * CLOUD_ATLAS_COLS;
  const data = new Uint8Array(S * S * 4);
  const tiles = [];
  for (const t of CLOUD_ATLAS_TILES) {
    const baked = bakeCloudData(t.seed, t.family, T);
    const ox = (t.tile % CLOUD_ATLAS_COLS) * T, oy = Math.floor(t.tile / CLOUD_ATLAS_COLS) * T;
    for (let y = 0; y < T; y++) {
      const src = y * T * 4, dst = ((oy + y) * S + ox) * 4;
      data.set(baked.data.subarray(src, src + T * 4), dst);
    }
    tiles.push({ ...t, meta: baked.meta });
  }
  return { size: S, tileSize: T, data, tiles };
}

function makeCloudAtlasTexture() {
  const { size, data } = bakeCloudAtlas();
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;      // RGB 는 법선·AO 데이터 — sRGB 디코딩 금지
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;               // 원경 뱅크 인스턴스는 화면에서 작다(에일리어싱 방어)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ── v4 볼류메트릭 임포스터 기본값(#53 S4) ─────────────────────────────────────
// v3 는 쿼드당 데이터 1탭 = **평면 한 장**이었다. 사용자 판정("최근 재작한 구름이 최종 클립에서
//   영 어색하다", 2026-08-04)의 직접 원인이 그 평면성이다: 시선각이 바뀌어도 내부 명암이 고정이고,
//   두께가 없으니 태양 방향 자기그림자도 없다 → 종이 판으로 읽힌다.
// v4 는 같은 쿼드 안에서 8~16 스텝 의사 3D 레이마칭을 돈다. 새 패스·새 재질·새 프로그램 계열은
//   없고(캐시 키만 v3→v4 승급), 베이크 파이프라인·그림자 계약(uCloudBlobs)·색 uniform 세트는
//   그대로다 — 환경 크로스페이드 배선도 무변경.
//   · 밀도 상한 = 베이크 실루엣(a). 마칭은 실루엣 밖으로 새지 않는다(형태·위상 계약 불침해).
//   · 수직 감쇠 = 천공 개방도(b). 위쪽 밀도에 가린 샘플은 태양·하늘광을 덜 받는다.
//   · 내부 결 = 절차 fbm 2옥타브(uCloudTime 저속 표류). 확대·시선각 변화에서 결이 흐른다.
// **strength(=uCloudMarch.x) 0 이면 아래 v3 식이 항등식으로 복원된다** — 프로그램이 하나뿐이므로
//   같은 페이지·같은 프로그램 안에서 런타임 A/B 가 성립한다(레포 규약: 페이지 간 비교 금지, 그리고
//   프로그램 캐시가 구 프로그램을 서빙하는 함정 자체가 사라진다).
export const CLOUD_MARCH_MAX_STEPS = 16;   // GLSL 루프 상한(상수 — 스텝 수는 uniform 으로만 내린다)
export const CLOUD_MARCH_DEFAULTS = Object.freeze({
  strength: 1,        // 0 = v3 평면 셰이딩(대조군), 1 = v4 전량
  thickness: 0.55,    // 슬랩 반두께 = 0.5 × 이 값 × min(쿼드 폭, 높이)
  steps: 12,          // 데스크톱 기본. 모바일·저사양은 setCloudVolume({ steps: 8 }) 로 강등
  optical: 5,         // 전밀도 광선이 슬랩을 수직 관통할 때의 광학 두께(무차원 — 스케일 불변)
  lateral: 3.4,       // 결 주파수(uv 단위)
  depth: 2.1,         // 결 주파수(두께 방향)
  amp: 0.42,          // 결 침식 강도(1 이면 결이 밀도를 0 까지 깎는다)
  alphaBlend: 0.55,   // 베이크 알파 → 마칭 커버리지 혼합(1 이어도 베이크 알파가 상한)
  lod: 1.6,           // 밀도 상한 탭의 밉 레벨(에일리어싱·텍스처 캐시 방어)
  lightStep: 0.62,    // 태양 방향 2차 탭 거리(반두께 배수)
  lightK: 2.6,        // 2차 탭 Beer 계수(자기그림자 세기)
  drift: 0.013,       // 결 표류 속도(uv/초 — 룩 문법 "미세 스케일". SHOT 은 t=0 이라 정지)
});

// 구름 빌보드 한 장의 라이팅 전부를 이 패치가 소유한다(새 패스·새 재질 계열 0, 드로우콜 불변).
//   map 의 RGB 는 색이 아니라 bakeCloudData 가 구운 데이터(법선 xy·천공 개방도)이므로 여기서
//   diffuseColor.rgb 를 **덮어쓴다**. 재질 color(=diffuse)는 시간대 밝기(dim)·부감 감쇠 전용
//   스칼라 캐리어로 남고, 색상(볕면·그늘면·림)은 uniform 에서 온다.
//   ① 볕면/그늘면: 베이크 법선 · 뷰공간 태양 방향. 빌보드는 카메라를 보므로 뷰공간 ≈ 빌보드 접평면.
//   ② 역광 게이트: 뷰공간 태양 z<0 = 태양이 카메라 앞(=피사체 뒤) → 그때만 림·투과가 선다.
//      레포 확정 결정("림은 광학적으로 실재해야 한다")을 구름에도 적용 — 순광·정오엔 0 이다.
//   ③ 투과광: 역광에서 얇은 부분(코어 두께 낮음)이 태양색으로 타오른다. 코어에도 바닥을 둬
//      역광 구름이 회색 실루엣으로 죽지 않게 한다(석양 구름은 흰색도 회색도 아니다).
//   ④ 부피(FIX④ 2026-08-03): 볕면/그늘면은 베이크된 **로브 법선**으로 계산한다. 랩 램버트로
//      종단을 부드럽게 하고, 역광에서는 투과광 바닥을 올려 코어의 −ndl 변주가 지워지지 않게
//      한다 — 1 차는 두 항이 코어에서 각각 0 과 0.14 로 눌려 바디가 단일 램프로 평평했다.
function patchCloudRim(material, { width = 1, height = 1, tile = 0, mirror = 1 } = {}) {
  const d = CLOUD_MARCH_DEFAULTS;
  const rect = cloudAtlasRect(tile);
  const state = {
    color: new THREE.Color(0xffc68c),                    // 림(은·금테) — tools 가 이 키를 읽는다
    strength: { value: 0 },
    direction: new THREE.Vector3(0.8, 0.4, -0.45).normalize(),   // 뷰공간 태양 방향(z<0 = 역광)
    texel: new THREE.Vector2(1.8 / CLOUD_TEX_SIZE, 1.8 / CLOUD_TEX_SIZE),
    sun: new THREE.Color(0xfff1e0),                      // 볕면 직사색
    shade: new THREE.Color(0xc6ccd6),                    // 그늘면 = 하늘 산란색
    // x=직사 y=천공 z=역광 투과 w=다중산란 바닥(밝은 낮에만 — FIX⑥ day 존재감)
    gain: new THREE.Vector4(1, 0.82, 0.75, 0),
    // ── v4 ── 쿼드의 저작 크기(월드). 정점 셰이더가 여기에 인스턴스 스케일을 곱해 실제 월드 폭·높이를
    //   varying 으로 넘긴다 → 상공 적운(150×108)과 원경 뱅크(16×11, 인스턴스 스케일 0.82~1.18)가
    //   같은 코드로 자기 크기에 맞는 슬랩을 마칭한다.
    quad: new THREE.Vector2(width, height),
    march: new THREE.Vector4(d.strength, d.thickness, d.steps, d.optical),
    detail: new THREE.Vector4(d.lateral, d.depth, d.amp, d.alphaBlend),
    volume: new THREE.Vector4(d.lod, d.lightStep, d.lightK, d.drift),
    // 아틀라스 타일 사각형과 미러 부호(xy=오프셋 z=배율 w=±1). 인스턴싱 재질은 정점 속성이 이 값을
    //   덮으므로(원경 뱅크 16 장이 서로 다른 타일) 여기 값은 비인스턴싱 상공 빌보드용이다.
    tile: new THREE.Vector4(rect.x, rect.y, rect.scale, mirror < 0 ? -1 : 1),
    time: { value: 0 },
  };
  material.userData.cloudRim = state;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudRimColor = { value: state.color };
    shader.uniforms.uCloudRimStrength = state.strength;
    shader.uniforms.uCloudSunDir = { value: state.direction };
    shader.uniforms.uCloudTexel = { value: state.texel };
    shader.uniforms.uCloudSunColor = { value: state.sun };
    shader.uniforms.uCloudShadeColor = { value: state.shade };
    shader.uniforms.uCloudGain = { value: state.gain };
    shader.uniforms.uCloudQuad = { value: state.quad };
    shader.uniforms.uCloudMarch = { value: state.march };
    shader.uniforms.uCloudDetail = { value: state.detail };
    shader.uniforms.uCloudVolume = { value: state.volume };
    shader.uniforms.uCloudTile = { value: state.tile };
    shader.uniforms.uCloudTime = state.time;
    // 정점: 쿼드 접평면 기저(뷰공간)와 뷰공간 위치. 마칭축을 **뷰공간 고정**으로 두는 이유는 카메라
    //   대면 쿼드가 회전할 때 마칭 방향이 함께 돌면 결이 화면에 붙어 미끄러지기 때문이다(조사 §5 위험).
    //   USE_INSTANCING 분기는 컴파일 타임이라 프로그램 계열은 기존과 동일하게 재질당 하나다.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform vec2 uCloudQuad;
uniform vec4 uCloudTile;
#ifdef USE_INSTANCING
  attribute vec4 aCloudTile;      // 인스턴스별 아틀라스 타일 + 미러(원경 뱅크 전용 속성)
#endif
varying vec4 vCloudAxisX;
varying vec4 vCloudAxisY;
varying vec3 vCloudView;
varying vec4 vCloudTile;
varying vec2 vCloudLocal;`,
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  {
    mat4 cloudModelView = modelViewMatrix;
    #ifdef USE_INSTANCING
      cloudModelView = modelViewMatrix * instanceMatrix;
    #endif
    vec3 cloudColX = (cloudModelView * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
    vec3 cloudColY = (cloudModelView * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    float cloudScaleX = max(1e-5, length(cloudColX));
    float cloudScaleY = max(1e-5, length(cloudColY));
    vCloudAxisX = vec4(cloudColX / cloudScaleX, cloudScaleX * uCloudQuad.x);
    vCloudAxisY = vec4(cloudColY / cloudScaleY, cloudScaleY * uCloudQuad.y);
    vCloudView = (cloudModelView * vec4(transformed, 1.0)).xyz;
    // 아틀라스 매핑은 여기서 한 번만 한다. vMapUv 를 타일 좌표로 옮겨 두면 프래그먼트의 모든
    //   샘플링(밀도 상한·2차 탭·에지 탭)이 그대로 타일 안을 보므로 마칭 코드가 아틀라스를 모른다.
    //   미러는 uv.x 반사로 걸고(부호는 varying 으로 넘겨 법선 x·마칭 x 를 함께 뒤집는다) 인스턴스
    //   행렬에 음의 스케일을 주지 않는다 — 그러면 와인딩이 뒤집혀 FrontSide 뱅크가 통째로 컬링된다.
    vec4 cloudTile = uCloudTile;
    #ifdef USE_INSTANCING
      cloudTile = aCloudTile;
    #endif
    vCloudTile = cloudTile;
    #ifdef USE_MAP
      vCloudLocal = vMapUv;
      vec2 cloudTileUv = vMapUv;
      if (cloudTile.w < 0.0) cloudTileUv.x = 1.0 - cloudTileUv.x;
      vMapUv = cloudTile.xy + cloudTileUv * cloudTile.z;
    #else
      vCloudLocal = vec2(0.5);
    #endif
  }`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec3 uCloudRimColor;
uniform float uCloudRimStrength;
uniform vec3 uCloudSunDir;
uniform vec2 uCloudTexel;
uniform vec3 uCloudSunColor;
uniform vec3 uCloudShadeColor;
uniform vec4 uCloudGain;
uniform vec4 uCloudMarch;
uniform vec4 uCloudDetail;
uniform vec4 uCloudVolume;
uniform float uCloudTime;
varying vec4 vCloudAxisX;
varying vec4 vCloudAxisY;
varying vec3 vCloudView;
varying vec4 vCloudTile;
varying vec2 vCloudLocal;
const int CHEOMA_CLOUD_STEPS_MAX = ${CLOUD_MARCH_MAX_STEPS};
// 내부 결 전용 값 노이즈. sin 해시를 피한 정수 fract 해시(모바일 정밀도·드라이버 편차 방어).
float cheomaCloudHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.1137, 0.4193));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float cheomaCloudNoise(vec3 x) {
  vec3 cell = floor(x);
  vec3 frc = fract(x);
  frc = frc * frc * (3.0 - 2.0 * frc);
  float n000 = cheomaCloudHash(cell);
  float n100 = cheomaCloudHash(cell + vec3(1.0, 0.0, 0.0));
  float n010 = cheomaCloudHash(cell + vec3(0.0, 1.0, 0.0));
  float n110 = cheomaCloudHash(cell + vec3(1.0, 1.0, 0.0));
  float n001 = cheomaCloudHash(cell + vec3(0.0, 0.0, 1.0));
  float n101 = cheomaCloudHash(cell + vec3(1.0, 0.0, 1.0));
  float n011 = cheomaCloudHash(cell + vec3(0.0, 1.0, 1.0));
  float n111 = cheomaCloudHash(cell + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, frc.x), mix(n010, n110, frc.x), frc.y),
    mix(mix(n001, n101, frc.x), mix(n011, n111, frc.x), frc.y),
    frc.z);
}
float cheomaCloudGrain(vec3 p) {
  return 0.63 * cheomaCloudNoise(p)
       + 0.37 * cheomaCloudNoise(p * 2.13 + vec3(7.31, 2.17, 4.53));
}
// 밀도장 1샘플. 상한은 베이크 실루엣(a), 두께는 |zN|<=1 셸, 결은 fbm. 같은 탭의 b(천공 개방도)를
//   out 으로 돌려주므로 수직 감쇠에 추가 탭이 들지 않는다. 마칭 중 흐름이 갈리므로 밉은 항상
//   명시(textureLod) — 암시적 도함수 밉은 분기 안에서 정의되지 않는다.
float cheomaCloudField(sampler2D cloudTex, vec2 uvp, float zN, float lod, float amp,
                       vec3 grain, out float openSky) {
  // clamp 는 **타일 안쪽**이다. 아틀라스에서 타일 밖으로 새면 이웃 패밀리의 실루엣을 빨아 온다.
  vec2 cloudPad = vec2(0.006 * vCloudTile.z);
  vec2 tap0 = vCloudTile.xy + cloudPad;
  vec2 tap1 = vCloudTile.xy + vec2(vCloudTile.z) - cloudPad;
  vec4 tap = textureLod(cloudTex, clamp(uvp, tap0, tap1), lod);
  openSky = tap.b;
  float bound = tap.a;
  if (bound <= 0.004) return 0.0;
  float halfT = sqrt(bound);                       // 상한이 두꺼운 곳이 깊다 → 외곽은 둥글게 닫힌다
  float dens = bound * (1.0 - smoothstep(halfT * 0.28, halfT, abs(zN)));
  if (dens <= 0.0) return 0.0;
  if (amp > 0.001) {
    float grainV = cheomaCloudGrain(vec3(uvp * uCloudDetail.x, zN * uCloudDetail.y) + grain);
    dens *= max(0.0, 1.0 - amp * (1.0 - grainV));
  }
  return dens;
}`,
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
#ifdef USE_MAP
  vec4 cloudData = texture2D(map, vMapUv);
  // 베이크 법선은 텍스처 좌표계다. 미러 타일은 텍스처 +x 가 쿼드 −x 이므로 x 성분을 함께 뒤집어야
  //   볕면·그늘면이 좌우 반전된 실루엣과 맞는다(안 뒤집으면 태양 쪽 어깨가 그늘로 칠해진다).
  vec2 cloudNxy = (cloudData.rg * 2.0 - 1.0) * vec2(vCloudTile.w, 1.0);
  float cloudSlope = min(1.0, length(cloudNxy));
  vec3 cloudNormal = vec3(cloudNxy, sqrt(max(0.0, 1.0 - cloudSlope * cloudSlope)));
  // 두께 프록시. 베이크가 법선 길이를 두 구간으로 나눠 인코딩한다 — 내부 로브 기울기는 [0,0.46],
  //   실루엣 근접도는 그 위. 그래서 '얇은 곳'은 0.52 부터다(예전 pow 역함수는 로브 기울기까지
  //   얇은 것으로 읽어 코어 전체가 투과광으로 타올랐다).
  float cloudThin = smoothstep(0.52, 0.97, cloudSlope);
  vec3 cloudSunV = normalize(uCloudSunDir);
  float cloudNdl = dot(cloudNormal, cloudSunV);
  float cloudBack = smoothstep(0.10, -0.42, cloudSunV.z);
  float cloudSky = cloudData.b;
  // 화면 방위 기준 태양 쪽인가(구름 중심 → 이 픽셀 방향 · 태양 방위). 림뿐 아니라 투과광도 이
  //   항을 쓴다: 전방산란 로브는 태양 방향에 몰려 있으므로 역광 구름은 태양 쪽 어깨가 타오르고
  //   반대쪽은 식는다. 이 가중치가 없으면 -ndl 이 큰 **반대쪽**이 오히려 더 웜해져 볕면/그늘면이
  //   뒤집힌다(순수 노드 시뮬 실측: 그늘 밴드 R−B +24.8 로 볕면 +19.5 를 추월).
  vec2 cloudRadial = normalize(vCloudLocal - vec2(0.5) + vec2(1e-4));
  float cloudSunSide = smoothstep(-0.26, 0.64, dot(cloudRadial, normalize(cloudSunV.xy + vec2(1e-4))));
  // ── v4 쿼드 내 의사 3D 레이마칭 ─────────────────────────────────────────────
  // 쿼드 접평면(x,y)+법선(z)을 축으로 두께 2·halfT 슬랩을 뚫는다. 시선이 기울면 광로가 길어지고
  //   측면으로 밀려 **시차**가 생기고(평면성 해소), 스텝마다 태양 방향 2차 탭으로 Beer 감쇠를 재
  //   **자기그림자**가 생긴다. 결(fbm)은 두께 방향으로도 변하므로 내부 명암이 변조된다.
  float cloudMarchW = clamp(uCloudMarch.x, 0.0, 1.0);
  float cloudCover = cloudData.a;      // 마칭 커버리지(코어에서 1 → 베이크 알파와 일치)
  float cloudLitAvg = 1.0;             // 태양 가시도(자기그림자) — 투과율 가중 평균
  float cloudSkyAvg = cloudSky;
  float cloudThinRay = cloudThin;      // 광선 광학두께에서 나온 '얇음'(시선각 의존)
  if (cloudMarchW > 0.001) {
    vec3 cloudAxX = normalize(vCloudAxisX.xyz);
    vec3 cloudAxY = normalize(vCloudAxisY.xyz);
    vec3 cloudAxZ = normalize(cross(cloudAxX, cloudAxY));
    float cloudQW = max(1e-3, abs(vCloudAxisX.w));
    float cloudQH = max(1e-3, abs(vCloudAxisY.w));
    float cloudHalfT = max(0.05, uCloudMarch.y * 0.5 * min(cloudQW, cloudQH));
    vec3 cloudRayL = vec3(0.0);
    {
      vec3 cloudRay = normalize(vCloudView);        // 카메라 → 이 프래그먼트(뷰공간)
      cloudRayL = vec3(dot(cloudRay, cloudAxX), dot(cloudRay, cloudAxY), dot(cloudRay, cloudAxZ));
    }
    // 스침각에서 광로가 발산하지 않게 하한을 둔다(측면 이탈량 유계 — 결이 화면을 가로질러 늘어나는
    //   스트레치 방지). DoubleSide 뒷면도 부호만 반대라 같은 식으로 성립한다.
    float cloudRayZ = max(0.22, abs(cloudRayL.z));
    float cloudSpan = 2.0 * cloudHalfT / cloudRayZ;
    int cloudSteps = int(clamp(uCloudMarch.z, 4.0, float(CHEOMA_CLOUD_STEPS_MAX)));
    float cloudDs = cloudSpan / float(cloudSteps);
    // 광학 두께는 **슬랩 두께로 정규화**한다. 월드 단위 소멸계수를 쓰면 폭 150m 적운과 폭 16m 뱅크가
    //   같은 uniform 에서 전혀 다른 불투명도를 갖는다(뱅크가 통째로 투명해진다).
    float cloudOptK = uCloudMarch.w / (2.0 * cloudHalfT);
    // 광로의 uv 이동은 쿼드 공간 → 텍스처 공간 변환이 필요하다: 미러면 x 가 뒤집히고, 아틀라스면
    //   타일 배율만큼 줄어든다(1 타일 = uv 0.5). 이 두 인자를 빠뜨리면 시차가 이웃 타일로 새거나
    //   두 배로 흐른다.
    vec2 cloudUvRate = vec2(cloudRayL.x / cloudQW * vCloudTile.w, cloudRayL.y / cloudQH)
      * vCloudTile.z;
    float cloudZRate = cloudRayL.z / cloudHalfT;
    float cloudS = -0.5 * cloudSpan + 0.5 * cloudDs;   // 슬랩 진입점(쿼드 평면 교차가 s=0)
    vec2 cloudUv = vMapUv + cloudUvRate * cloudS;
    float cloudZ = cloudZRate * cloudS;
    vec3 cloudGrainOff = uCloudTime * uCloudVolume.w * vec3(1.0, -0.62, 0.41);
    vec3 cloudSunL = vec3(dot(cloudSunV, cloudAxX), dot(cloudSunV, cloudAxY), dot(cloudSunV, cloudAxZ));
    float cloudLightD = uCloudVolume.y * cloudHalfT;
    vec2 cloudLightUv = vec2(cloudSunL.x / cloudQW * vCloudTile.w, cloudSunL.y / cloudQH)
      * cloudLightD * vCloudTile.z;
    float cloudLightZ = (cloudSunL.z / cloudHalfT) * cloudLightD;
    float cloudTrans = 1.0;
    float cloudWsum = 0.0, cloudLitSum = 0.0, cloudSkySum = 0.0, cloudTau = 0.0;
    for (int cloudI = 0; cloudI < CHEOMA_CLOUD_STEPS_MAX; cloudI++) {
      if (cloudI >= cloudSteps) break;               // 스텝 수는 uniform — 프로그램 분기 없음
      float cloudOpenHere;
      float cloudDens = cheomaCloudField(map, cloudUv, cloudZ, uCloudVolume.x,
                                         uCloudDetail.z, cloudGrainOff, cloudOpenHere);
      if (cloudDens > 0.0) {
        float cloudTauStep = cloudDens * cloudDs * cloudOptK;
        float cloudAStep = 1.0 - exp(-cloudTauStep);
        float cloudWStep = cloudTrans * cloudAStep;   // front-to-back 방출·흡수 가중
        float cloudOpenLight;
        // 2차 탭은 저주파 형상만 본다(amp 0) — 결까지 그림자를 재면 스텝당 fbm 이 두 배인데
        //   지각 이득은 없다. 밉을 한 단 올려 자기그림자를 부드럽게 유지한다.
        float cloudDensLight = cheomaCloudField(map, cloudUv + cloudLightUv, cloudZ + cloudLightZ,
                                                uCloudVolume.x + 0.75, 0.0, cloudGrainOff,
                                                cloudOpenLight);
        float cloudLit = exp(-uCloudVolume.z * cloudDensLight) * mix(0.34, 1.0, cloudOpenHere);
        cloudWsum += cloudWStep;
        cloudLitSum += cloudWStep * cloudLit;
        cloudSkySum += cloudWStep * cloudOpenHere;
        cloudTau += cloudTauStep;
        cloudTrans *= 1.0 - cloudAStep;
        if (cloudTrans < 0.03) break;                // 조기 종료(불투명 코어)
      }
      cloudUv += cloudUvRate * cloudDs;
      cloudZ += cloudZRate * cloudDs;
    }
    cloudCover = clamp(1.0 - cloudTrans, 0.0, 1.0);
    if (cloudWsum > 1e-4) {
      cloudLitAvg = cloudLitSum / cloudWsum;
      cloudSkyAvg = cloudSkySum / cloudWsum;
    }
    cloudThinRay = exp(-cloudTau * 0.9);
  }
  // 마칭 산출물 적용. cloudMarchW=0 이면 세 식 모두 항등식이라 v3 셰이딩이 비트 동일로 남는다.
  cloudSky = mix(cloudSky, cloudSkyAvg, cloudMarchW * 0.70);
  // 자기그림자는 **중간값 보존** 변조다(0.55 + 0.90·0.5 = 1.0): 태양을 향한 로브는 밝아지고 가려진
  //   안쪽은 어두워지되 전체 노출은 유지된다 — 밝기 회귀 없이 부피 모델링만 얻는다.
  float cloudSelf = mix(1.0, 0.55 + 0.90 * cloudLitAvg, cloudMarchW);
  // 광선 기반 '얇음'은 제곱해서 섞는다. 중간 두께(≈0.3)가 그대로 들어가면 역광에서 바디까지 투과광이
  //   번져 "한 덩어리 주황"이 된다(FIX⑤ 가 경고한 회귀). 제곱은 진짜 외곽만 남긴다.
  cloudThin = mix(cloudThin, max(cloudThin, cloudThinRay * cloudThinRay), cloudMarchW);
  // 랩 램버트 + 다중산란 바닥. 구름은 다중산란체라 종단이 부드럽고, 밝은 낮에는 태양을 등진 면도
  //   하얗게 밝다 — 그 바닥(uCloudGain.w, 낮에만 켜진다)이 없으면 낮 구름이 하늘보다 어두워진다.
  float cloudWrap = smoothstep(-0.86, 0.52, cloudNdl);
  float cloudDirect = (uCloudGain.w + (1.0 - uCloudGain.w) * cloudWrap * cloudWrap)
                    * mix(0.58, 1.0, cloudSky) * cloudSelf;
  // 하늘광은 광로가 짧은 외곽에서 살짝 들리고 두꺼운 안쪽에서 살짝 눌린다(내부 AO). 진폭이 작은
  //   이유는 그늘면 채도 규율 때문이다 — 그늘을 더 어둡게 만드는 것이 목적이 아니다.
  float cloudAmbient = (0.52 + 0.48 * cloudSky)
                     * mix(1.0, 0.90 + 0.16 * cloudThinRay, cloudMarchW);
  // 투과광은 얇은 부분이 강하고, 위쪽 밀도에 가린 밑면은 태양광이 도달하지 못하므로 천공
  //   개방도로도 눌러야 한다. 이 항을 빼면 역광 프레임에서 밑면까지 웜으로 물들어 구름 전체가
  //   한 덩어리 주황이 된다. 코어 바닥 0.38 은 부피용이다 — 로브별 −ndl 변주(역광에서 유일하게
  //   남는 셰이딩 신호)를 살리려면 코어에도 실질 가중이 있어야 한다.
  float cloudGlow = pow(max(0.0, -cloudNdl), 1.30) * mix(0.38, 1.0, cloudThin)
                  * mix(0.34, 1.0, cloudSky) * mix(0.24, 1.0, cloudSunSide) * cloudBack;
  vec3 cloudBody = uCloudShadeColor * (cloudAmbient * uCloudGain.y)
                 + uCloudSunColor * (cloudDirect * uCloudGain.x + cloudGlow * uCloudGain.z);
  // 에지 탭도 아틀라스 배율을 타야 한다(타일 uv 1 = 아틀라스 uv 0.5). 방향 대칭이라 미러는 무관.
  vec2 cloudEdgeTexel = uCloudTexel * vCloudTile.z;
  float cloudNearA = min(
    min(texture2D(map, vMapUv + vec2(cloudEdgeTexel.x, 0.0)).a,
        texture2D(map, vMapUv - vec2(cloudEdgeTexel.x, 0.0)).a),
    min(texture2D(map, vMapUv + vec2(0.0, cloudEdgeTexel.y)).a,
        texture2D(map, vMapUv - vec2(0.0, cloudEdgeTexel.y)).a)
  );
  float cloudEdge = smoothstep(0.07, 0.62, cloudData.a)
                  * (1.0 - smoothstep(0.24, 0.88, cloudNearA));
  // 림 방위·높이 가중을 좁힌다(FIX⑤): 새벽 프레임에서 림이 둘레 전체 키라인으로 읽혔다. 반태양
  //   쪽 바닥 0.08→0.03, 방위 램프에 pow 1.5, 밑면 크라운 바닥 0.68→0.42 — 실제 구름은 가장
  //   두꺼운 밑면 윤곽에 금테가 서지 않는다.
  float cloudCrown = mix(0.42, 1.0, smoothstep(0.28, 0.84, vCloudLocal.y));
  diffuseColor.rgb = diffuse * cloudBody
                   + uCloudRimColor * uCloudRimStrength * cloudEdge
                   * mix(0.03, 1.0, pow(cloudSunSide, 1.5)) * cloudCrown * cloudBack;
  // 실루엣 알파도 광로 커버리지와 섞는다. 얇은 어깨·외곽은 광로가 짧아 저절로 투명해져 "종이 컷아웃"
  //   윤곽이 부피로 풀린다. 곱셈 형태라 베이크 알파가 항상 상한이다 → 실루엣 계약(형태·종횡비 게이트)
  //   은 침해되지 않고, 코어(cloudCover≈1)에선 계수 1.0 으로 무변경이다.
  diffuseColor.a *= mix(1.0, 0.30 + 0.70 * cloudCover,
                        cloudMarchW * clamp(uCloudDetail.w, 0.0, 1.0));
#endif`,
    );
  };
  // v4 → v5: 아틀라스 타일 매핑·미러·근접 클램프가 본문에 들어갔으므로 키를 승급한다. 프로그램
  //   **계열 수**는 그대로다 — 이 키를 쓰는 재질군이 하나이고, 인스턴싱 분기는 three 가 이미
  //   USE_INSTANCING 으로 키에 넣으므로 (상공 빌보드 1 계열 + 뱅크 1 계열) 구성이 유지된다.
  material.customProgramCacheKey = () => 'cheoma-cloud-shade-v5';
  return state;
}

function makeLightRayMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRayColor: { value: new THREE.Color(0xffcda0) },
      uRayOpacity: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform vec3 uRayColor;
      uniform float uRayOpacity;
      void main() {
        float across = pow(max(0.0, 1.0 - abs(vUv.x * 2.0 - 1.0)), 1.35);
        float along = smoothstep(0.0, 0.13, vUv.y) * (1.0 - smoothstep(0.68, 1.0, vUv.y));
        float airVariation = 0.82 + 0.18 * sin(vUv.y * 23.0 + vUv.x * 4.0);
        float alpha = across * along * airVariation * uRayOpacity;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(uRayColor * 1.08, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

function makeLightRayGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 1, 1,
  ], 2));
  geometry.setIndex([0, 2, 1, 2, 3, 1]);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
  return geometry;
}

// ── 유기적 저층 운해(雲海) 링 ───────────────────────────────────────────────
// worldedge 외곽선(edge.edgeRadiusAt)을 따라 도는 넓고 낮은 소프트 밴드 — 배산 능선 사면을
// 등고선을 따라 감아(groundY 샘플로 지형에 밀착) 산수화 여백으로 소실시킨다. env/terrain.js
// buildEdgeMist 의 발전형(단일 씬 것은 평지라 상수 y): 마을은 능선 낙차가 커서 지형 등고를
// 따라 떠야 부감에선 "능선을 감고" 아이레벨에선 "사면에 걸친 원경 물안개"로 함께 읽힌다.
//   buildEdgeMistRing(edge, { groundY, yBase, yAmp, rIn, rMid, rOut, opacity, thickness, seed })
//     groundY(x,z): 지형 표고 샘플러(있으면 밴드가 등고를 따라 뜸). 없으면 평지 상수 y.
//     rIn<rMid<rOut: edgeRadiusAt 대비 반경 배율 — rIn 을 작게(≈0.6) 잡아 능선 중턱까지 감는다.
//   → { mesh, update(fogColor) }  — 색은 대기(fog)색을 살짝 밝힌 톤(호출부가 매 틱 갱신).

// 테두리 행(rMid·rOut)이 등고를 따를 때의 표고 상한 = yCap × 이 배율. 자세한 유도는 함수 안
//   rimCapMul 주석에 있고, 값의 근거는 순수 노드 실측(2026-08-03, seed 20260716, NS=176 방위):
//   불투명 crest 행이 지형 절단면 아래로 묻힌 방위 비율이 배율 1.0(구 동작)에서
//     village 37.3% / capital 24.3% / hanyang 13.6%, 묻힌 깊이 p90 25.7 / 43.4 / 24.3 m 였다.
//   1.6 → 20.9 / 16.9 / 10.2%, 2.0 → 16.4 / 13.6 / 4.5%, **2.4 → 세 규모 전부 0%**,
//   2.8·∞ 는 미덮음이 더 줄지 않고 crest 만 4~11m 더 뜬다. 즉 2.4 는 "절단면을 다 덮는 최소
//   상승"이라는 프런티어 값이다. 능선 어깨의 얇음(strengthAt 의 pool)은 여전히 yCap 기준이라
//   상승 방위의 강도 w 는 median 0.27~0.30 (프레임 median 0.34~0.67) — 위치만 고쳐졌고 농도
//   분포는 그대로다.
export const EDGE_RIM_CAP_MUL = 2.4;

export function buildEdgeMistRing(edge, {
  groundY = null, yBase = 8, yAmp = 2.5, rIn = 0.6, rMid = 0.85, rOut = 1.12,
  opacity = 0.52, thickness = 3.0, outerDrop = 0, yCap = Infinity,
  rimCapMul = EDGE_RIM_CAP_MUL, seed = 1,
} = {}) {
  const NS = 176;
  const idx = [];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28, ph3 = rnd() * 6.28;
  // yCap: 운해가 고이는 최대 표고. 등고를 그대로 따라가면 밴드가 능선 정수리까지 올라타 부감에서
  //   산 사면 전체에 드리워 매스를 지운다(탁한 룩). 분지에 "고이는" 높이를 상한으로 두면 능선은
  //   운해 위로 솟고 낮은 절단면만 잠긴다 — 겸재 진경산수의 운무 절단.
  const gY = (x, z) => Math.min(groundY ? groundY(x, z) : 0, yCap);
  // ── 테두리 행 표고 캡(rimCapMul) ──────────────────────────────────────────────
  // yCap 은 "분지에 고이는 높이"인데, 그 값으로 **테두리 행(rMid·rOut)까지** 클램프하면 지형
  //   테두리 표고가 yCap 을 넘는 방위 — 즉 지형 절단이 배산 능선 어깨를 가로지르는 방위 — 에서
  //   불투명 crest 행이 지형면 **아래로** 들어간다. 링은 depthTest:true 이므로 그 방위에서 산에
  //   묻혀 한 픽셀도 그리지 못한다. 정작 절단면·수관 하드 에지가 있는 곳이 그 방위다.
  const rimCap = Number.isFinite(yCap) ? yCap * rimCapMul : yCap;
  const gYRim = (x, z) => Math.min(groundY ? groundY(x, z) : 0, rimCap);
  // ── 방위·고도 종속 두께(docs/oriental-painting-research.md §1·§4) ─────────────
  // 균등한 링은 부감에서 "회색 도넛"으로 읽힌다. 실제 운무는 냉기가 고이는 낮은 골에 두껍게 눌리고
  //   능선 어깨에서는 얇아져 산 매스가 안개 위로 솟는다. 그 법칙을 두 항으로 굽는다:
  //     pool  = 테두리 표고가 yCap 아래로 얼마나 잠겼는가(골=1, 능선 어깨=0)
  //     swirl = 저주파 하모닉(2/3/5θ) — 같은 표고에서도 밴드가 끊기고 뭉치게
  //   결과 strength 는 밴드의 반경 폭·수직 두께·불투명도를 함께 스케일한다. 불투명도는 셰이더가
  //   아니라 알파 텍스처의 u 축(강도 램프)으로 전달한다 — 새 재질·define·프로그램 분기 0.
  const depthSpan = Number.isFinite(yCap) ? Math.max(1, yCap * 0.55) : 0;
  //   ×NORM: 두 항의 곱은 평균이 0.6 부근이라 그대로 쓰면 링의 총 헤이즈 예산이 4할 줄어든다
  //     (야간 부감 평균 휘도 −27% 실측). 상한 1 에서 포화시키되 평균을 예전 균일값 근처로 되돌려,
  //     "총량은 같고 분포만 굽는" 변경이 되게 한다.
  // #20 운무 절단 강화: pool 을 제곱해 골(저표고)은 더 두껍고 능선 어깨는 더 얇게 — 산이 안개
  //   위로 솟는 선택적 절단(oriental-painting-research §1·§4). NORM 은 평균 헤이즈 예산을 유지.
  const strengthAt = (th, hEdge) => {
    const swirl = 0.5 + 0.5 * (
      0.52 * Math.sin(2 * th + ph1) + 0.30 * Math.sin(3 * th + ph2) + 0.18 * Math.sin(5 * th + ph3)
    );
    const poolLin = depthSpan > 0 ? Math.max(0, Math.min(1, (yCap - hEdge) / depthSpan)) : 1;
    const pool = poolLin * poolLin;
    const NORM = 1.48;
    return Math.max(0.12, Math.min(1, (0.22 + 0.78 * pool) * (0.50 + 0.64 * swirl) * NORM));
  };
  // 정점 채움을 한 함수로 둔다 — 같은 부팅 A/B 검증(아래 __edgeMist 훅)이 캡 배율만 바꿔 같은
  //   버퍼를 다시 쓸 수 있게 하려는 것이고, 제품 경로는 생성 시 1회만 호출한다(수치 불변).
  const pos = new Float32Array((NS + 1) * 9);
  const uv = new Float32Array((NS + 1) * 6);
  const fill = (capAt) => {
    for (let is = 0; is <= NS; is++) {
      const th = (is / NS) * Math.PI * 2;
      const Redge = edge.edgeRadiusAt(th);
      const cx = Math.cos(th), cz = Math.sin(th);
      // 저주파 리프트 출렁임(운해가 능선 등고를 따라 얇아지고 두꺼워짐). 정수 하모닉이라 2π 에서 닫힘.
      const lift = yBase + yAmp * (0.6 * Math.sin(2 * th + ph1) + 0.4 * Math.sin(3 * th + ph2));
      const hEdgeRaw = groundY ? groundY(cx * Redge * rMid, cz * Redge * rMid) : 0;
      const w = strengthAt(th, hEdgeRaw);
      // 얇은 방위는 반경 폭도 함께 좁힌다(rMid 로 수축) — 알파만 낮추면 넓고 흐린 얼룩이 남는다.
      const span = 0.42 + 0.58 * w;
      const rI = rMid + (rIn - rMid) * span;
      const rO = rMid + (rOut - rMid) * span;
      const th2 = thickness * (0.34 + 0.66 * w);
      // 각 행은 자기 반경의 지형 표고 + 리프트 위에 떠 등고를 따라 밴드가 드리운다(중간 행이 불투명).
      const xi = cx * Redge * rI,   zi = cz * Redge * rI;
      const xm = cx * Redge * rMid, zm = cz * Redge * rMid;
      const xo = cx * Redge * rO,   zo = cz * Redge * rO;
      //   테두리 두 행만 capAt(=gYRim) 으로 등고를 따른다. 내부 행과 strengthAt 의 pool 은 여전히
      //   yCap 기준이므로 방위별 두께·농도 분포("능선 어깨는 얇다")는 불변이고, 바뀌는 것은
      //   불투명 crest 행이 절단면 위로 나오는지 아래에 묻히는지 뿐이다.
      const yRim = capAt(xm, zm) + lift;
      const p = is * 9, q = is * 6;
      pos[p] = xi; pos[p + 1] = gY(xi, zi) + lift + th2; pos[p + 2] = zi;
      uv[q] = w; uv[q + 1] = 0;
      pos[p + 3] = xm; pos[p + 4] = yRim; pos[p + 5] = zm;
      uv[q + 2] = w; uv[q + 3] = 0.5;
      // 외곽 행은 지형이 끝난 밖이다. 거기서 자체 표고를 쓰면 해석적 산 함수가 계속 솟아 밴드가
      //   허공에 뜨거나 절단면 아래로 파고든다 → 테두리(rMid) 표고를 물려받아 밖으로 완만히
      //   내려앉게 한다(outerDrop). 절단면 밖에 고인 저층 안개로 읽혀 원반 경계를 지운다.
      pos[p + 6] = xo; pos[p + 7] = yRim - th2 * 0.6 - outerDrop * w; pos[p + 8] = zo;
      uv[q + 4] = w; uv[q + 5] = 1;
    }
  };
  fill(gYRim);
  for (let is = 0; is < NS; is++) {
    const a = is * 3, b = is * 3 + 3;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  // BufferAttribute 로 감싼다(Float32BufferAttribute 는 입력 배열을 **복사**하므로 아래 재채움이
  //   GPU 에 도달하지 못한다 — 검증 훅이 조용히 무효가 되는 함정이다).
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // 알파 룩업: v = 반경 방향 그라디언트(가운데 불투명 → 안·밖 투명), u = 방위별 강도 램프.
  //   정점이 uv.x 로 자기 방위의 strength 를 들고 오므로 두께·폭과 같은 계수로 농도가 함께 접힌다.
  //   u 축을 쓰지 않던 기존 텍스처를 2D 로 넓힌 것뿐이라 재질·프로그램·드로우콜은 그대로다.
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) {
    const v = (y + 0.5) / 64;
    // 기존 0 → 0.9 → 0 삼각 램프와 같은 프로파일(가운데 피크).
    const radial = 0.9 * (1 - Math.abs(v - 0.5) * 2);
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * radial * ((x + 0.5) / 64));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: 0xd6dde4, transparent: true, opacity, depthWrite: false,
    side: THREE.DoubleSide, fog: true,   // 초기색은 중립 헤이즈 — update(fogColor)가 대기색으로 갱신
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'edge-mist-ring';
  mesh.renderOrder = 2;
  mesh.userData.viewWeight = 1;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    // Camera looks down its local -Z axis. Reading matrixWorld directly avoids a
    // temporary Vector3 in this draw callback.
    const elements = camera?.matrixWorld?.elements;
    const weight = edgeMistViewWeight(elements ? -elements[9] : NaN);
    mesh.userData.viewWeight = weight;
    mat.opacity = opacity * weight;
  };
  const _c = new THREE.Color();
  const _white = new THREE.Color(0xffffff);
  let active = true;
  let resourcesDisposed = false;
  function update(fogColor) {
    if (!active) return;
    if (fogColor) { _c.copy(fogColor).lerp(_white, 0.11); mat.color.copy(_c); }
  }
  function deactivate() {
    if (!active) return;
    active = false;
    mesh.onBeforeRender = NOOP_BEFORE_RENDER;
    mesh.userData.viewWeight = 0;
    mat.opacity = 0;
  }
  // ── 검증 전용 훅(window.__edgeMist) ──────────────────────────────────────────
  // 테두리 캡은 **정점 표고**라 유니폼으로 바꿀 수 없다. 그런데 부감 프레이밍은 부팅마다 230~625m
  //   흔들려 부팅 간 픽셀 비교가 성립하지 않으므로, 같은 부팅에서 캡 배율만 바꿔 같은 버퍼를 다시
  //   채우는 경로가 있어야 A/B 가 통제된다. 재질·텍스처·인덱스·정점 수가 그대로라 드로우콜·프로그램
  //   수는 불변이고, 제품 경로는 이 훅을 호출하지 않는다.
  const posAttr = geo.getAttribute('position');
  function setRimCapMul(mul) {
    const m = Number.isFinite(mul) ? mul : rimCapMul;
    const cap = Number.isFinite(yCap) ? yCap * m : yCap;
    fill((x, z) => Math.min(groundY ? groundY(x, z) : 0, cap));
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return m;
  }
  let unregisterDebug = null;
  if (typeof window !== 'undefined') {
    const registry = window.__edgeMist || (window.__edgeMist = {
      rings: [],
      productRimCapMul: EDGE_RIM_CAP_MUL,
      setRimCapMul(mul) {
        const applied = this.rings.map((r) => r.setRimCapMul(mul));
        return { rings: applied.length, mul: applied[0] ?? null };
      },
    });
    const record = { setRimCapMul, get rimCapMul() { return rimCapMul; }, mesh };
    registry.rings.push(record);
    unregisterDebug = () => {
      const at = registry.rings.indexOf(record);
      if (at >= 0) registry.rings.splice(at, 1);
    };
  }
  function dispose() {
    if (resourcesDisposed) return;
    resourcesDisposed = true;
    deactivate();
    if (unregisterDebug) { unregisterDebug(); unregisterDebug = null; }
    disposeObjectTree(mesh);
  }
  return { mesh, update, deactivate, dispose };
}

// mistBillboards(기본 true): 산허리 물안개 빌보드 2장 생성 여부. 마을은 비정형 외곽선을 따르는
//   전용 운해 링(buildEdgeMistRing)이 그 역할을 대신하므로 false 로 옵트아웃(중복 제거·드로우콜 절약).
// ── 배산 능선 물안개(아이레벨용 카메라 대면 빌보드) ─────────────────────────
// 수평 운해 링은 부감에선 능선을 감지만 아이레벨에선 모서리만 보여 사라진다. 진입/골목 시점의
// 원경 물안개는 능선 사면에 "걸친" 수직 소프트 뱅크로 읽혀야 한다 → 카메라를 향하는(빌보드)
// FrontSide 소프트 플레인 몇 장을 명시 앵커에 띄운다(FrontSide 라 1 드로우콜/장, 정적 → shot 무관).
//   buildRidgeMist(anchors, { w, h, opacity, seed })
//     anchors: [{ x, y, z, w?, h?, op? }] — 호출부(populate)가 지형을 알고 근사면 중턱에 배치.
//   → { group, update(fogColor) }  — 색은 대기(fog)색과 동기(호출부가 매 틱).
// 정적 지형 물안개(운해 링과 동형): 단일 씬의 엣지 미스트처럼 지형 대기의 일부이므로 ?clouds=0
//   (표류 구름 옵트아웃)과 무관하게 항상 존재한다. 표류하는 산 구름·그림자만 setupClouds 가 옵트아웃.
export function buildRidgeMist(anchors = [], { w = 120, h = 42, opacity = 0.34, seed = 7 } = {}) {
  const root = new THREE.Group();
  root.name = 'ridge-mist';
  if (!anchors.length) return { group: root, update() {}, deactivate() {}, dispose() {} };
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const tex = makeCloudTexture(seed);
  const _up = new THREE.Vector3(0, 1, 0);
  const mats = [];
  const meshes = [];
  for (const a of anchors) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xd6dde4, transparent: true, opacity: (a.op != null ? a.op : opacity) * (0.85 + rnd() * 0.3),
      depthWrite: false, fog: true, side: THREE.FrontSide,   // 카메라 대면이라 뒷면 불필요 → 1 드로우콜
    });
    const ww = (a.w != null ? a.w : w) * (0.85 + rnd() * 0.35), hh = (a.h != null ? a.h : h) * (0.85 + rnd() * 0.3);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), mat);
    mesh.position.set(a.x, a.y, a.z);
    mesh.renderOrder = 2;
    const baseOpacity = mat.opacity;
    mesh.onBeforeRender = (rend, sc, cam) => {   // yaw 만 카메라로(직립 유지) — 사면에 걸친 수직 뱅크
      mesh.lookAt(cam.position.x, mesh.position.y, cam.position.z);
      mesh.up.copy(_up);
      // 시선각 가중치: 아이레벨 전강도 → 부감 바닥값(회색 얼룩 방지, 능선 겹침 완화는 유지).
      const el = cam?.matrixWorld?.elements;
      mat.opacity = baseOpacity * ridgeMistViewWeight(el ? -el[9] : NaN);
    };
    root.add(mesh);
    mats.push(mat);
    meshes.push(mesh);
  }
  const _c = new THREE.Color(), _white = new THREE.Color(0xffffff);
  let active = true;
  let resourcesDisposed = false;
  function update(fogColor) {
    // #31-4: 백색 리프트 0.14 → 0.04. 이 뱅크는 대기색보다 **밝게** 칠해져 있었고, #31-2 에서 노을
    //   대기색 명도를 35% 내리자(relL 0.362 → 0.237) 그 +14% 리프트가 상대적으로 훨씬 두드러졌다.
    //   결과가 능선 사면에 얹힌 창백한 분홍빛 얼룩이다 — 비전 4라운드가 두 번 지목했고(“화강암 돔이
    //   밝고 분홍”, 능선 위 슬리버), 픽셀 귀속 프로브가 두 bbox 모두 이 뱅크 소유로 확정했다
    //   (76.4% / 85.2%, 암반 지분 0%). 즉 화강암 문제가 아니라 이 뱅크의 리프트 문제였다.
    //   물안개는 대기보다 아주 약간만 밝아야 한다 — 0.04 는 뱅크가 사면과 분리돼 보이지 않으면서
    //   물안개 특유의 유백감만 남기는 값이다.
    if (active && fogColor) { _c.copy(fogColor).lerp(_white, 0.04); for (const m of mats) m.color.copy(_c); }
  }
  function deactivate() {
    if (!active) return;
    active = false;
    for (const mesh of meshes) mesh.onBeforeRender = NOOP_BEFORE_RENDER;
  }
  function dispose() {
    if (resourcesDisposed) return;
    resourcesDisposed = true;
    deactivate();
    disposeObjectTree(root);
    root.clear();
  }
  return { group: root, update, deactivate, dispose };
}

// ── 슬롯 위계(#53 S6) ─────────────────────────────────────────────────────────
// A3 의 다섯 슬롯은 폭 136~192(최대/최소 1.41 배)에 전부 같은 문법의 텍스처였다. 비전이 "크기 위계
//   없음"으로 판정한 것이 이 배치다 — 베이크 내부의 봉우리 위계(지배 로브 1.84~2.14 배)는 한 장 안의
//   위계일 뿐 **프레임 안의 위계**가 아니다. 그래서 슬롯을 지배(1) : 중형(2) : 소형 파편(2) 으로
//   재설계한다. 화면 크기는 쿼드 면적 × 베이크 커버리지이므로 두 축을 함께 본다
//   (실측 커버리지 towering 40.0% · anvil 28.4% · decked 22.6% · fractured 21.5%):
//     anvil 232×158·28.4% → 칠해지는 면적 10.4k   towering 168×124·40.0% → 8.3k
//     decked 150×132·22.6% → 4.5k                 fractured 100×94·21.5% → 2.0k
//   지배 : 최소 = 5.2 배(선형 2.3 배)이고 앞 넷의 합 25.2k 는 A3(26.1k)의 97% 다 — 위계는 생기고
//   하늘에 칠해지는 총량은 유지된다(A2 FIX⑥ 이 회복한 구름 존재감을 되돌리지 않는다).
// r·ang·y 는 A3 그대로다(그림자 블롭 배치·부감 게이트 계약). 바뀌는 것은 크기·패밀리·미러뿐이므로
//   같은 카메라 포즈에서 before/after 를 비교할 수 있다.
// tile = 아틀라스 패밀리 인덱스, mir = 미러. 인접 슬롯은 같은 (tile, mir) 를 쓰지 않는다.
export const HIGH_CLOUD_SPECS = Object.freeze([
  { r: 0.20, ang: 2.4, y: 82, w: 232, h: 158, op: 0.70, sp: 0.55, tile: 1, mir: -1 },
  { r: 0.46, ang: 5.6, y: 100, w: 150, h: 132, op: 0.66, sp: 0.42, tile: 2, mir: 1 },
  { r: 0.30, ang: 4.1, y: 90, w: 100, h: 94, op: 0.64, sp: 0.68, tile: 3, mir: -1 },
  { r: 0.55, ang: 1.0, y: 108, w: 168, h: 124, op: 0.60, sp: 0.5, tile: 0, mir: 1 },
  { r: 0.14, ang: 0.2, y: 76, w: 88, h: 84, op: 0.68, sp: 0.62, tile: 3, mir: 1 },
].map(Object.freeze));

// ── 뱅크 인스턴스 다양화(#53 S6) ──────────────────────────────────────────────
// A3 의 16 장은 **한 텍스처**를 공유하고 스케일만 0.82~1.18 로 흔들렸다. 화각 60° 안에 3~4 장이
//   들어오므로 비전이 본 "같은 형상 3 개, 같은 방향, 크기 위계 없음"은 정확히 이 배치의 결과다.
//   세 축을 서로 다른 주기로 돌려 프레임 안에서 반복이 보이지 않게 한다:
//     tile   4 종(패밀리)   주기 4 — 방위상 **인접한 인스턴스는 반드시 다른 패밀리**다
//     mirror ±1            주기 8 — 같은 (tile, mirror) 짝은 8 칸(=180°) 떨어져 한 프레임에 못 든다
//     size   5 역할         주기 5 — tile 과 서로소라 (tile, mirror, size) 조합이 16 칸 모두 다르다
//   크기 역할은 지배 1 : 중형 2 : 소형 2 로 위계를 만든다(면적비 최대 6.4 배). 롤은 ±3° 남짓 —
//   빌보드를 크게 돌리면 바닥선이 기울어 부자연스럽고, 이 정도가 "같은 방향" 반복만 깬다.
// elev 는 9~15° 대의 명시적 하늘 시점용이다. 저작된 24° 하향 마당 focus 는 이 밴드를 비껴가야
//   하므로(updateView 가 재운다) **최저 고도 0.160 은 A3 값 그대로** 두고 위로만 벌린다.
const HORIZON_BANK_ROLES = Object.freeze([
  { sx: 1.58, sy: 1.42, elev: 0.262, roll: -0.035 },   // 지배
  { sx: 0.70, sy: 0.72, elev: 0.176, roll: 0.052 },    // 소형
  { sx: 1.14, sy: 1.02, elev: 0.228, roll: 0.021 },    // 중형
  { sx: 0.62, sy: 0.66, elev: 0.160, roll: -0.048 },   // 소형(최저 고도 — A3 하한 유지)
  { sx: 0.96, sy: 1.08, elev: 0.205, roll: 0.038 },    // 중형(세로가 긴 쪽)
].map(Object.freeze));

// 뱅크 배치표(순수 함수). 게이트가 제품과 같은 함수에서 배정을 읽어 가도록 노출한다.
export function horizonBankSpecs(count) {
  return Array.from({ length: count }, (_, i) => {
    const role = HORIZON_BANK_ROLES[i % HORIZON_BANK_ROLES.length];
    return {
      az: 0.17 + i * Math.PI * 2 / count,
      elev: role.elev, sx: role.sx, sy: role.sy, roll: role.roll,
      tile: i % CLOUD_FAMILY_ORDER.length,
      mirror: (i % 8) < 4 ? 1 : -1,
    };
  });
}

// 쿼드 폭 ÷ 프레임 폭(그 깊이에서). 부감 프레임 정리와 근접 밀도 클램프가 같은 값을 읽어야 하므로
//   한 곳에서만 계산한다 — 두 곳에 같은 식을 쓰면 한쪽만 고쳐지는 표류가 실제로 있었다.
function cloudFrameFraction(mesh, cam) {
  const distance = cam.position.distanceTo(mesh.position);
  const verticalFov = Number.isFinite(cam.fov) ? cam.fov * Math.PI / 180 : 18 * Math.PI / 180;
  const aspect = Number.isFinite(cam.aspect) && cam.aspect > 0 ? cam.aspect : 16 / 9;
  const halfFrameAtDepth = distance * Math.tan(verticalFov * 0.5) * aspect;
  const halfW = (mesh.userData.w || 100) * 0.5;
  return halfFrameAtDepth > 1e-6 ? halfW / halfFrameAtDepth : Infinity;
}

// mistBillboards(기본 true): 산허리 물안개 빌보드 2장 생성 여부 — 마을은 전용 운해 링·능선 물안개가
//   대신하므로 false. highCloudCount(기본 4, 최대 MAX_CLOUD_BLOBS=5): 상공 뭉게구름 장수(=대응 그림자 블롭 수).
export function setupClouds(group, {
  sun, edge, terrainMax = 152, uniforms, mistBillboards = true, highCloudCount = 4,
  siteCenter = null, coverR = null, getHaze = null,
} = {}) {
  const u = uniforms || createCloudUniforms();
  const root = new THREE.Group();
  root.name = 'clouds';
  group.add(root);

  if (!CLOUDS_ON) {
    return {
      group: root, uniforms: u, update() {}, setEnabled() { root.visible = false; },
      setCloudVolume() { return { materials: 0 }; }, dispose() {},
    };
  }

  const R = terrainMax;
  const drift = new THREE.Vector2(0.92, 0.38).normalize();  // 표류 방향(월드 XZ)
  const perp = new THREE.Vector2(-drift.y, drift.x);         // 표류 수직(펼침 축)

  // ── 부감 프레임 정리(#81) ──────────────────────────────────────────────────
  // 마을 부감은 카메라가 구름층(y≈76~108) 높이에 걸쳐 마을을 내려다본다. 그러면 마을 중앙 상공에
  //   깔린 뭉게구름 빌보드가 시선을 가로막아 "형태 없는 흰 블롭"으로 프레임을 갉아먹는다(모바일 세로에서
  //   특히). 해법: 카메라가 이 구름을 '내려다보는'(구름이 시선 아래로 내려가 지형에 겹치는) 정도만큼
  //   빌보드 불투명도를 낮춰 프레임을 비운다. 카메라가 구름을 '올려다보는'(구름이 하늘에 뜬) 단일건물·
  //   아이레벨·focus-in 클로즈업에선 g≈0 이라 완전 불변 → 하늘 뭉게구름 유지. 그림자(uCloudBlobs)는
  //   건드리지 않아 부감엔 "구름 없이 지면을 흐르는 그늘"만 남아 마을에 생명감을 준다(원경 능선 운해는
  //   src/village 의 운해 링이 담당 → 무드 보존). 시간대·날씨 게이트(#68) 불침해.
  // 마을(부감) 인스턴스 판별: 어댑터는 mistBillboards=false 로 호출하고(능선 물안개는 populate 운해 링이
  //   대신) env 단일건물은 기본 true. 따라서 !mistBillboards = 마을 부감 인스턴스 → env 는 절대 미접촉.
  const overheadFade = !mistBillboards;
  // OF_DEPTH: 부감(구름을 내려다봄)에서 빌보드 최대 감쇠율. #108 에서 마을 블롭이 프레임 중앙을
  //   가로지르게 되며(그림자 커버리지) 잔여 빌보드가 프레임 중앙에 어른거릴 수 있어 0.85→0.92 로
  //   높여 부감 프레임을 더 비운다(#81 의도 강화). overheadFade(=마을) 게이트 안이라 env 무영향.
  const OF_LO = -30, OF_HI = 6, OF_DEPTH = 0.92;   // dyEye(=카메라y−구름y) 밴드 & 최대 감쇠율
  // Preserve the old 18°/16:9 fade endpoints in screen terms: at 4.6 plane
  // widths the billboard occupied ~38% of the frame, and at 2.8 widths ~64%.
  // Expressing that authored limit as coverage keeps 7°/10° telephoto views
  // from restoring the shadow-source plane while it still fills the screen.
  const CLOUD_FRAME_FULL = 0.38, CLOUD_FRAME_HIDDEN = 0.64;
  // Those endpoints were authored for cameras level with the cloud body, where the
  // billboard still shows its lobed silhouette. A cinematic drone leg instead flies
  // *under* the quad (hanyang τ≈0.544: camera y≈20, cloud y=82, so the camera sits
  // below the plane's own lower edge). From there the only thing left on screen is
  // the flattened cloud base — a smooth low-contrast gradient with no lobes at all —
  // and patchCloudRim traces its magnified alpha contour as a hard bright edge, so the
  // billboard reads as a flat grey-lavender disc rather than a cloud. Measured at that
  // frame: covered-area stdev L = 6.6 and interior |grad| = 0.55, against 24.8 / 1.08
  // for the vision-approved warm cloud at τ≈0.7025 — which is *angularly larger*
  // (frameFraction 0.503 vs 0.479), so screen coverage alone cannot separate them.
  // Hence the limits tighten only as the camera sinks below the lower edge; a camera
  // level with or above it keeps the authored endpoints exactly, which is why the
  // τ≈0.7025 cloud and every aerial (camera-above) frame are untouched.
  const CLOUD_UNDERSIDE_SPAN = 0.35;   // depth below the lower edge, in half-heights, for full effect
  const CLOUD_UNDERSIDE_TIGHTEN = 0.55; // fraction the coverage limits shrink by when fully underneath
  // 이 프레임의 **저작** 림 세기·역광 투과 게인(부감 페이드를 걸기 전 값). update() 가 매 프레임
  //   쓰고, 상공 빌보드의 onBeforeRender 가 fade 를 곱해 uniform 에 대입한다. 곱이 아니라 대입이라야
  //   한 프레임에 렌더가 두 번 일어나도 계수가 누적되지 않는다(#53 핫픽스 주석 참조).
  let cloudRimStrengthNow = 0;
  let cloudGlowGainNow = 0;

  // ── 마을 부감 커버리지(#108) ─────────────────────────────────────────────────
  // 진단(tools/verify-cloudshadow.mjs): env 식 배치(rad = terrainMax·r + 40 + 표류 ±120)에선 블롭이
  //   원점 기준 반경 233~331 까지 표류하는데 부감 프레임(마을 외곽 원)은 반경 83~223 뿐 — 블롭이 표류
  //   주기의 대부분을 "프레임 밖"에서 보내 그림자가 좀처럼 화면에 안 들어왔다(사용자: "한 번도 못 봤다").
  // 마을(overheadFade) 인스턴스는 블롭을 프레임 중앙(원점 근처) 디스크에 가둬 배치하고, 표류를 그 디스크
  //   폭을 "가로지르는" 유한 왕복으로 바꾼다 → 블롭 몇 개가 유유히 프레임을 통과한다. env 단일건물은
  //   기존 배치·표류 그대로(무회귀). coverR 은 어댑터가 실제 프레임 반경(villageOuterR)을 주면 그 값,
  //   없으면 terrainMax 파생(마을 규모의 프레임 반경 ≈ 0.42·terrainMax — 프레임 밖으로 나가느니 안쪽).
  const village = overheadFade;
  const cCx = siteCenter ? siteCenter.x : 0;
  const cCz = siteCenter ? siteCenter.z : 0;
  const COVER = village ? (coverR || terrainMax * 0.42) : 0;
  const nHigh = Math.max(0, Math.min(MAX_CLOUD_BLOBS, highCloudCount));

  // 뷰공간 태양 방향(빌보드 접평면 기준) — 볕면/그늘면·역광 게이트의 유일한 입력. matrixWorld 의
  //   열 0/1/2 가 카메라 X/Y/Z 축이므로 세 dot 이 곧 뷰공간 성분이다. 카메라 Z 축은 **뒤쪽**을
  //   향하므로 z<0 = 태양이 카메라 앞 = 피사체 역광. 여기서 z 를 빠뜨렸던 것이 "정오에도 림이
  //   서던" 원인이다(예전 코드는 xy 만 썼다). Vector3.copy(Color)=NaN 함정과 무관한 순수 기하.
  function writeCloudSunView(rim, cam) {
    if (!rim) return;
    const me = cam.matrixWorld.elements;
    rim.direction.set(
      _sunDir.x * me[0] + _sunDir.y * me[1] + _sunDir.z * me[2],
      _sunDir.x * me[4] + _sunDir.y * me[5] + _sunDir.z * me[6],
      _sunDir.x * me[8] + _sunDir.y * me[9] + _sunDir.z * me[10],
    );
    if (rim.direction.lengthSq() < 1e-5) rim.direction.set(0, 1, -1).normalize();
    else rim.direction.normalize();
  }

  // ── 상공 뭉게구름 빌보드 (카메라 보는 적운, 최대 5장) ──
  // 반경을 마을·씬 중앙 위(r 0.14~0.55)로 낮춰 지면 투영 그림자가 마을 안·언저리에 떨어지게 한다
  //   (이전 r 0.62~0.86 은 그림자가 외곽 숲 링에 떨어져 "마을에 드리우는" 인상이 없었다). 크기·높이는
  //   부감·아이레벨 양쪽에서 덩어리로 읽히게 큼직하게.
  const highClouds = [];
  const highSpecs = HIGH_CLOUD_SPECS.slice(0, nHigh);
  // 네 패밀리를 담은 아틀라스 한 장을 상공 빌보드와 원경 뱅크가 공유한다(A3 는 층마다 텍스처를
  //   따로 구워 6 장이었다). 슬롯은 타일 사각형만 다르게 받으므로 재질·드로우콜은 그대로다.
  const cloudAtlas = makeCloudAtlasTexture();
  highSpecs.forEach((s, i) => {
    const mat = new THREE.MeshBasicMaterial({
      map: cloudAtlas, transparent: true, opacity: s.op, depthWrite: false,
      fog: true, blending: THREE.NormalBlending, side: THREE.DoubleSide,
    });
    patchCloudRim(mat, { width: s.w, height: s.h, tile: s.tile, mirror: s.mir });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    mesh.name = `high-cloud-${i}`;
    mesh.renderOrder = 3;
    if (village) {
      // 프레임 중앙 디스크 배치: 각 블롭을 표류 수직(perp)의 서로 다른 레인에 놓고, 표류(drift) 축으로
      //   디스크 폭(span)을 사인 왕복하며 가로지른다(place 가 매 프레임 계산). 레인·위상을 분산해
      //   한 번에 1~2 개만 프레임 중앙을 지나가게 한다(마을 전체가 어두워지는 명멸 금지).
      const laneT = nHigh > 1 ? (i / (nHigh - 1) - 0.5) : 0;   // -0.5..0.5
      const lane = laneT * 2 * COVER * 0.55;                   // perp 레인 오프셋(프레임 폭 내)
      mesh.userData = {
        laneX: cCx + perp.x * lane, laneZ: cCz + perp.y * lane, y: s.y,
        span: COVER * 0.85,                                    // 가로지름 진폭(프레임 안팎을 유유히 오감)
        w: s.w, h: s.h, op: s.op, sp: s.sp, phase: i * (6.2832 / nHigh), blob: i,
      };
    } else {
      const rad = R * s.r + 40;
      mesh.userData = {
        baseX: Math.cos(s.ang) * rad, z: Math.sin(s.ang) * rad, y: s.y,
        w: s.w, h: s.h, op: s.op, sp: s.sp, phase: i * 2.1, blob: i,   // blob: 대응 그림자 uniform 슬롯
      };
    }
    // 카메라를 향해 빌보드 — 렌더 직전 실제 카메라를 받아 재조준(update 에 카메라 불필요).
    const _up = new THREE.Vector3(0, 1, 0);
    mesh.onBeforeRender = (r, sc, cam) => {
      mesh.lookAt(cam.position.x, mesh.position.y + (cam.position.y - mesh.position.y) * 0.35, cam.position.z);
      mesh.up.copy(_up);
      writeCloudSunView(mesh.material.userData.cloudRim, cam);
      if (overheadFade) {
        // 시선각 감쇠: dyEye>0 = 구름이 카메라 눈높이 아래(지형에 겹쳐 시선 가림) → 페이드,
        //   dyEye<0 = 구름이 하늘에 뜸 → 유지. opNow(=update 가 매 프레임 계산한 시간대 불투명도)에
        //   곱해 누적 없이(매 프레임 opNow 재설정) 적용. 부감 정지·자동회전 중엔 camera.y 불변 → 안정.
        const g = smoothstep(OF_LO, OF_HI, cam.position.y - mesh.position.y);
        const base = mesh.userData.opNow != null ? mesh.userData.opNow : mesh.material.opacity;
        // A focus camera may stand directly under a 150 m shadow blob. Rendering that
        // finite billboard from only a few dozen metres away turns it into a featureless
        // ceiling when the user rotates toward the sky. Keep the physical shadow source,
        // but hand visible close-up sky detail to the camera-relative horizon bank.
        const frameFraction = cloudFrameFraction(mesh, cam);
        // Below the quad's own lower edge only the featureless baked underside is left,
        // so the coverage limits tighten there. Level or above keeps them unchanged.
        const halfH = (mesh.userData.h || mesh.userData.w) * 0.5;
        const underside = smoothstep(0, CLOUD_UNDERSIDE_SPAN,
          (mesh.position.y - halfH - cam.position.y) / Math.max(1e-6, halfH));
        const tighten = 1 - underside * CLOUD_UNDERSIDE_TIGHTEN;
        // The local plane remains the physical ground-shadow source even while
        // hidden. The camera-relative horizon bank supplies close sky silhouettes.
        const proximity = 1 - smoothstep(
          CLOUD_FRAME_FULL * tighten, CLOUD_FRAME_HIDDEN * tighten, frameFraction);
        const fade = (1 - g * OF_DEPTH) * proximity;
        mesh.userData.cloudFade = fade;      // 검증이 읽는다(게이트: 림·투과광이 이 계수를 탄다)
        mesh.material.opacity = base * fade;
        // ── 페이드는 알파만이 아니라 HDR 외곽 항에도 걸린다 (#53 핫픽스) ──────────
        // 알파만 낮추면 이 빌보드는 **균일하게** 사라지지 않는다. 바디는 그늘색이 haze 를 따라가
        //   하늘과 거의 같은 복사도인데, 림(uCloudRimColor·1.28)과 역광 투과(uCloudGain.z)는
        //   하늘의 여러 배인 HDR 항이고 둘 다 실루엣 경계에 몰려 있다. 그래서 fade 를 내리면
        //   바디가 먼저 지각 문턱 아래로 사라지고 경계 항만 살아남아 "하늘에 매직펜으로 그린
        //   윤곽선 낙서"가 된다 — 최종 클립 부감 6컷의 실패 모드이고, 같은 부팅 절제 실측
        //   (2026-08-04, village 부감 sunset, fade 0.018~0.080)에서 바디 ΔL 2~6 vs 림 스트로크
        //   ΔL 20~50(비 8~10 배)로 확인됐다. 림을 0 으로 두면 그 크리스프 스트로크가 사라진다.
        // 같은 계수를 두 항에 걸면 페이드가 지각적으로도 균일해진다(경계/바디 비 = 1 + fade·비).
        //   fade=1 이면 항등식이므로 S6 실루엣·역광 룩(비전 SHIP)은 불변이고, 이 블록은
        //   overheadFade(=마을) 안이라 env 단일건물 경로·원경 뱅크는 접촉하지 않는다.
        // 매 프레임 update() 가 저작값을 다시 쓰므로 여기서는 **곱이 아니라 대입**이다 — 한 프레임에
        //   onBeforeRender 가 두 번 돌아도 fade² 로 누적되지 않는다.
        const rim = mesh.material.userData.cloudRim;
        if (rim) {
          rim.strength.value = cloudRimStrengthNow * fade;
          rim.gain.z = cloudGlowGainNow * fade;
        }
      }
    };
    root.add(mesh);
    highClouds.push(mesh);
  });
  // 남는 블롭 슬롯은 비활성(반경 0)으로 초기화 — 셰이더가 건너뜀.
  for (let i = highClouds.length; i < MAX_CLOUD_BLOBS; i++) u.uCloudBlobs.value[i].set(0, 0, 0, 0);

  // The local layer above is the exact ground-shadow source. A telephoto house view looks
  // underneath it, so visible sky detail lives in a separate angular ring: sixteen cloud
  // instances cover 360° with a small overlap, yet remain one draw call. Their azimuths are
  // fixed to the world (camera rotation still reveals different clouds); only translation
  // follows the camera, like a sky dome, so travel never reaches or overtakes the bank.
  // The bank is inside the sun/moon sprites and can therefore create real alpha occlusion.
  const HORIZON_CLOUD_COUNT = 16;
  // At the low-cloud distance this subtends roughly 12–18° after deterministic scale
  // variation: one or two silhouettes at the edge of a telephoto frame, never a white ceiling.
  // #50 A3: 18×10 → 16×11. A camera-facing quad projects with one uniform world-to-pixel
  //   scale, so the on-screen silhouette aspect is exactly quadAspect × bakedSilhouetteAspect.
  //   The old pair multiplied 1.80 by seed 97's 1.84 and produced 3.31 — measured 3.16 in the
  //   product frame (probe-cloud-layers.mjs, sunset-cloudnear, largest component 234×74), the
  //   "horizontal sausage" the vision round rejected. Both factors are now inside the band:
  //   1.4545 × 1.05 ≈ 1.53. World area 176 vs 180 and baked fill 20.2% vs 20.6% keep the
  //   cloud's screen presence within 4% of the reviewed A2 build — this is a reshape, not a
  //   shrink (A2 FIX⑥ explicitly restored cloud presence and must not be undone here).
  const HORIZON_CLOUD_W = 16;
  const HORIZON_CLOUD_H = 11;
  // Crepuscular shaft width is derived from the anchor cloud's width, which is a separate
  // authored quantity from the cloud silhouette's aspect. Pinning it to the pre-A3 value
  // keeps the three shafts exactly as reviewed while the quad reshapes.
  const HORIZON_RAY_ANCHOR_W = 18;
  const HORIZON_CLOUD_OPACITY = 0.72;
  const horizonMaterial = new THREE.MeshBasicMaterial({
    map: cloudAtlas, transparent: true, opacity: HORIZON_CLOUD_OPACITY,
    // #31-3: fog:false → true. 이 파일의 다른 구름 재질 넷(산허리 뱅크·능선 물안개·뭉게구름·
    //   상공 층)은 모두 fog:true 이고 이 수평 구름대만 빠져 있었다 — 예외 근거가 주석에도 없다.
    //   결과: 카메라 84m 앞 고도 9~12°에 뜬 창백한 **비조명(MeshBasic) + 대기 미참여** 쿼드 16장이
    //   fog·조명에 물든 능선 위에서 종이 컷아웃으로 읽혔다(비전 3라운드 "능선 위 공중의 창백한
    //   수직 슬랩", orbit-village-t020). patchCloudRim 은 <common>·<map_fragment> 에 주입되므로
    //   전부 <fog_fragment> 앞이고, fog 는 그 뒤에 정상 합성된다. 재질 1개라 프로그램 수 불변.
    depthWrite: false, depthTest: true, fog: true, blending: THREE.NormalBlending,
    // Every instance turns its +Z plane normal toward the camera in placeHorizonBank;
    // DoubleSide would submit transparent backfaces as a redundant second draw.
    side: THREE.FrontSide,
  });
  patchCloudRim(horizonMaterial, { width: HORIZON_CLOUD_W, height: HORIZON_CLOUD_H });
  const horizonBank = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(HORIZON_CLOUD_W, HORIZON_CLOUD_H),
    horizonMaterial,
    HORIZON_CLOUD_COUNT,
  );
  horizonBank.name = 'horizon-cloud-bank';
  horizonBank.renderOrder = 1;
  // The instances form a camera-relative ring, so one aggregate bounding sphere always
  // surrounds the camera and Three cannot cull the bank as a whole. updateView performs
  // conservative per-instance sphere tests and sleeps this one draw plus its three rays
  // before render when the authored view never reaches the cloud band.
  horizonBank.frustumCulled = false;
  horizonBank.userData = {
    op: HORIZON_CLOUD_OPACITY, opNow: HORIZON_CLOUD_OPACITY, viewActive: true,
  };
  const horizonSpecs = horizonBankSpecs(HORIZON_CLOUD_COUNT);
  // 타일·미러는 인스턴스 속성으로 내린다(uniform 은 인스턴스별로 다를 수 없다). 정적 값이라 한 번만
  //   채우고 다시 쓰지 않는다 — placeHorizonBank 가 매 프레임 쓰는 것은 instanceMatrix 뿐이다.
  const horizonTileAttr = new THREE.InstancedBufferAttribute(
    new Float32Array(HORIZON_CLOUD_COUNT * 4), 4);
  horizonSpecs.forEach((spec, i) => {
    const rect = cloudAtlasRect(spec.tile);
    horizonTileAttr.setXYZW(i, rect.x, rect.y, rect.scale, spec.mirror);
  });
  horizonBank.geometry.setAttribute('aCloudTile', horizonTileAttr);
  const horizonDummy = new THREE.Object3D();
  const horizonForward = new THREE.Vector3();
  const horizonAnchor = new THREE.Object3D();
  horizonAnchor.userData.w = HORIZON_RAY_ANCHOR_W;
  const horizonViewProjection = new THREE.Matrix4();
  const horizonFrustum = new THREE.Frustum();
  const horizonSphere = new THREE.Sphere();
  let horizonViewManaged = false;

  function placeHorizonBank(cam) {
    // Stay inside the procedural world edge. A bank behind that opaque ridge can be
    // perfectly valid in projection yet contribute zero pixels. This camera-centred
    // low-cloud layer sits beyond buildings but before the enclosing mountains.
    const distance = Math.max(84, Math.min(150, R * 0.56, cam.far * 0.34));
    horizonBank.userData.distance = distance;
    cam.updateMatrixWorld();
    horizonBank.updateWorldMatrix(true, false);
    horizonViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    horizonFrustum.setFromProjectionMatrix(horizonViewProjection);
    cam.getWorldDirection(horizonForward);
    const viewAz = Math.atan2(horizonForward.x, horizonForward.z);
    let nearest = horizonSpecs[0];
    let nearestDistance = Infinity;
    let inView = false;
    const bankWorldScale = horizonBank.matrixWorld.getMaxScaleOnAxis();

    horizonSpecs.forEach((spec, i) => {
      horizonDummy.position.set(
        cam.position.x + Math.sin(spec.az) * distance,
        cam.position.y + spec.elev * distance,
        cam.position.z + Math.cos(spec.az) * distance,
      );
      horizonDummy.lookAt(cam.position);
      // 롤은 lookAt **뒤**에 시선축(local z)으로 걸어야 화면 안 회전이 된다. 스케일은 그 다음이라
      //   미러를 음의 스케일로 넣을 수 없다(와인딩 반전 → FrontSide 컬링) — 미러는 셰이더 몫이다.
      horizonDummy.rotateZ(spec.roll);
      horizonDummy.scale.set(spec.sx, spec.sy, 1);
      horizonDummy.updateMatrix();
      horizonBank.setMatrixAt(i, horizonDummy.matrix);

      horizonSphere.center.copy(horizonDummy.position).applyMatrix4(horizonBank.matrixWorld);
      horizonSphere.radius = 0.5 * Math.hypot(
        HORIZON_CLOUD_W * spec.sx,
        HORIZON_CLOUD_H * spec.sy,
      ) * bankWorldScale;
      inView ||= horizonFrustum.intersectsSphere(horizonSphere);

      const delta = Math.abs(Math.atan2(Math.sin(spec.az - viewAz), Math.cos(spec.az - viewAz)));
      if (delta < nearestDistance) { nearestDistance = delta; nearest = spec; }
    });
    horizonBank.instanceMatrix.needsUpdate = true;

    // Three narrow shafts escape from different gaps of the nearest visible cloud. The
    // anchor is data only, not another renderable cloud or draw call.
    horizonAnchor.position.set(
      cam.position.x + Math.sin(nearest.az) * distance,
      cam.position.y + nearest.elev * distance,
      cam.position.z + Math.cos(nearest.az) * distance,
    );
    horizonAnchor.userData.w = HORIZON_RAY_ANCHOR_W * nearest.sx;

    writeCloudSunView(horizonMaterial.userData.cloudRim, cam);
    return inView;
  }
  function updateView(cam) {
    if (disposed || !cam) return false;
    horizonViewManaged = true;
    const active = placeHorizonBank(cam);
    horizonBank.userData.viewActive = active;
    horizonBank.visible = active;
    for (const ray of lightRays) ray.visible = active && rayStrength > 0.001;
    return active;
  }
  root.userData.updateView = updateView;
  horizonBank.onBeforeRender = (rend, sc, cam) => {
    if (!horizonViewManaged) placeHorizonBank(cam);
  };
  root.add(horizonBank);

  // Crepuscular shafts share the same cloud anchors and sun direction as the shadow
  // blobs. Three tapered quads are enough to read as light breaking around cloud gaps;
  // aerial cameras suppress them in onBeforeRender to avoid laying translucent curtains
  // over a whole settlement.
  const lightRays = [];
  for (let i = 0; i < 3; i++) {
    const ray = new THREE.Mesh(makeLightRayGeometry(), makeLightRayMaterial());
    ray.name = `cloud-light-ray-${i}`;
    ray.renderOrder = 0;
    ray.frustumCulled = false;
    ray.userData.cloud = horizonAnchor;
    ray.userData.lane = (i - 1) * 0.18;
    ray.userData.opacityScale = [1.0, 0.58, 0.34][i];
    root.add(ray);
    lightRays.push(ray);
  }

  // ── 산허리 물안개 2장 (능선을 감는 넓고 낮은 수평 소프트 플레인) ──
  //   물안개는 방향성 없는 소프트 덩어리라야 사면에 자연스럽게 눕는다 → 뭉게구름(cumulus)이 아닌
  //   기존 소프트 텍스처를 쓴다.
  const mistTex = mistBillboards ? [makeCloudTexture(11), makeCloudTexture(29)] : [];
  const mistClouds = [];
  const mistSpecs = mistBillboards ? [
    { ang: 3.5, y: 12, w: 230, h: 120, op: 0.30, sp: 0.5 },
    { ang: 1.2, y: 16, w: 200, h: 110, op: 0.24, sp: 0.34 },
  ] : [];
  mistSpecs.forEach((s, i) => {
    const mat = new THREE.MeshBasicMaterial({
      map: mistTex[i % mistTex.length], transparent: true, opacity: s.op, depthWrite: false,
      fog: true, blending: THREE.NormalBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    mesh.rotation.x = -Math.PI / 2 + 0.12;   // 거의 수평(능선 사면에 눕힘)
    mesh.renderOrder = 2;
    const rad = R * 0.82;
    mesh.userData = {
      baseX: Math.cos(s.ang) * rad, z: Math.sin(s.ang) * rad, y: s.y,
      w: s.w, op: s.op, sp: s.sp, phase: i * 3.7,
    };
    root.add(mesh);
    mistClouds.push(mesh);
  });

  const _sunDir = new THREE.Vector3();
  const _base = new THREE.Color(0xffffff);
  const _warm = new THREE.Color();
  const _haze = new THREE.Color();
  const _rimColor = new THREE.Color(0xffc68c);
  const _rayColor = new THREE.Color(0xffdfbd);
  // 볕면·그늘면 팔레트(#50). 상수는 세 개뿐이고 나머지는 태양색·haze 에서 파생된다.
  //   APRICOT: 석양 직사광이 대기를 길게 통과한 살구·주황. 태양색이 이미 웜이지만 구름 볕면은
  //     한 걸음 더 깊어야 "흰 구름에 노란 조명"이 아니라 "물든 구름"으로 읽힌다.
  //   SHADE_DAY: 낮 그늘면 = 창백한 중성 청회(채도 낮음 — 낮 구름은 흰 덩어리라야 한다).
  //   SHADE_DUSK: 저고도 그늘면 = 태양 반대쪽 하늘의 모브·청회. 석양 구름의 그늘이 오렌지로
  //     물들면 전체가 한 덩어리 주황 워시가 된다(레포 확정: 온기는 하이라이트·림에만).
  const _cloudSun = new THREE.Color();
  const _cloudShade = new THREE.Color();
  const APRICOT = new THREE.Color(0xffab68);
  const SHADE_DAY = new THREE.Color(0xc8ced8);
  const SHADE_DUSK = new THREE.Color(0x7a83a6);
  const _rayDirection = new THREE.Vector3();
  const _rayView = new THREE.Vector3();
  const _rayWidth = new THREE.Vector3();
  const _rayStart = new THREE.Vector3();
  const _rayEnd = new THREE.Vector3();
  let rayStrength = 0;
  let t = 0;
  let disposed = false;

  for (const ray of lightRays) {
    ray.onBeforeRender = (rend, sc, cam) => {
      const cloud = ray.userData.cloud;
      if (!horizonViewManaged) placeHorizonBank(cam);
      _rayDirection.copy(_sunDir).multiplyScalar(-1).normalize();
      _rayView.subVectors(cam.position, cloud.position).normalize();
      _rayWidth.crossVectors(_rayDirection, _rayView);
      if (_rayWidth.lengthSq() < 1e-5) _rayWidth.set(1, 0, 0);
      else _rayWidth.normalize();

      const cloudW = cloud.userData.w || 150;
      _rayStart.copy(cloud.position)
        .addScaledVector(_rayWidth, cloudW * ray.userData.lane)
        .addScaledVector(_rayDirection, 7);
      const length = Math.max(105, Math.min(250, R * (village ? 0.72 : 1.0)));
      _rayEnd.copy(_rayStart).addScaledVector(_rayDirection, length);
      const w0 = cloudW * 0.035;
      const w1 = cloudW * 0.16;
      const positions = ray.geometry.attributes.position;
      positions.setXYZ(0, _rayStart.x - _rayWidth.x * w0, _rayStart.y - _rayWidth.y * w0, _rayStart.z - _rayWidth.z * w0);
      positions.setXYZ(1, _rayStart.x + _rayWidth.x * w0, _rayStart.y + _rayWidth.y * w0, _rayStart.z + _rayWidth.z * w0);
      positions.setXYZ(2, _rayEnd.x - _rayWidth.x * w1, _rayEnd.y - _rayWidth.y * w1, _rayEnd.z - _rayWidth.z * w1);
      positions.setXYZ(3, _rayEnd.x + _rayWidth.x * w1, _rayEnd.y + _rayWidth.y * w1, _rayEnd.z + _rayWidth.z * w1);
      positions.needsUpdate = true;

      // Suppress shafts as the camera pitches into a settlement-wide aerial view. The
      // distant bank remains visible, but translucent quads must not veil the whole town.
      cam.getWorldDirection(horizonForward);
      const aerial = smoothstep(0.22, 0.48, Math.max(0, -horizonForward.y));
      ray.material.uniforms.uRayOpacity.value = rayStrength * ray.userData.opacityScale * (1 - aerial * 0.96);
    };
  }

  // 표류: drift 방향으로 눈에 띄게 미끄러지고 perp 로 왕복한다. 경계 밖으로 벗어나지 않게 사인
  //   왕복만 쓴다(순 이동 누적 없음) → 오래 켜둬도 안정. #68 에서 진폭·주기를 키워 "지나간다"는
  //   인상을 준다(주기 ~90s, 진폭 ±120). SHOT 은 t=0 고정(결정론).
  function place(mesh) {
    const d = mesh.userData;
    if (village && d.span != null) {
      // 마을: 레인(perp) 시작점 + 표류(drift) 축 가로지름(sweep) + perp 축 느린 흔들림(wob)의 2D
      //   유한 왕복. 위상 분산이라 한 번에 1~2 개만 프레임을 통과(유유히). wob 는 sweep 과 다른 주기라
      //   블롭이 사분면을 두루 훑어 석양 레이킹(+z 편향)에도 프레임 한쪽이 굶지 않는다. SHOT=t0 결정론.
      const sweep = Math.sin(t * 0.085 * d.sp + d.phase) * d.span;
      const wob = Math.cos(t * 0.055 * d.sp + d.phase * 1.3) * d.span * 0.30;
      mesh.position.set(
        d.laneX + drift.x * sweep + perp.x * wob, d.y,
        d.laneZ + drift.y * sweep + perp.y * wob);
      return;
    }
    if (SHOT) { mesh.position.set(d.baseX, d.y, d.z); return; }
    const sway = Math.sin(t * 0.06 * d.sp + d.phase) * 32;
    const dx = drift.x * Math.sin(t * 0.07 * d.sp + d.phase) * 120;
    const dz = drift.y * Math.sin(t * 0.07 * d.sp + d.phase) * 120;
    mesh.position.set(d.baseX + perp.x * sway + dx, d.y, d.z + perp.y * sway + dz);
  }

  // 빌보드 위치를 태양 방향으로 지면(y≈0)에 투영한 XZ → 대응 그림자 블롭 중심. 고도가 높으면 구름
  //   바로 아래, 저고도(석양)면 태양 반대쪽으로 레이킹(장그림자). k 는 상한을 둬 그림자가 지형 밖으로
  //   날아가지 않게 한다. 반경은 구름 폭에 비례(지면 발자국), 세기는 구름 불투명도에 비례.
  const SHADOW_R = 0.50, RAKE = 0.9, RAKE_MAX = 78;
  // 마을: 그림자 발자국을 프레임(COVER)에 비례시켜 몇 개가 유유히 지난다. #221 은 반경을
  //   약간 줄여(0.36→0.30) 레인 배치 블롭이 한 장의 평탄 암부 밴드로 붙는 일을 줄인다.
  //   레이킹(석양 장그림자)도 COVER 로 상한을 조여 그림자가 프레임 밖으로 날아가지 않게 한다.
  const villRadius = Math.max(20, COVER * 0.30);   // 이산 그늘(프레임에 2~3 개 — 상시 반그늘 방지)
  const villRakeMax = COVER * 0.28;   // 저고도 장그림자 상한(프레임 한쪽 굶주림 방지 — 진단 #108)
  function writeBlob(m) {
    const b = u.uCloudBlobs.value[m.userData.blob];
    if (!b) return;
    const p = m.position;
    const hy = Math.max(0.001, Math.hypot(_sunDir.x, _sunDir.z));
    const nx = _sunDir.x / hy, nz = _sunDir.z / hy;         // 태양 수평방향(정규화)
    const rakeMax = village ? villRakeMax : RAKE_MAX;
    const rake = Math.min(rakeMax, (1 - Math.min(1, _sunDir.y)) * p.y * RAKE);
    // Per-blob radius stagger breaks the four-lane "parallel stripe" reading under shot clocks.
    const blobI = m.userData.blob | 0;
    const radScale = village ? (0.78 + 0.14 * ((blobI * 2 + 1) % 5) / 4) : 1;
    const rad = village ? villRadius * radScale : m.userData.w * SHADOW_R;
    b.set(p.x - nx * rake, p.z - nz * rake, rad, Math.min(1, m.userData.op / 0.5));
  }

  function update(dt) {
    if (disposed) return;
    if (!SHOT) t += dt;
    u.uCloudTime.value = t;

    // ── 태양 상태 매 프레임 판독 → 구름 라이팅·그림자 세기 ──
    _sunDir.copy(sun.position).normalize();
    const alt = Math.max(0, _sunDir.y);               // 태양 고도(0..1)
    const inten = sun.intensity;                       // day2.6 sunset2.3 dawn1.7 night0.9
    // 그림자 전역 세기: 밝은 낮·석양에서 읽히되 마당을 반으로 짓누르지 않게(#221: 0.52→0.40).
    // env 단일건물 경로도 같은 곡선을 쓰므로 무회귀 기대치는 tools/verify-cloudshadow.mjs 가 갱신.
    const daylight = 0.40 * smoothstep(1.2, 2.45, inten);
    if (village) {
      // ── 달빛 구름 그림자(#108) ──────────────────────────────────────────────
      // 야간(night) 조명은 sky.js 에서 sun(방향광)이 달빛으로 전용된다: 저강도(inten≈0.9)·청색
      //   (sunColor 0x9fb4d9 → b>r). 낮/석양/새벽은 웜(r≥b). 그래서 sun.color 의 청색도로 "달밤"을
      //   판별한다(sky 상태 미접촉 — 색·강도만 판독, 크로스페이드#50 중 lerp 되어 팟 없이 발현/소멸).
      //   강도는 낮 대비 저감(#17 달빛 그림자와 정합) — 야간 dim 바닥과 균형(칠흑 금지: 1-0.20=0.80).
      const cool = smoothstep(0.0, 0.16, sun.color.b - sun.color.r);   // 청색도(달빛=1, 웜=0)
      const lowlit = 1 - smoothstep(1.15, 1.9, inten);                  // 저광량(야간=1, 낮=0)
      const moonUp = _sunDir.y > 0.02 ? 1 : 0;                          // 달 지평선 위
      const moonlight = 0.20 * cool * lowlit * moonUp;
      u.uCloudStr.value = Math.max(daylight, moonlight);
    } else {
      u.uCloudStr.value = daylight;                    // env 단일건물: 기존식 그대로(무회귀)
    }

    // 구름 색: 흰 바탕 → 태양색으로 살짝 물들이되 밑면은 따뜻하게(석양). 야간엔 어둡게.
    _warm.copy(sun.color);
    const warmMix = (1 - alt) * 0.55;                  // 저고도(석양·새벽)에 밑면 웜틴트 강
    const haze = getHaze?.();
    if (haze?.isColor) _haze.copy(haze);
    // #73 야간 무드: 밝기·불투명 바닥을 낮춰 야간(inten≈0.9) 뭉게구름을 "중간톤 회색 덩어리"에서
    //   "달빛 아래 은은한 청회 실루엣"으로 물린다. smoothstep 상단(day 2.6·sunset 2.3)은 계수가 ≈1
    //   이라 바닥만 낮추면 야간·(약하게)새벽만 어두워지고 day/sunset 룩은 사실상 불변.
    const dim = 0.3 + 0.7 * smoothstep(0.7, 2.6, inten);
    const lowSun = 1 - smoothstep(0.24, 0.52, alt);
    const brightSky = smoothstep(1.15, 2.15, inten);
    const rimStrength = lowSun * brightSky * 1.28;
    rayStrength = lowSun * brightSky * 0.038;
    _rimColor.copy(sun.color);
    if (haze?.isColor) _rimColor.lerp(_haze, 0.14);

    // ── 볕면·그늘면 두 색(#50) ────────────────────────────────────────────────
    // 볕면: 직사광색을 저고도에서 살구로 한 걸음 더. 웜 이동을 brightSky 로 게이트하는 이유는
    //   야간에는 sun 이 달빛(청색)이라 lowSun=1 이어도 살구로 끌면 안 되기 때문이다.
    // 그늘면: 중성 청회에서 출발해 haze(해소된 대기 프로파일)에 조금만 참여시키고, 저고도에서
    //   모브·청회로 민다. haze 참여를 0.14 로 묶는 것이 "석양 전체 주황 워시" 방지선이다.
    _cloudSun.copy(sun.color).lerp(APRICOT, 0.42 * lowSun * brightSky);
    _cloudShade.copy(SHADE_DAY);
    if (haze?.isColor) _cloudShade.lerp(_haze, 0.14);
    _cloudShade.lerp(SHADE_DUSK, 0.62 * lowSun);
    // 역광 투과 게인. 저고도에서 크게 올리는 근거는 광학이다 — 전방산란된 태양광은 하늘 산란광의
    //   여러 배라서 역광 구름의 태양 쪽 어깨는 하늘보다 밝다(그래서 사진에서 종종 날아간다).
    //   순수 노드 스윕(scratch bake-preview, sunset 역광 cumulus-11, ACES 1.05 통과 후 sRGB):
    //     게인 0.94 → 볕면 R−B −15.3 / 그늘 −34.9  (볕면이 냉색 — 석양 구름이 아니다)
    //     게인 1.90 → −0.6 / −28.3,  2.40 → +5.3 / −25.2,  3.00 → +11.3 / −21.7
    //   즉 "볕면 웜 · 그늘면 냉"이 동시에 성립하는 하한이 ≈2.4 이고, 그 위는 볕면만 더 따뜻해진다.
    // #50 A2 재핀: FIX④ 로 투과광 코어 바닥이 0.14→0.38 올라가 같은 게인이 바디를 몇 배 밝힌다.
    //   같은 스윕을 새 셰이딩·새 베이크로 다시 돌린 값(cumulus-11, 볕면 R−B / 그늘면 R−B):
    //     0.94 → +5.7 / −21.8,  1.30 → +13.9 / −16.6,  1.52 → +18.0 / −13.7,
    //     1.70 → +20.8 / −11.5,  2.40 → +29.1 / −3.7
    //   즉 하한(볕면 웜)이 0.94 아래로 내려오고 상한(그늘면 R ≤ B+10)은 ≈2.2 다. 1.52 를 채택한
    //   근거는 밴드 중앙이라는 것 — 아래로 가면 볕면 웜이 얕아지고, 위로 가면 그늘면 냉색이 사라진다.
    const glowGain = 0.30 + 1.22 * lowSun * brightSky;
    // 낮 구름 존재감(FIX⑥): 다중산란 바닥과 천공 게인을 밝은 낮에만 올린다. 석양·새벽은 lowSun=1
    //   이라 dayLift=0 → 1 차의 석양 수치(볕면 웜/그늘면 냉)가 그대로 보존된다.
    //   같은 스윕의 day 역광(cumulus-11 구름 평균 luma / 볕밴드−그늘밴드 luma 폭):
    //     0.34·1.00 → 221.4 / 4.9,  0.26·0.96 → 217.6 / 5.7,  0.20·0.92 → 214.1 / 6.4,
    //     0.14·0.88 → 209.9 / 7.3,  0.08·0.86 → 205.4 / 8.4      (1 차 = 190.6 / 10.0)
    //   밝히면 ACES 상단에서 압축돼 로브 분리가 줄어드는 상충이 있다. 0.14·0.88 은 1 차보다
    //   +19 luma 밝으면서 폭 7.3 을 남기는 중간값 — 하늘 대비는 회복하고 로브는 여전히 분리된다.
    const dayLift = brightSky * (1 - lowSun);
    const msFloor = 0.14 * dayLift;
    const ambGain = 0.82 + 0.06 * dayLift;
    // 저작값 게시 — 상공 빌보드의 부감 페이드가 이 둘에 같은 계수를 걸어 uniform 에 대입한다.
    cloudRimStrengthNow = rimStrength;
    cloudGlowGainNow = glowGain;

    highClouds.forEach((m) => {
      place(m);
      writeBlob(m);                                    // 빌보드 위치 → 대응 그림자 블롭 갱신
      // 재질 color 는 이제 **스칼라 캐리어**다(밝기·야간 dim 전용). 색상은 uniform 이 소유하므로
      //   여기에 웜 틴트를 곱하면 그늘면까지 물들어 그늘/볕 분화가 무너진다.
      m.material.color.copy(_base).multiplyScalar(dim);
      const rim = m.material.userData.cloudRim;
      if (rim) {
        rim.color.copy(_rimColor);
        rim.strength.value = rimStrength;
        rim.sun.copy(_cloudSun);
        rim.shade.copy(_cloudShade);
        rim.gain.set(1, ambGain, glowGain, msFloor);
        rim.time.value = t;              // v4 결 표류(SHOT 은 t=0 고정 → 결정론 유지)
      }
      // 야간엔 뭉게구름이 창불 야경을 방해하지 않게 물러난다(저광량 불투명도 바닥 ↓).
      const opNow = m.userData.op * (0.32 + 0.68 * smoothstep(0.8, 2.55, inten));
      m.userData.opNow = opNow;              // 부감 인스턴스는 onBeforeRender 가 시선각으로 추가 감쇠
      m.material.opacity = opNow;
    });
    // Keep the low-sun body below white so the gold/silver HDR edge has tonal room
    // to read as a lining instead of bleaching the whole cloud into one flat cutout.
    // Midday remains bright; night still follows the shared dim multiplier.
    const horizonLuminance = 0.72 + 0.22 * brightSky - 0.14 * lowSun;
    horizonMaterial.color.copy(_base).multiplyScalar(dim * horizonLuminance);
    const horizonRim = horizonMaterial.userData.cloudRim;
    if (horizonRim) {
      horizonRim.color.copy(_rimColor);
      horizonRim.strength.value = rimStrength * 1.08;
      horizonRim.sun.copy(_cloudSun);
      horizonRim.shade.copy(_cloudShade);
      horizonRim.gain.set(1, ambGain, glowGain, msFloor);
      horizonRim.time.value = t;
    }
    horizonBank.userData.opNow = horizonBank.userData.op * (0.28 + 0.72 * smoothstep(0.72, 2.5, inten));
    horizonMaterial.opacity = horizonBank.userData.opNow;
    for (const ray of lightRays) {
      ray.visible = horizonBank.userData.viewActive !== false && rayStrength > 0.001;
      _rayColor.copy(_rimColor).lerp(_base, 0.26);
      ray.material.uniforms.uRayColor.value.copy(_rayColor);
    }
    mistClouds.forEach((m) => {
      place(m);
      // 물안개는 하늘/대기색을 더 강하게 받는다(밑에서 올라온 습기)
      m.material.color.copy(_base).lerp(_warm, warmMix).multiplyScalar(dim * 0.96);
      m.material.opacity = m.userData.op * (0.42 + 0.58 * smoothstep(0.4, 2.6, inten));
    });
  }

  function setEnabled(v) { if (!disposed) root.visible = !!v; }

  // ── v4 마칭 제어(성능 프로파일 강등 + 검증 A/B) ──────────────────────────────
  // 모바일·저사양은 **스텝 수만 uniform 으로 내린다**(프로그램 분기 금지 → 프로그램 계열 델타 0).
  //   setCloudVolume({ steps: 8 }) 이 권고 강등, { strength: 0 } 은 v3 평면 셰이딩 대조군이다.
  // 이 경로는 재질·텍스처·지오메트리를 건드리지 않으므로 드로우콜도 불변이다.
  function cloudVolumeStates() {
    const states = highClouds.map((m) => m.material.userData.cloudRim);
    states.push(horizonMaterial.userData.cloudRim);
    return states.filter(Boolean);
  }
  function setCloudVolume(opts = {}) {
    const states = cloudVolumeStates();
    for (const s of states) {
      if (Number.isFinite(opts.strength)) s.march.x = Math.max(0, Math.min(1, opts.strength));
      if (Number.isFinite(opts.thickness)) s.march.y = Math.max(0, opts.thickness);
      if (Number.isFinite(opts.steps)) {
        s.march.z = Math.max(4, Math.min(CLOUD_MARCH_MAX_STEPS, Math.round(opts.steps)));
      }
      if (Number.isFinite(opts.optical)) s.march.w = Math.max(0.1, opts.optical);
      if (Number.isFinite(opts.amp)) s.detail.z = Math.max(0, Math.min(1, opts.amp));
      if (Number.isFinite(opts.alphaBlend)) s.detail.w = Math.max(0, Math.min(1, opts.alphaBlend));
      if (Number.isFinite(opts.lightK)) s.volume.z = Math.max(0, opts.lightK);
    }
    const first = states[0];
    return first ? {
      materials: states.length,
      strength: first.march.x, thickness: first.march.y,
      steps: first.march.z, optical: first.march.w,
      amp: first.detail.z, alphaBlend: first.detail.w, lightK: first.volume.z,
    } : { materials: 0 };
  }

  // 검증 전용 훅(window.__clouds). 같은 부팅·같은 프로그램 안에서 v3/v4 를 교체해야 A/B 가 통제된다
  //   (레포 규약: 페이지 간 픽셀 비교 금지). 제품 경로는 이 훅을 호출하지 않는다.
  let unregisterVolumeHook = null;
  if (typeof window !== 'undefined') {
    const registry = window.__clouds || (window.__clouds = {
      layers: [],
      defaults: { ...CLOUD_MARCH_DEFAULTS },
      maxSteps: CLOUD_MARCH_MAX_STEPS,
      setVolume(opts) { return this.layers.map((l) => l.setCloudVolume(opts)); },
    });
    // 타일 배정은 픽셀로 되짚기 어렵다(같은 아틀라스 안 사각형 차이라 색·밝기가 안 바뀐다).
    //   그래서 배선 자체를 검증이 읽을 수 있게 노출한다 — 인접 슬롯 동일 패밀리 금지·프레임 안
    //   중복 금지 같은 단언이 픽셀 추정이 아니라 실제 배정값을 보게 된다.
    const debugTiles = () => ({
      atlas: { size: CLOUD_TEX_SIZE * CLOUD_ATLAS_COLS, tiles: CLOUD_ATLAS_TILES.map((t) => t.family) },
      high: highSpecs.map((s, i) => ({
        slot: i, family: CLOUD_FAMILY_ORDER[s.tile], mirror: s.mir, w: s.w, h: s.h, y: s.y,
      })),
      bank: horizonSpecs.map((s, i) => ({
        instance: i, family: CLOUD_FAMILY_ORDER[s.tile], mirror: s.mirror,
        az: +s.az.toFixed(4), elev: s.elev, sx: s.sx, sy: s.sy, roll: s.roll,
      })),
    });
    const record = { setCloudVolume, root, debugTiles, get states() { return cloudVolumeStates(); } };
    registry.layers.push(record);
    unregisterVolumeHook = () => {
      const at = registry.layers.indexOf(record);
      if (at >= 0) registry.layers.splice(at, 1);
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (unregisterVolumeHook) { unregisterVolumeHook(); unregisterVolumeHook = null; }
    disposeObjectTree(root);
    root.clear();
  }

  return { group: root, uniforms: u, update, updateView, setEnabled, setCloudVolume, dispose };
}
