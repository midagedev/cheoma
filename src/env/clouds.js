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

// 상공 적운: 평평한 바닥 + **지배 로브 1 군**(기단 로브 반경의 1.8~2.2 배) + 그 위 2~3 단 적층.
//   좌표계는 y-up(0 = 텍스처 바닥).
// #50 A2 (비전 FIX① 2026-08-03): 1 차는 기단·기둥·크라운 로브 반경이 모두 0.060~0.154·S 로 한
//   옥타브 안에 몰려 있어, 빌보드가 가로로 1.39:1 늘어난 화면에서 "같은 반지름 로브가 늘어선
//   가로 소시지 띠"로 읽혔다. 봉우리 위계는 **반경비**로만 생긴다 — 층을 더 쌓거나 노이즈를
//   키우는 것으로 대체되지 않는다. 그래서 역할별로 반경대를 벌린다:
//     기단(plinth) 1.0  ·  이웃 어깨 1.2~1.5  ·  지배(dominant) 1.84~2.14  (기단 반경 기준)
//   기단은 개수 상한 4 에 세로로 눌러(sy≈1.7) 바닥선 슬래브 역할만 하고, 적층은 지배 반경에서
//   파생해 좁혀 올린다. 마지막에 실루엣을 텍스처에 맞춰 등방 스케일한다(빌보드 크기는 고정이므로
//   실루엣이 텍스처를 덜 채우면 그만큼 구름이 작게 보인다).
// 로브 간격은 전부 **반경에서 파생**한다: 임계 0.32 에서 두 로브는 간격 ≲1.55r 일 때만 이어지므로
//   그 문턱 안쪽(≤1.36r)으로만 놓는다. 문턱을 넘기면 공중에 뜬 동그라미가 생긴다.
function cumulusLobes(rnd, S) {
  const lobes = [];
  const baseY = S * 0.235;
  // ① 기단 열 — 작고 납작하게, 개수 상한 4.
  const rP = S * (0.086 + rnd() * 0.020);
  const nP = 3 + (rnd() < 0.45 ? 1 : 0);
  const gapP = rP * 1.14;
  const cx = S * 0.5;
  const skew = (rnd() - 0.5) * S * 0.075;            // 적층이 한쪽으로 기울어 바람결이 생긴다
  const px0 = cx - gapP * (nP - 1) * 0.5;
  const plinth = [];
  for (let i = 0; i < nP; i++) {
    const r = rP * (0.84 + rnd() * 0.30);
    const sy = 1.55 + rnd() * 0.30;
    const lobe = {
      x: px0 + gapP * i + (rnd() - 0.5) * rP * 0.14,
      y: baseY + (r / sy) * (0.82 + rnd() * 0.16),
      r, sy, w: 1.0,
    };
    plinth.push(lobe);
    lobes.push(lobe);
  }
  // ② 지배 로브 — 기단 반경의 1.84~2.14 배. 중심 열이 아닌 로브 위에 얹어 좌우 비대칭을 만든다
  //    (실측 적운은 한쪽 어깨만 솟는다). 아래쪽 절반은 바닥 평탄화가 잘라내므로 y 를 낮게 둔다.
  const domRatio = 1.84 + rnd() * 0.30;
  const rD = rP * domRatio;
  const ai = nP >= 4 ? (rnd() < 0.5 ? 1 : 2) : (rnd() < 0.5 ? 0 : 1);
  const ax = plinth[ai].x + (rnd() - 0.5) * rP * 0.30;
  const syD = 1.06 + rnd() * 0.12;
  const ryD = rD / syD;
  const dy0 = baseY + ryD * 0.74;
  lobes.push({ x: ax, y: dy0, r: rD, sy: syD, w: 1.0 });
  // 볼(cheek) 2 개 — 지배 로브 측면에 걸쳐 큰 원호를 깬다. 거리 0.72rD 에서 부모 필드가 0.74 라
  //   합집합이 확실히 이어지고, 실루엣만 양배추처럼 부푼다.
  const cheekSide = rnd() < 0.5 ? -1 : 1;
  for (let c = 0; c < 2; c++) {
    const ang = (0.74 + rnd() * 0.40) * (c === 0 ? cheekSide : -cheekSide);
    lobes.push({
      x: ax + Math.sin(ang) * rD * 0.72,
      y: dy0 + Math.cos(ang) * ryD * 0.46,
      r: rD * (0.40 + rnd() * 0.14), sy: 1.04 + rnd() * 0.10, w: 0.98,
    });
  }
  // ③ 적층 2~3 단 — 반경·간격 모두 rD 파생(0.52 → 0.35 → 0.25). 한 층에 로브 여러 개를 두되
  //    간격은 1.22r 로 묶어(문턱 안) 층이 하나의 덩어리로 이어지게 한다.
  const tiers = rnd() < 0.55 ? 3 : 2;
  let ty = dy0, tyR = ryD;
  for (let k = 0; k < tiers; k++) {
    const r = rD * [0.52, 0.35, 0.25][k] * (0.92 + rnd() * 0.18);
    const sy = 1.02 + rnd() * 0.10;
    const ry = r / sy;
    ty += (tyR + ry) * 0.60;
    tyR = ry;
    const count = k === 0 ? 2 : (k === 1 ? 2 : 1);
    const sep = r * 1.22;
    for (let j = 0; j < count; j++) {
      lobes.push({
        x: ax + skew * (k + 1) * 0.34 + (j - (count - 1) * 0.5) * sep + (rnd() - 0.5) * r * 0.22,
        y: ty + (rnd() - 0.5) * ry * 0.18,
        r, sy, w: 0.97 - 0.05 * k,
      });
    }
  }
  // ④ 이웃 어깨 1 개 — 지배 덩어리 반대쪽에 낮게(0.62~0.78 rD). 지배와 경쟁하지 않는 반경대라
  //    위계를 흐리지 않으면서 실루엣을 비대칭으로 벌린다.
  const si = ai <= 1 ? nP - 1 : 0;
  const rS = rD * (0.62 + rnd() * 0.16);
  const syS = 1.08 + rnd() * 0.12;
  const sy0 = baseY + (rS / syS) * 0.70;
  lobes.push({ x: plinth[si].x, y: sy0, r: rS, sy: syS, w: 1.0 });
  lobes.push({
    x: plinth[si].x + skew * 0.3, y: sy0 + (rS / syS) * 0.92,
    r: rS * 0.56, sy: 1.04, w: 0.95,
  });
  // ⑤ 실루엣을 텍스처에 맞춰 등방 스케일(바닥선 고정). 시드마다 총폭이 달라도 화면 점유가
  //    비슷해지고, 1 차에서 시드별로 13~24% 로 벌어졌던 커버리지가 좁혀진다.
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of lobes) {
    minX = Math.min(minX, L.x - L.r);
    maxX = Math.max(maxX, L.x + L.r);
    maxY = Math.max(maxY, L.y + L.r / (L.sy || 1));
  }
  const fit = Math.min(S * (0.90 + rnd() * 0.06) / (maxX - minX), S * 0.695 / (maxY - baseY));
  const mid = (minX + maxX) * 0.5;
  for (const L of lobes) {
    L.x = cx + (L.x - mid) * fit;
    L.y = baseY + (L.y - baseY) * fit;
    L.r *= fit;
  }
  // ⑥ 스캘럽: 기존 로브의 윗면에 걸치게 작은 봉우리를 얹는다. 무작위 좌표에 흩으면 떠 있는
  //    반점이 되고, 윗면에 걸치면 실루엣 윤곽만 크레늘레이션된다. 크기를 **부모 반경에서**
  //    파생하는 것이 1 차와 다른 점이다 — 절대 크기로 두면 커진 지배 로브 위에서 사라진다.
  const nScallop = 8 + Math.floor(rnd() * 5);
  const pool = lobes.slice();
  for (let i = 0; i < nScallop; i++) {
    let pick = pool[Math.floor(rnd() * pool.length)];
    const alt = pool[Math.floor(rnd() * pool.length)];
    if (alt.y > pick.y) pick = alt;                  // 두 번 뽑아 높은 쪽 — 상단 편향
    const ang = (rnd() - 0.5) * 1.9;                 // 상단 반구 위 방위
    lobes.push({
      x: pick.x + Math.sin(ang) * pick.r * 0.62,
      y: pick.y + Math.cos(ang) * (pick.r / (pick.sy || 1)) * 0.60,
      r: Math.min(S * 0.072, Math.max(S * 0.026, pick.r * (0.24 + rnd() * 0.14))),
      sy: 1.0, w: 0.76 + rnd() * 0.16,
    });
  }
  return {
    lobes, baseY, erosionCycles: 8, crinkleCycles: 21, wobble: 0.36,
    skyK: 2.6, threshold: 0.32, feather: 0.130,
    plinthR: rP * fit, domR: rD * fit, nPlinth: nP,
  };
}

// 원경 뱅크: 상공 빌보드와 같은 색 언어·같은 인코딩·같은 생성 규칙(반경대 위계 + rD 파생 적층).
// #50 A3 재작(2026-08-03). 구판은 4 열(8·7·5·3 로브)을 x 0.13~0.87 에 깔고 그 위에 폭 0.05S 짜리
//   3 단 미니 타워를 얹었다. 실측 결과 두 가지가 동시에 틀렸다:
//     ① 실루엣 종횡비 1.84 — 이 텍스처가 종횡비 1.8 인 뱅크 쿼드(HORIZON_CLOUD_W/H)에 매핑되므로
//        화면 합성 실루엣이 1.84 × 1.8 ≈ 3.3 이 된다. 제품 프레임 실측(probe-cloud-layers.mjs,
//        sunset-cloudnear) 최대 성분 234×74 = 3.16, 지분가중 2.51 — 비전이 "가로 소시지 띠"로
//        판정한 값이 정확히 이 곱이다. 텍스처 쪽 몫을 ≤1.3 으로 내리는 것이 이 함수의 책임이다.
//     ② 알파 밴드 안 내부 홀. bakeCloudData 의 홀 채움은 임계 TH 한 레벨에서만 판정하는데, 구판
//        씨드 97 은 alpha≈128 레벨에서는 좁은 틈으로 하늘과 이어져 있고 alpha≈77 레벨에서 그 틈이
//        닫히는 **거의 봉인된 주머니**를 만들었다(103~130px, 임계 26~102 전 구간 상존 — A2 게이트가
//        임계 128 단일 판정이라 0 으로 보고했다). 열 사이 간격을 반경에서 파생해 문턱 안쪽으로
//        묶으면 그런 주머니가 애초에 생기지 않는다.
//   비대칭 어깨(뱅크 캐릭터)는 유지한다 — 16 인스턴스가 같은 텍스처를 공유하므로 좌우 비대칭이
//   "같은 구름 열여섯 장"으로 읽히지 않게 하는 유일한 방어다. 다만 미니 타워(말뚝)가 아니라
//   기단 반경의 1.4 배짜리 **지배 어깨 덩어리 + rD 파생 적층**으로 솟는다(상공 적운과 같은 규칙).
function horizonLobes(rnd, S) {
  const lobes = [];
  const baseY = S * 0.29;
  const cx = S * 0.5;
  // ① 기단 열 — 4 개. 간격을 반경에서 파생(1.24r)해 임계 0.32 의 연결 문턱(≲1.55r) 안쪽에 묶는다.
  //    구판은 x 를 절대 좌표로 균등 분할해 반경과 무관했고, 그래서 열 사이에 주머니가 생겼다.
  const rP = S * (0.094 + rnd() * 0.014);
  const nP = 4;
  const gapP = rP * 1.24;
  const skew = (rnd() - 0.5) * S * 0.055;
  const px0 = cx - gapP * (nP - 1) * 0.5;
  const base = [];
  for (let i = 0; i < nP; i++) {
    const r = rP * (0.88 + rnd() * 0.24);
    const sy = 1.22 + rnd() * 0.16;                  // 뱅크 기단은 상공 적운보다 덜 눌린다
    const lobe = {
      x: px0 + gapP * i + (rnd() - 0.5) * rP * 0.12,
      y: baseY + (r / sy) * (0.84 + rnd() * 0.14),
      r, sy, w: 1.0,
    };
    base.push(lobe);
    lobes.push(lobe);
  }
  // ② 둘째 열 — 3 개, 기단 로브 사이 골 위에 얹혀 세로로 이어붙인다(간격 1.22r).
  const rB = rP * (0.80 + rnd() * 0.10);
  const gapB = rB * 1.22;
  const bx0 = cx + skew * 0.5 - gapB;
  const row2 = [];
  for (let i = 0; i < 3; i++) {
    const r = rB * (0.90 + rnd() * 0.18);
    const sy = 1.10 + rnd() * 0.10;
    const lobe = {
      x: bx0 + gapB * i + (rnd() - 0.5) * rB * 0.14,
      y: baseY + (rP / 1.3) * 1.42 + (r / sy) * 0.52,
      r, sy, w: 0.96,
    };
    row2.push(lobe);
    lobes.push(lobe);
  }
  // ③ 지배 어깨 덩어리 — 기단 반경의 1.34~1.52 배. 뱅크는 "봉우리 하나"가 아니므로 상공 적운의
  //    1.84~2.14 밴드까지 올리지 않는다(올리면 뱅크가 단일 적운으로 읽힌다). 한쪽으로 치우쳐 얹어
  //    좌우 비대칭을 만들고, 볼 2 개로 큰 원호를 깬다(0.70rD — 부모 필드가 확실히 이어지는 거리).
  const side = rnd() < 0.5 ? -1 : 1;
  const rD = rP * (1.34 + rnd() * 0.18);
  const syD = 1.06 + rnd() * 0.10;
  const ryD = rD / syD;
  const ax = cx + side * gapP * 0.62 + (rnd() - 0.5) * rP * 0.20;
  const dy0 = row2[1].y + (row2[1].r / row2[1].sy + ryD) * 0.46;
  lobes.push({ x: ax, y: dy0, r: rD, sy: syD, w: 1.0 });
  const cheekSide = rnd() < 0.5 ? -1 : 1;
  for (let c = 0; c < 2; c++) {
    const ang = (0.78 + rnd() * 0.34) * (c === 0 ? cheekSide : -cheekSide);
    lobes.push({
      x: ax + Math.sin(ang) * rD * 0.70,
      y: dy0 + Math.cos(ang) * ryD * 0.44,
      r: rD * (0.40 + rnd() * 0.12), sy: 1.04 + rnd() * 0.08, w: 0.97,
    });
  }
  // ④ 적층 3 단 — 반경·간격 모두 rD 파생. 세로로 쌓아 종횡비를 1.3 아래로 끌어내리는 축이다.
  let ty = dy0, tyR = ryD;
  for (let k = 0; k < 3; k++) {
    const r = rD * [0.56, 0.40, 0.28][k] * (0.92 + rnd() * 0.16);
    const sy = 1.02 + rnd() * 0.08;
    const ry = r / sy;
    ty += (tyR + ry) * 0.58;
    tyR = ry;
    const count = k === 0 ? 2 : 1;
    const sep = r * 1.20;
    for (let j = 0; j < count; j++) {
      lobes.push({
        x: ax + skew * (k + 1) * 0.30 + (j - (count - 1) * 0.5) * sep + (rnd() - 0.5) * r * 0.20,
        y: ty + (rnd() - 0.5) * ry * 0.16,
        r, sy, w: 0.96 - 0.05 * k,
      });
    }
  }
  // ⑤ 반대쪽 낮은 크라운 1 개 — 지배 어깨와 경쟁하지 않는 반경대(0.60~0.74 rD)에서 뱅크가
  //    "여러 봉우리의 열"로 읽히게 한다. 기단 열 폭 안에 두므로 총폭은 늘지 않는다.
  const si = side > 0 ? 0 : nP - 1;
  const rS = rD * (0.60 + rnd() * 0.14);
  const syS = 1.08 + rnd() * 0.10;
  const sy0 = base[si].y + (rS / syS) * 0.72;
  lobes.push({ x: base[si].x + skew * 0.2, y: sy0, r: rS, sy: syS, w: 1.0 });
  // ⑥ 실루엣을 텍스처에 맞춰 등방 스케일(바닥선 고정) — 상공 적운 ⑤ 와 같은 규칙. 등방이므로
  //    종횡비는 이 단계에서 변하지 않고, 화면 점유만 시드 간에 고르게 맞춰진다.
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of lobes) {
    minX = Math.min(minX, L.x - L.r);
    maxX = Math.max(maxX, L.x + L.r);
    maxY = Math.max(maxY, L.y + L.r / (L.sy || 1));
  }
  const fit = Math.min(S * (0.86 + rnd() * 0.05) / (maxX - minX), S * 0.655 / (maxY - baseY));
  const mid = (minX + maxX) * 0.5;
  for (const L of lobes) {
    L.x = cx + (L.x - mid) * fit;
    L.y = baseY + (L.y - baseY) * fit;
    L.r *= fit;
  }
  // ⑦ 스캘럽(상공 적운과 같은 규칙): 기존 로브 윗면에 걸치는 작은 봉우리 — 망원에서 윤곽이 잘게
  //    부서진다. 크기는 **부모 반경 파생** — 절대 크기로 두면 fit 이후 사라지거나 튄다.
  const pool = lobes.slice();
  const nScallop = 9 + Math.floor(rnd() * 5);
  for (let i = 0; i < nScallop; i++) {
    let pick = pool[Math.floor(rnd() * pool.length)];
    const alt = pool[Math.floor(rnd() * pool.length)];
    if (alt.y > pick.y) pick = alt;
    const ang = (rnd() - 0.5) * 1.9;
    lobes.push({
      x: pick.x + Math.sin(ang) * pick.r * 0.62,
      y: pick.y + Math.cos(ang) * (pick.r / (pick.sy || 1)) * 0.60,
      r: Math.min(S * 0.062, Math.max(S * 0.024, pick.r * (0.26 + rnd() * 0.14))),
      sy: 1.0, w: 0.76 + rnd() * 0.14,
    });
  }
  return {
    lobes, baseY, erosionCycles: 10, crinkleCycles: 25, wobble: 0.34,
    skyK: 2.9, threshold: 0.32, feather: 0.115,
    plinthR: rP * fit, domR: rD * fit, nPlinth: nP,
  };
}

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

// 도구가 직접 호출하는 순수 베이커(DOM 무의존). → { size, data: Uint8Array(RGBA, y-up) }
export function bakeCloudData(seed = 1, variant = 'cumulus', S = CLOUD_TEX_SIZE) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const spec = variant === 'horizon' ? horizonLobes(rnd, S) : cumulusLobes(rnd, S);
  const f = cloudLobeField(S, spec.lobes);
  const TH = spec.threshold, FE = spec.feather;

  // 1) 침식 — 곱연산(내부 밀도 변주 → 법선 요철)과 마스크된 덧셈(등고선 굽힘 → 실루엣 파괴)을
  //    함께 쓴다. 곱만으로는 임계 근처 이동량이 1px 대라 실루엣이 그대로 원호로 남는다.
  //    **깎기는 외곽 근처에서만** 한다(FIX② 2026-08-03). 1 차는 v<0.45 를 '얇은 곳'으로 보고
  //    깎았는데 로브 이음부의 골(0.32~0.45)은 실루엣 내부에도 널려 있어서, 그 자리에 하늘이
  //    뚫린 선명한 홀과 S 자 음영 홈이 생겼다("확대 시 우습다"의 최대 기여자). 외곽까지의
  //    거리로 게이트하면 윤곽 굽힘은 그대로 남고 내부는 손대지 않는다.
  const outside = cloudExterior(f, S, TH);
  const shore = new Float32Array(S * S);
  {
    // 외부까지의 체임퍼 거리(전방·후방 2 패스). 외부 종자는 테두리 연결 성분만 쓰므로 기하적
    //   내부 홀이 이미 있어도 그 홀을 키우지 않는다.
    const BIG = 1e6;
    const d = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) d[i] = outside[i] ? 0 : BIG;
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
  const stats = { isolatedPx: 0, holePx: 0, components: 1 };
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
      variant, seed, plinthR: spec.plinthR, domR: spec.domR, nPlinth: spec.nPlinth,
      domRatio: spec.plinthR > 0 ? spec.domR / spec.plinthR : 0,
      rawComponents: stats.components, isolatedPx: stats.isolatedPx, holeFillPx: stats.holePx,
    },
  };
}

function makeCloudDataTexture(seed, variant) {
  const { size, data } = bakeCloudData(seed, variant);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;      // RGB 는 법선·AO 데이터 — sRGB 디코딩 금지
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;               // 원경 뱅크 인스턴스는 화면에서 작다(에일리어싱 방어)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

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
function patchCloudRim(material) {
  const state = {
    color: new THREE.Color(0xffc68c),                    // 림(은·금테) — tools 가 이 키를 읽는다
    strength: { value: 0 },
    direction: new THREE.Vector3(0.8, 0.4, -0.45).normalize(),   // 뷰공간 태양 방향(z<0 = 역광)
    texel: new THREE.Vector2(1.8 / CLOUD_TEX_SIZE, 1.8 / CLOUD_TEX_SIZE),
    sun: new THREE.Color(0xfff1e0),                      // 볕면 직사색
    shade: new THREE.Color(0xc6ccd6),                    // 그늘면 = 하늘 산란색
    // x=직사 y=천공 z=역광 투과 w=다중산란 바닥(밝은 낮에만 — FIX⑥ day 존재감)
    gain: new THREE.Vector4(1, 0.82, 0.75, 0),
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
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec3 uCloudRimColor;
uniform float uCloudRimStrength;
uniform vec3 uCloudSunDir;
uniform vec2 uCloudTexel;
uniform vec3 uCloudSunColor;
uniform vec3 uCloudShadeColor;
uniform vec4 uCloudGain;`,
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
#ifdef USE_MAP
  vec4 cloudData = texture2D(map, vMapUv);
  vec2 cloudNxy = cloudData.rg * 2.0 - 1.0;
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
  vec2 cloudRadial = normalize(vMapUv - vec2(0.5) + vec2(1e-4));
  float cloudSunSide = smoothstep(-0.26, 0.64, dot(cloudRadial, normalize(cloudSunV.xy + vec2(1e-4))));
  // 랩 램버트 + 다중산란 바닥. 구름은 다중산란체라 종단이 부드럽고, 밝은 낮에는 태양을 등진 면도
  //   하얗게 밝다 — 그 바닥(uCloudGain.w, 낮에만 켜진다)이 없으면 낮 구름이 하늘보다 어두워진다.
  float cloudWrap = smoothstep(-0.86, 0.52, cloudNdl);
  float cloudDirect = (uCloudGain.w + (1.0 - uCloudGain.w) * cloudWrap * cloudWrap)
                    * mix(0.58, 1.0, cloudSky);
  float cloudAmbient = 0.52 + 0.48 * cloudSky;
  // 투과광은 얇은 부분이 강하고, 위쪽 밀도에 가린 밑면은 태양광이 도달하지 못하므로 천공
  //   개방도로도 눌러야 한다. 이 항을 빼면 역광 프레임에서 밑면까지 웜으로 물들어 구름 전체가
  //   한 덩어리 주황이 된다. 코어 바닥 0.38 은 부피용이다 — 로브별 −ndl 변주(역광에서 유일하게
  //   남는 셰이딩 신호)를 살리려면 코어에도 실질 가중이 있어야 한다.
  float cloudGlow = pow(max(0.0, -cloudNdl), 1.30) * mix(0.38, 1.0, cloudThin)
                  * mix(0.34, 1.0, cloudSky) * mix(0.24, 1.0, cloudSunSide) * cloudBack;
  vec3 cloudBody = uCloudShadeColor * (cloudAmbient * uCloudGain.y)
                 + uCloudSunColor * (cloudDirect * uCloudGain.x + cloudGlow * uCloudGain.z);
  float cloudNearA = min(
    min(texture2D(map, vMapUv + vec2(uCloudTexel.x, 0.0)).a,
        texture2D(map, vMapUv - vec2(uCloudTexel.x, 0.0)).a),
    min(texture2D(map, vMapUv + vec2(0.0, uCloudTexel.y)).a,
        texture2D(map, vMapUv - vec2(0.0, uCloudTexel.y)).a)
  );
  float cloudEdge = smoothstep(0.07, 0.62, cloudData.a)
                  * (1.0 - smoothstep(0.24, 0.88, cloudNearA));
  // 림 방위·높이 가중을 좁힌다(FIX⑤): 새벽 프레임에서 림이 둘레 전체 키라인으로 읽혔다. 반태양
  //   쪽 바닥 0.08→0.03, 방위 램프에 pow 1.5, 밑면 크라운 바닥 0.68→0.42 — 실제 구름은 가장
  //   두꺼운 밑면 윤곽에 금테가 서지 않는다.
  float cloudCrown = mix(0.42, 1.0, smoothstep(0.28, 0.84, vMapUv.y));
  diffuseColor.rgb = diffuse * cloudBody
                   + uCloudRimColor * uCloudRimStrength * cloudEdge
                   * mix(0.03, 1.0, pow(cloudSunSide, 1.5)) * cloudCrown * cloudBack;
#endif`,
    );
  };
  material.customProgramCacheKey = () => 'cheoma-cloud-shade-v3';
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
    return { group: root, uniforms: u, update() {}, setEnabled() { root.visible = false; }, dispose() {} };
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
  const highSpecs = [
    { r: 0.20, ang: 2.4, y: 82, w: 150, h: 108, op: 0.72, sp: 0.55 },
    { r: 0.46, ang: 5.6, y: 100, w: 182, h: 124, op: 0.66, sp: 0.42 },
    { r: 0.30, ang: 4.1, y: 90, w: 160, h: 112, op: 0.62, sp: 0.68 },
    { r: 0.55, ang: 1.0, y: 108, w: 192, h: 132, op: 0.58, sp: 0.5 },
    { r: 0.14, ang: 0.2, y: 76, w: 136, h: 100, op: 0.68, sp: 0.62 },
  ].slice(0, nHigh);
  // 실제 billboard 수만큼만 생성한다. 기본 nHigh=4에서 고정 5장을 만들면 마지막
  // CanvasTexture는 어떤 material에도 연결되지 않아 상위 Object3D teardown이 회수할 수 없다.
  const cloudSeeds = [11, 29, 47, 63, 81];
  const cloudTex = highSpecs.map((_, i) => makeCloudDataTexture(cloudSeeds[i], 'cumulus'));
  highSpecs.forEach((s, i) => {
    const mat = new THREE.MeshBasicMaterial({
      map: cloudTex[i], transparent: true, opacity: s.op, depthWrite: false,
      fog: true, blending: THREE.NormalBlending, side: THREE.DoubleSide,
    });
    patchCloudRim(mat);
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
        const distance = cam.position.distanceTo(mesh.position);
        const verticalFov = Number.isFinite(cam.fov) ? cam.fov * Math.PI / 180 : 18 * Math.PI / 180;
        const aspect = Number.isFinite(cam.aspect) && cam.aspect > 0 ? cam.aspect : 16 / 9;
        const halfFrameAtDepth = distance * Math.tan(verticalFov * 0.5) * aspect;
        const frameFraction = halfFrameAtDepth > 1e-6
          ? mesh.userData.w * 0.5 / halfFrameAtDepth : Infinity;
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
        mesh.material.opacity = base * (1 - g * OF_DEPTH) * proximity;
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
  const horizonTexture = makeCloudDataTexture(97, 'horizon');
  const horizonMaterial = new THREE.MeshBasicMaterial({
    map: horizonTexture, transparent: true, opacity: HORIZON_CLOUD_OPACITY,
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
  patchCloudRim(horizonMaterial);
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
  const horizonSpecs = Array.from({ length: HORIZON_CLOUD_COUNT }, (_, i) => ({
    az: 0.17 + i * Math.PI * 2 / HORIZON_CLOUD_COUNT,
    // These 9–12° centres belong to an explicit sky-facing view. The default 24°
    // downward courtyard focus deliberately misses the band and updateView sleeps it;
    // when a user looks upward, regular depth testing still lets roofs and ridges
    // occlude the cloud bottoms without a depth-free layer over the architecture.
    // #50 A3: the four centres spanned only 0.160–0.215, so every instance in a frame sat at
    //   nearly one elevation and the ring read as a level string of blobs rather than clouds at
    //   different heights. The span roughly doubles (0.160–0.262) while the **lowest** centre is
    //   unchanged, because the authored 24° downward courtyard focus must keep missing the band
    //   (updateView sleeps it there) — the spread only ever goes up, never down.
    elev: [0.160, 0.228, 0.190, 0.262][i % 4],
    sx: [0.82, 1.06, 1.18, 0.94][i % 4],
    sy: [0.84, 1.06, 0.92, 1.14][(i + 1) % 4],
  }));
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

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeObjectTree(root);
    root.clear();
  }

  return { group: root, uniforms: u, update, updateView, setEnabled, dispose };
}
