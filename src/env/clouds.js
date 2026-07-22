import { smoothstep } from '../core/math/scalar.js';
import { disposeObjectTree } from '../core/three-resources.js';
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
export const CLOUD_SHADOW_FRAG_DECL = `
uniform float uCloudTime; uniform float uCloudStr;
uniform vec4 uCloudBlobs[${MAX_CLOUD_BLOBS}];   // xy=지면중심 z=반경 w=세기
varying vec3 vCloudWorld;
float csHash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p, p+34.345); return fract(p.x*p.y); }
float csNoise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float a=csHash(i),b=csHash(i+vec2(1.,0.)),c=csHash(i+vec2(0.,1.)),d=csHash(i+vec2(1.,1.));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float csFbm(vec2 p){ float v=0.,a=0.55; for(int i=0;i<4;i++){ v+=a*csNoise(p); p=p*2.03+7.1; a*=0.5;} return v; }
// 한 구름 블롭의 그늘: 코어는 진하게(0..0.42 반경까지 꽉 참), 가장자리는 부드럽게 소실. wob 로 원형을 깬다.
float cloudBlob(vec4 b, vec2 wp, float wob){
  if (b.z < 0.5) return 0.0;                     // 비활성 슬롯
  float t = distance(wp, b.xy) / b.z + wob;      // 0=중심 .. 1=반경끝
  return b.w * (1.0 - smoothstep(0.42, 1.02, t));
}
`;
// color_fragment '뒤'(최종 색)에 얹는 감산 — 계절·적설·들판 금빛이 다 적용된 색을 어둡게.
//   블롭 5개를 상수 인덱스로 언롤(동적 인덱싱 금지). 가장자리 흔들림은 저주파 fbm 으로 공용.
export const CLOUD_SHADOW_FRAG_BODY = `
{
  vec2 wp = vCloudWorld.xz;
  float wob = (csFbm(wp * 0.011 + uCloudTime * 0.004) - 0.5) * 0.42;   // ±0.21 가장자리 요철
  float shade = 0.0;
  shade += cloudBlob(uCloudBlobs[0], wp, wob);
  shade += cloudBlob(uCloudBlobs[1], wp, wob);
  shade += cloudBlob(uCloudBlobs[2], wp, wob);
  shade += cloudBlob(uCloudBlobs[3], wp, wob);
  shade += cloudBlob(uCloudBlobs[4], wp, wob);
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

// 뭉게구름(적운) 텍스처 — 평평한 바닥 + 봉긋한 상부(다층 로브) + 상단 밝음/하단 그늘 베이크(볼륨감).
//   위쪽이 은빛으로 밝고 아래가 청회 그늘이라 카메라·태양 방위와 무관하게 "덩어리"로 읽힌다(림 라이팅
//   대용). 재질 color 가 이 위에 곱해져 시간대 틴트(석양 살구·야간 회청)를 얹는다. 결정론 시드.
function makeCumulusTexture(seed = 1) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  g.clearRect(0, 0, S, S);

  const baseY = S * 0.70;                    // 평평한 바닥선(아래쪽에 둬 위로 봉긋이 솟게)
  // 1) 실루엣: 바닥선을 따라 큰 로브 + 그 위 작은 로브(양배추형 봉우리). 중심 거의 불투명 → 소프트 외곽.
  //   가로 폭을 좁히고(중앙 55%) 위로 쌓아(봉우리 높이 ↑) 넓적한 줄무늬 대신 뭉게구름 덩어리로 읽히게.
  const lobes = [];
  const nBig = 4;
  for (let i = 0; i < nBig; i++) {
    const t = i / (nBig - 1);
    const x = S * 0.26 + t * S * 0.48 + (rnd() - 0.5) * 10;
    const r = S * (0.155 + rnd() * 0.06);
    const y = baseY - r * 0.55 - rnd() * S * 0.03;
    lobes.push({ x, y, r });
  }
  const nTop = 5;
  for (let i = 0; i < nTop; i++) {
    const x = S * 0.30 + rnd() * S * 0.40;
    const r = S * (0.10 + rnd() * 0.07);
    const y = baseY - S * (0.20 + rnd() * 0.24);
    lobes.push({ x, y, r });
  }
  for (const L of lobes) {
    const rg = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.52, 'rgba(255,255,255,1)');       // 넓은 불투명 코어(덩어리 감)
    rg.addColorStop(0.80, 'rgba(255,255,255,0.9)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');           // 외곽 20%만 페더링(또렷한 실루엣)
    g.fillStyle = rg;
    g.beginPath(); g.arc(L.x, L.y, L.r, 0, Math.PI * 2); g.fill();
  }
  // 2) 바닥 평탄화: 바닥선 아래를 부드럽게 지운다(destination-out).
  g.globalCompositeOperation = 'destination-out';
  const bg = g.createLinearGradient(0, baseY - S * 0.04, 0, baseY + S * 0.09);
  bg.addColorStop(0, 'rgba(0,0,0,0)');
  bg.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = bg; g.fillRect(0, baseY - S * 0.04, S, S * 0.25);
  // 3) 볼륨 셰이딩: 실루엣 안에서만(source-atop) 아래를 청회로 어둡게 → 상단 밝음/하단 그늘.
  g.globalCompositeOperation = 'source-atop';
  const sg = g.createLinearGradient(0, S * 0.26, 0, baseY);
  sg.addColorStop(0, 'rgba(146,160,182,0)');
  sg.addColorStop(1, 'rgba(108,124,150,0.62)');
  g.fillStyle = sg; g.fillRect(0, 0, S, S);
  // 4) 상단 은빛 하이라이트(봉우리 윗면).
  const hg = g.createLinearGradient(0, S * 0.14, 0, S * 0.40);
  hg.addColorStop(0, 'rgba(255,255,255,0.55)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Distant cumulus needs a more intricate silhouette than the broad overhead shadow
// caster. Many small semi-opaque lobes form scalloped crowns and wispy shoulders;
// baked valley/underside shading survives telephoto DoF without reading as a cloud icon.
function makeHorizonCumulusTexture(seed = 97) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const baseY = S * 0.71;
  g.clearRect(0, 0, S, S);

  const lobe = (x, y, r, alpha) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(0.56, `rgba(255,255,255,${alpha * 0.94})`);
    grad.addColorStop(0.82, `rgba(255,255,255,${alpha * 0.58})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };

  // Four overlapping rows guarantee one connected mass. Each higher row narrows and
  // uses smaller puffs, yielding a broad base with a scalloped, asymmetric crown.
  const rows = [
    { count: 8, x0: 0.14, x1: 0.86, y: 0.64, r0: 0.105, r1: 0.14 },
    { count: 7, x0: 0.21, x1: 0.79, y: 0.55, r0: 0.095, r1: 0.13 },
    { count: 5, x0: 0.30, x1: 0.70, y: 0.46, r0: 0.082, r1: 0.115 },
    { count: 3, x0: 0.40, x1: 0.60, y: 0.38, r0: 0.072, r1: 0.10 },
  ];
  rows.forEach((row, rowIndex) => {
    for (let i = 0; i < row.count; i++) {
      const t = row.count > 1 ? i / (row.count - 1) : 0.5;
      const x = S * (row.x0 + (row.x1 - row.x0) * t) + (rnd() - 0.5) * S * 0.035;
      const y = S * row.y + (rnd() - 0.5) * S * (0.035 + rowIndex * 0.005);
      const r = S * (row.r0 + rnd() * (row.r1 - row.r0));
      lobe(x, y, r, 0.7 + rnd() * 0.2);
    }
  });

  // Flatten and feather the rain-free base.
  g.globalCompositeOperation = 'destination-out';
  const erase = g.createLinearGradient(0, baseY - S * 0.02, 0, baseY + S * 0.10);
  erase.addColorStop(0, 'rgba(0,0,0,0)');
  erase.addColorStop(0.42, 'rgba(0,0,0,0.14)');
  erase.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = erase; g.fillRect(0, baseY - S * 0.02, S, S * 0.18);

  // Cool underside and small soft valley pockets give volume before the dynamic rim.
  g.globalCompositeOperation = 'source-atop';
  const underside = g.createLinearGradient(0, S * 0.28, 0, baseY);
  underside.addColorStop(0, 'rgba(174,184,202,0)');
  underside.addColorStop(0.62, 'rgba(143,155,179,0.16)');
  underside.addColorStop(1, 'rgba(94,111,145,0.66)');
  g.fillStyle = underside; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 6; i++) {
    const x = S * (0.25 + rnd() * 0.5), y = S * (0.43 + rnd() * 0.18), r = S * (0.025 + rnd() * 0.035);
    const pocket = g.createRadialGradient(x, y, 0, x, y, r);
    pocket.addColorStop(0, 'rgba(74,91,124,0.20)');
    pocket.addColorStop(1, 'rgba(74,91,124,0)');
    g.fillStyle = pocket; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const crown = g.createLinearGradient(0, S * 0.18, 0, S * 0.42);
  crown.addColorStop(0, 'rgba(255,255,255,0.42)');
  crown.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = crown; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One-pass HDR silver/gold lining for the alpha edge of a cloud billboard. The shader
// samples alpha only (colour remains the regular map path), weights the contour toward
// the projected sun direction, and adds linear-HDR energy for the existing bloom pass.
// This costs no extra draw call and keeps the cloud itself available to moon/sun occlusion.
function patchCloudRim(material) {
  const state = {
    color: new THREE.Color(0xffc68c),
    strength: { value: 0 },
    direction: new THREE.Vector2(0.8, 0.4).normalize(),
    texel: new THREE.Vector2(1.8 / 256, 1.8 / 256),
  };
  material.userData.cloudRim = state;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudRimColor = { value: state.color };
    shader.uniforms.uCloudRimStrength = state.strength;
    shader.uniforms.uCloudRimDir = { value: state.direction };
    shader.uniforms.uCloudTexel = { value: state.texel };
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec3 uCloudRimColor;
uniform float uCloudRimStrength;
uniform vec2 uCloudRimDir;
uniform vec2 uCloudTexel;`,
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
#ifdef USE_MAP
  float cloudCenterA = texture2D(map, vMapUv).a;
  float cloudNearA = min(
    min(texture2D(map, vMapUv + vec2(uCloudTexel.x, 0.0)).a,
        texture2D(map, vMapUv - vec2(uCloudTexel.x, 0.0)).a),
    min(texture2D(map, vMapUv + vec2(0.0, uCloudTexel.y)).a,
        texture2D(map, vMapUv - vec2(0.0, uCloudTexel.y)).a)
  );
  float cloudEdge = smoothstep(0.07, 0.62, cloudCenterA)
                  * (1.0 - smoothstep(0.24, 0.88, cloudNearA));
  vec2 cloudRadial = normalize(vMapUv - vec2(0.5) + vec2(1e-4));
  float cloudSunSide = smoothstep(-0.32, 0.62, dot(cloudRadial, normalize(uCloudRimDir)));
  float cloudCrown = mix(0.68, 1.0, smoothstep(0.32, 0.82, vMapUv.y));
  diffuseColor.rgb += uCloudRimColor * uCloudRimStrength * cloudEdge
                    * mix(0.16, 1.0, cloudSunSide) * cloudCrown;
#endif`,
    );
  };
  material.customProgramCacheKey = () => 'cheoma-cloud-rim-v1';
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
export function buildEdgeMistRing(edge, {
  groundY = null, yBase = 8, yAmp = 2.5, rIn = 0.6, rMid = 0.85, rOut = 1.12,
  opacity = 0.52, thickness = 3.0, seed = 1,
} = {}) {
  const NS = 176;
  const pos = [], uv = [], idx = [];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
  const gY = (x, z) => (groundY ? groundY(x, z) : 0);
  for (let is = 0; is <= NS; is++) {
    const th = (is / NS) * Math.PI * 2;
    const Redge = edge.edgeRadiusAt(th);
    const cx = Math.cos(th), cz = Math.sin(th);
    // 저주파 리프트 출렁임(운해가 능선 등고를 따라 얇아지고 두꺼워짐). 정수 하모닉이라 2π 에서 닫힘.
    const lift = yBase + yAmp * (0.6 * Math.sin(2 * th + ph1) + 0.4 * Math.sin(3 * th + ph2));
    // 각 행은 자기 반경의 지형 표고 + 리프트 위에 떠 등고를 따라 밴드가 드리운다(중간 행이 불투명).
    const xi = cx * Redge * rIn,  zi = cz * Redge * rIn;
    const xm = cx * Redge * rMid, zm = cz * Redge * rMid;
    const xo = cx * Redge * rOut, zo = cz * Redge * rOut;
    pos.push(xi, gY(xi, zi) + lift + thickness, zi); uv.push(is / NS, 0);
    pos.push(xm, gY(xm, zm) + lift, zm);              uv.push(is / NS, 0.5);
    pos.push(xo, gY(xo, zo) + lift - thickness * 0.6, zo); uv.push(is / NS, 1);
  }
  for (let is = 0; is < NS; is++) {
    const a = is * 3, b = is * 3 + 3;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // 반경 방향 알파 그라디언트(가운데 불투명 → 안·밖 투명).
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 8, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: 0xd6dde4, transparent: true, opacity, depthWrite: false,
    side: THREE.DoubleSide, fog: true,   // 초기색은 중립 헤이즈 — update(fogColor)가 대기색으로 갱신
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'edge-mist-ring';
  mesh.renderOrder = 2;
  const _c = new THREE.Color();
  const _white = new THREE.Color(0xffffff);
  let disposed = false;
  function update(fogColor) {
    if (disposed) return;
    if (fogColor) { _c.copy(fogColor).lerp(_white, 0.11); mat.color.copy(_c); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeObjectTree(mesh);
  }
  return { mesh, update, dispose };
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
  if (!anchors.length) return { group: root, update() {}, dispose() {} };
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const tex = makeCloudTexture(seed);
  const _up = new THREE.Vector3(0, 1, 0);
  const mats = [];
  for (const a of anchors) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xd6dde4, transparent: true, opacity: (a.op != null ? a.op : opacity) * (0.85 + rnd() * 0.3),
      depthWrite: false, fog: true, side: THREE.FrontSide,   // 카메라 대면이라 뒷면 불필요 → 1 드로우콜
    });
    const ww = (a.w != null ? a.w : w) * (0.85 + rnd() * 0.35), hh = (a.h != null ? a.h : h) * (0.85 + rnd() * 0.3);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), mat);
    mesh.position.set(a.x, a.y, a.z);
    mesh.renderOrder = 2;
    mesh.onBeforeRender = (rend, sc, cam) => {   // yaw 만 카메라로(직립 유지) — 사면에 걸친 수직 뱅크
      mesh.lookAt(cam.position.x, mesh.position.y, cam.position.z);
      mesh.up.copy(_up);
    };
    root.add(mesh);
    mats.push(mat);
  }
  const _c = new THREE.Color(), _white = new THREE.Color(0xffffff);
  let disposed = false;
  function update(fogColor) {
    if (!disposed && fogColor) { _c.copy(fogColor).lerp(_white, 0.14); for (const m of mats) m.color.copy(_c); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeObjectTree(root);
    root.clear();
  }
  return { group: root, update, dispose };
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
  const cloudTex = highSpecs.map((_, i) => makeCumulusTexture(cloudSeeds[i]));
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
        w: s.w, op: s.op, sp: s.sp, phase: i * (6.2832 / nHigh), blob: i,
      };
    } else {
      const rad = R * s.r + 40;
      mesh.userData = {
        baseX: Math.cos(s.ang) * rad, z: Math.sin(s.ang) * rad, y: s.y,
        w: s.w, op: s.op, sp: s.sp, phase: i * 2.1, blob: i,   // blob: 대응 그림자 uniform 슬롯
      };
    }
    // 카메라를 향해 빌보드 — 렌더 직전 실제 카메라를 받아 재조준(update 에 카메라 불필요).
    const _up = new THREE.Vector3(0, 1, 0);
    mesh.onBeforeRender = (r, sc, cam) => {
      mesh.lookAt(cam.position.x, mesh.position.y + (cam.position.y - mesh.position.y) * 0.35, cam.position.z);
      mesh.up.copy(_up);
      const rim = mesh.material.userData.cloudRim;
      if (rim) {
        const me = cam.matrixWorld.elements;
        rim.direction.set(
          _sunDir.x * me[0] + _sunDir.y * me[1] + _sunDir.z * me[2],
          _sunDir.x * me[4] + _sunDir.y * me[5] + _sunDir.z * me[6],
        );
        if (rim.direction.lengthSq() < 1e-5) rim.direction.set(0, 1);
        else rim.direction.normalize();
      }
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
        // A 150 m plane still fills a 20° lens from several plane-widths away.
        // Keep it out until its apparent width is below roughly 20°, then restore
        // it gradually below 12°. The horizon bank supplies the closer silhouettes.
        const proximity = smoothstep(mesh.userData.w * 2.8, mesh.userData.w * 4.6, distance);
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
  // At the low-cloud distance this subtends roughly 14–20° after deterministic scale
  // variation: one or two silhouettes in a 20° telephoto frame, never a white ceiling.
  const HORIZON_CLOUD_W = 18;
  const HORIZON_CLOUD_H = 10;
  const HORIZON_CLOUD_OPACITY = 0.72;
  const horizonTexture = makeHorizonCumulusTexture(97);
  const horizonMaterial = new THREE.MeshBasicMaterial({
    map: horizonTexture, transparent: true, opacity: HORIZON_CLOUD_OPACITY,
    depthWrite: false, depthTest: true, fog: false, blending: THREE.NormalBlending,
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
    // These 9–12° centres belong to an explicit sky-facing view. The default 14°
    // downward courtyard focus deliberately misses the band and updateView sleeps it;
    // when a user looks upward, regular depth testing still lets roofs and ridges
    // occlude the cloud bottoms without a depth-free layer over the architecture.
    elev: [0.160, 0.195, 0.178, 0.215][i % 4],
    sx: [0.82, 1.06, 1.18, 0.94][i % 4],
    sy: [0.84, 1.06, 0.92, 1.14][(i + 1) % 4],
  }));
  const horizonDummy = new THREE.Object3D();
  const horizonForward = new THREE.Vector3();
  const horizonAnchor = new THREE.Object3D();
  horizonAnchor.userData.w = HORIZON_CLOUD_W;
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
    horizonAnchor.userData.w = HORIZON_CLOUD_W * nearest.sx;

    const rim = horizonMaterial.userData.cloudRim;
    if (rim) {
      const me = cam.matrixWorld.elements;
      rim.direction.set(
        _sunDir.x * me[0] + _sunDir.y * me[1] + _sunDir.z * me[2],
        _sunDir.x * me[4] + _sunDir.y * me[5] + _sunDir.z * me[6],
      );
      if (rim.direction.lengthSq() < 1e-5) rim.direction.set(0, 1);
      else rim.direction.normalize();
    }
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
  // 마을: 그림자 발자국을 프레임(COVER)에 비례시켜 몇 개가 유유히 지난다(반경 ≈ COVER·0.5 → 프레임에
  //   2~3 개가 겹치지 않고 든다). 레이킹(석양 장그림자)도 COVER 로 상한을 조여 그림자가 프레임 밖으로
  //   날아가지 않게 한다(진단: 기존 RAKE_MAX=78 이 저고도에서 그늘을 남쪽 가장자리로 밀어냈다).
  const villRadius = Math.max(22, COVER * 0.36);   // 이산 그늘(프레임에 2~3 개 든다 — 상시 반그늘 방지)
  const villRakeMax = COVER * 0.28;   // 저고도 장그림자 상한(프레임 한쪽 굶주림 방지 — 진단 #108)
  function writeBlob(m) {
    const b = u.uCloudBlobs.value[m.userData.blob];
    if (!b) return;
    const p = m.position;
    const hy = Math.max(0.001, Math.hypot(_sunDir.x, _sunDir.z));
    const nx = _sunDir.x / hy, nz = _sunDir.z / hy;         // 태양 수평방향(정규화)
    const rakeMax = village ? villRakeMax : RAKE_MAX;
    const rake = Math.min(rakeMax, (1 - Math.min(1, _sunDir.y)) * p.y * RAKE);
    const rad = village ? villRadius : m.userData.w * SHADOW_R;
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
    // 그림자 전역 세기: 밝은 낮 강, 석양 중강, 새벽 약. #68 상향.
    const daylight = 0.52 * smoothstep(1.2, 2.45, inten);
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

    highClouds.forEach((m) => {
      place(m);
      writeBlob(m);                                    // 빌보드 위치 → 대응 그림자 블롭 갱신
      m.material.color.copy(_base).lerp(_warm, warmMix * 0.7);
      // The haze colour is the resolved atmosphere profile, so crimson/violet sunsets
      // tint cloud bodies without making the physically warm direct sun itself purple.
      if (haze?.isColor) m.material.color.lerp(_haze, (1 - alt) * 0.16);
      m.material.color.multiplyScalar(dim);
      const rim = m.material.userData.cloudRim;
      if (rim) { rim.color.copy(_rimColor); rim.strength.value = rimStrength; }
      // 야간엔 뭉게구름이 창불 야경을 방해하지 않게 물러난다(저광량 불투명도 바닥 ↓).
      const opNow = m.userData.op * (0.32 + 0.68 * smoothstep(0.8, 2.55, inten));
      m.userData.opNow = opNow;              // 부감 인스턴스는 onBeforeRender 가 시선각으로 추가 감쇠
      m.material.opacity = opNow;
    });
    horizonMaterial.color.copy(_base).lerp(_warm, warmMix * 0.74);
    if (haze?.isColor) horizonMaterial.color.lerp(_haze, (1 - alt) * 0.20);
    // Keep the low-sun body below white so the gold/silver HDR edge has tonal room
    // to read as a lining instead of bleaching the whole cloud into one flat cutout.
    // Midday remains bright; night still follows the shared dim multiplier.
    const horizonLuminance = 0.72 + 0.22 * brightSky - 0.14 * lowSun;
    horizonMaterial.color.multiplyScalar(dim * horizonLuminance);
    const horizonRim = horizonMaterial.userData.cloudRim;
    if (horizonRim) { horizonRim.color.copy(_rimColor); horizonRim.strength.value = rimStrength * 1.08; }
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
