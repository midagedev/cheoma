import * as THREE from 'three';
import { candleFlicker } from './night-glow.js';
import { disposeObjectTree } from '../core/three-resources.js';
import {
  DEFAULT_SUNSET_LOOK,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
} from './atmosphere-profiles.js';
import {
  DEFAULT_MOON_OPTICS,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_RENDER_ORDER,
} from './moon-optics.js';
import {
  MILKY_WAY,
  MOON_TEXTURE,
  STAR_FIELD,
  STAR_TIME_FADE,
  SUN_DISK,
  SUN_DISK_TIME,
  buildStarField,
  elevationDegOf,
  milkyWayFade,
  milkyWayWeight,
  moonPhaseLightDir,
  moonTexel,
  sunDiskEnlargement,
  sunDiskFlattening,
  sunDiskProfile,
  sunDiskSpanWorld,
} from './celestial.js';

export { TIME_PRESETS } from './atmosphere-profiles.js';

// shot 모드(?shot=1): 별 반짝임 시계를 t=0 에 얼린다(clouds.js 표류와 같은 결정론 계약).
const _skyQuery = (typeof location !== 'undefined')
  ? new URLSearchParams(location.search)
  : new URLSearchParams();
const SHOT = _skyQuery.get('shot') === '1';

// 달 코로나 텍스처. 직접광 원반 안쪽은 비워 단단한 0.52° 경계를 보존하고,
// 바로 바깥의 회절광에서 시작해 5° 안에서 낮은 에너지로 사라진다.
function makeMoonCoronaTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const half = c.width * 0.5;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  for (const [position, alpha] of MOON_CORONA_PROFILE) {
    grad.addColorStop(position, `rgba(255,255,255,${alpha})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── S1 태양 원반 텍스처 ───────────────────────────────────────────────────────
// 알파에 림 다크닝 프로필(celestial.js)을 굽고 RGB 는 흰색으로 둔다 — 시간대 색은 material.color,
// 세기는 opacity 가 소유하므로 크로스페이드 계약과 정합하고 재베이크가 없다(프로그램 +0).
// 가산 합성이라 화면 기여는 알파 프로필에 정확히 비례한다.
function makeSunDiskTexture() {
  const size = SUN_DISK.textureSize;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const half = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const a = sunDiskProfile(Math.hypot(dx, dy));
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── S2 달 표면(위상 + 크레이터 결) 텍스처 ─────────────────────────────────────
// 기존 구면 지오를 그대로 두고 equirect 알베도×위상 셰이딩을 map 으로 굽는다. 셰이더 패치가
//   아니므로 프로그램 계열은 코로나(MeshBasic+map)와 합쳐진다(+0).
// 베이크 프레임 규약(celestial.js): 로컬 +z = 관측자. moonDisk.onBeforeRender 가 매 프레임
//   lookAt(camera) 로 그 프레임을 카메라에 정렬하므로 위상 방향이 화면에서 안정적이고 재베이크가 0.
// UV 규약: three SphereGeometry 는 uv.v = 1 − theta/π 로 굽고 CanvasTexture 는 flipY=true 이므로
//   캔버스 행 y ↔ theta = ((y+0.5)/height)·π — 즉 sphereUvNormal 의 v 파라미터와 그대로 일치한다.
function makeMoonSurfaceTexture() {
  const { width, height } = MOON_TEXTURE;
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  const img = g.createImageData(width, height);
  const light = moonPhaseLightDir();
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const rgb = moonTexel(u, v, light);
      const i = (y * width + x) * 4;
      img.data[i] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
      img.data[i + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
      img.data[i + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// ── S3′ 은하수: 확산 휘도 오프스크린 베이크 ───────────────────────────────────
// 한 번 구워 두고 돔 캔버스에 globalAlpha 로 얹는다(드로우콜 +0 · 프로그램 +0 · 재베이크 0).
// 지평 게이트는 celestial.js#milkyWayWeight 가 소유한다 — 지평 아래는 정확히 0 이라
//   fog 색 수렴 계약과 check-fog-wash 의 돔 미러를 침해하지 않는다.
function makeMilkyWayCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  const img = g.createImageData(width, height);
  const R = Math.round(MILKY_WAY.tint[0] * 255);
  const G = Math.round(MILKY_WAY.tint[1] * 255);
  const B = Math.round(MILKY_WAY.tint[2] * 255);
  for (let y = 0; y < height; y++) {
    const pos = 1 - (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const w = milkyWayWeight((x + 0.5) / width, pos);
      const i = (y * width + x) * 4;
      img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B;
      img.data[i + 3] = Math.round(w * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ── S3 별 셰이더 ─────────────────────────────────────────────────────────────
// Points 1 드로우콜 · 프로그램 1 계열. 픽셀 크기는 등급에서(점광원은 화각과 무관하게 PSF 크기),
//   알파는 celestial.js#starAlpha 와 동일한 식(밝은 별이 먼저 뜨고 마지막에 진다),
//   반짝임은 두 주파수 합 ±uTwinkle(룩 문법: 감지되면 과함).
// GLSL 예약어(sample/patch/input/output/filter/active)는 지역변수로 쓰지 않는다.
const STAR_VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aBright;
  attribute float aPhase;
  uniform float uFade, uTime, uPixelRatio, uTwinkle, uBias;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float thresh = (1.0 - aBright) * uBias;
    vAlpha = clamp((uFade - thresh) / max(1e-4, 1.0 - thresh), 0.0, 1.0);
    float flick = 1.0 + uTwinkle * (
      sin(uTime * 1.7 + aPhase * 6.2831853) * 0.62
      + sin(uTime * 0.63 + aPhase * 17.0) * 0.38);
    vTint = aColor * flick;
    gl_PointSize = clamp(aSize * uPixelRatio * (0.94 + 0.06 * flick), 1.0, 4.0);
  }
`;
const STAR_FRAG = /* glsl */`
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    float core = 1.0 - smoothstep(0.30, 1.0, r);
    if (core <= 0.0) discard;
    gl_FragColor = vec4(vTint, vAlpha * core);
  }
`;

// All profiles keep exactly four sky stops (bottom to top), so time/look transitions can
// interpolate position and sRGB colour one-to-one without reallocating the canvas texture.

// 가을 능선 훅: season=autumn 일 때 원경 능선·안개를 단풍든 산자락 색조로 살짝 물들인다.
// 낮엔 분명히(따뜻한 산), 석양엔 이미 따뜻하니 약하게, 밤엔 거의 무채색으로 가라앉힌다.
// 값은 setPalette 와 같은 공간(THREE.Color(hex) 직접) — sRGB 디코드 없이 대기원근 색과 섞인다.
const AUTUMN_RIDGE = {
  near: new THREE.Color(0x8a6440),   // 가까운 능선: 단풍든 숲(대기감쇠로 채도 낮음)
  far: new THREE.Color(0xceac78),    // 원경: 따뜻한 haze (옅은 청색 능선을 상쇄해 회색화 방지)
  mist: new THREE.Color(0xead2ab),   // 능선 사이 안개도 살짝 온기
};
const AUTUMN_RIDGE_AMT = { dawn: 0.16, day: 0.36, sunset: 0.12, night: 0.04 };
const WINTER_RIDGE = {
  near: new THREE.Color(0x687078),
  far: new THREE.Color(0xb8c2ca),
  mist: new THREE.Color(0xd7dde2),
};
const WINTER_RIDGE_AMT = { dawn: 0.22, day: 0.42, sunset: 0.18, night: 0.10 };

// ── 돔 ↔ 대기(fog) 결합 (R5 / U1) ────────────────────────────────────────────
// 돔은 fog:false 라 대기 원근에 참여하지 않는다. 그래서 지평 아래(=지형이 끝난 뒤의 배경)까지
// 노을 그라디언트가 그대로 깔리면 지형 절단면이 하늘에 하드컷으로 붙어 "떠 있는 디오라마 원반"이
// 된다. 해법: 돔 텍스처에 현재 대기색을 알파 램프로 덮어 지평 아래를 fog 색으로 수렴시킨다
//   — scene.background(=fog 색)와 돔 지평이 같은 색이 되므로 지형 외곽·수관 실루엣이
//     "끝"이 아니라 대기로 소실되는 방향으로 읽힌다(운해 링·능선 물안개가 그 위를 마감).
// 지평 위에도 낮은 잔여 헤이즈를 남겨(HAZE_TOP) 하늘만 채도가 튀고 지형이 눌리는 대비를 완화한다.
// pos 규약: 0=천저(nadir) · 0.5=지평 · 1=천정(zenith) — 프로필 sky 스톱과 동일 공간.
// 지평 아래는 사실상 대기색으로 수렴시킨다(docs/look-grammar §3 "지평 밴드는 fog색 수렴"):
// 남긴 프로필 계조가 배경을 지형 헤이즈보다 밝게 만들면 절단면에 다시 단차가 생긴다(A/B 실측).
// 배경의 시각적 흥미는 칠해진 그라디언트가 아니라 능선 겹침·운무가 만든다.
// #211 U1: 부감은 지평 위·아래를 더 넓게 본다. 지평 밴드의 fog 수렴을 조금 더 올려 절단면 뒤
//   분홍 스카이 그라디언트가 하드컷 대비를 만들지 않게 한다(천정 채도는 유지 — 하늘은 죽이지 않음).
// #35-R2 부감 돔 구배 복원(2026-08-01). 결함: 부감 프레임 상부 7~24% 가 무구배 평면이었다
//   (3×3 국소 휘도 std 0.05~0.06 · 180행 동안 변화 4/255) — 그 평면 위로 돌출한 지오 섬의
//   내부 대비가 2.3~12.5배라 "안개 띠 위에 뜬 인스턴스"로 읽혔다(look-grammar §3 지형–하늘
//   경계 하드컷). 원인은 인스턴스가 아니라 이 램프다: 0.44~0.52 에서 α 0.96→0.74 로 단일
//   flat fog 색에 수렴하는데, 구 fog 가 그 밴드의 하늘 스톱과 거의 같은 휘도라 α 가 움직여도
//   화면 휘도가 변하지 않았다(오히려 지평 아래가 위보다 밝은 역구배 −2.2/100행).
//   #35-R2 에서 fog 휘도를 표면 휘도 근처로 내렸으므로(atmosphere-profiles.js gold 주석) 같은
//   램프가 이제 실제 구배를 만든다. 여기서는 그 위에 밴드 몫을 조금 더 열어 준다 —
//   0.52 0.74→0.62 · 0.62 0.28→0.24 · 0.44 0.96→0.94. 지평 아래 바닥(0.00)은 0.98 유지:
//   배경과의 동일색 수렴이 지형 절단면 하드컷 방지의 실제 계약이다.
//   모델 실측(돔 기여만, 부감 46°/1080행 렌즈, 100행당 휘도): gold −2.2 → +3.7 · crimson
//   −2.4 → +4.7 · violet −1.9 → +5.9 · dawn −0.9 → +14.0. 실프레임의 같은 밴드에는 태양
//   글로우·플레어·블룸의 가산이 겹치므로 합성 부호는 프레이밍에 따라 다르다 — 캡처로 확인된
//   것은 평면 휘도가 142~150 → 74~81 로 내려와 근경 지면대에 앉고 아래 경계의 하드 스텝이
//   3.8 → 0.9 로 줄었다는 것이다. 게이트: tools/check-fog-wash.mjs.
const DOME_HAZE = [
  { pos: 1.00, a: 0.07 },   // 천정: 프로필 색 거의 그대로(하늘은 유지 — 되돌리면 밋밋한 공백)
  { pos: 0.62, a: 0.24 },   // 지평 위 ≈+22°: 옅은 대기 헤이즈(부감 상단 밴드 대비 완화)
  { pos: 0.52, a: 0.62 },   // 지평 바로 위: 대기색 우세 + 노을 온기 잔향(아이레벨·히어로 화각)
  { pos: 0.44, a: 0.94 },   // 지평 아래 ≈−11°: 대기색 = scene.background 와 사실상 동일
  { pos: 0.00, a: 0.98 },
];

// ── P1′ 돔 채도 복원 (2026-08-01) ────────────────────────────────────────────
// #35-R2 는 fog 를 중립·저휘도로 옮겨 마젠타 워시를 끝냈다. 그 대가로 위 α 램프가 덮는
//   지평 밴드가 **fog 의 중립색 그대로** 수렴해, 돔이 자기 그라디언트를 잃고 회색판이 됐다
//   (실측: dawn 부감 밴드 평균 HSV 채도 0.049 · 색상이 24°→300° 로 흔들리는 회보라 뭉갬).
// fog 를 되올리는 것은 워시 회귀이므로 축을 나눈다: **fog 는 중립 유지, 돔만 채도를 되찾는다.**
//   방법 = haze 오버레이의 *색*을 fog 그대로가 아니라 "fog 의 휘도 + 그 자리 하늘의 색상"으로
//   바꾼다(HAZE_TINT 비율만큼). 휘도는 여전히 fog 로 수렴하므로 #35-R2 가 만든 수직 구배와
//   지형 절단면 대비 완화는 그대로고, 색상만 하늘에게 돌려준다.
// 지평 아래(pos ≤ 0.44)는 tint 0 이다 — 배경(scene.background = fog 색)과의 동일색 수렴이
//   지형 절단면 하드컷 방지의 실제 계약이라 여기만은 침해할 수 없다.
// 실측(부감 밴드 pos 0.44~0.52, 태양 반대 방위 = 최악): 평균 채도 gold 0.384 → 0.447 ·
//   crimson 0.245 → 0.293 · dawn 0.049 → 0.298(하늘 스톱 재저작 합산). 게이트의 구배 하한
//   (100행당 +1.5)은 전 방위에서 유지된다(최악 gold 반대방위 +2.90).
const HAZE_TINT = [
  { pos: 0.00, t: 0.00 },
  { pos: 0.44, t: 0.00 },   // 지평 아래: 배경과 동일색(계약)
  { pos: 0.52, t: 0.45 },
  { pos: 0.62, t: 0.72 },
  { pos: 1.00, t: 0.85 },
];

// ── P1′ 태양 방위 밝은 구간 (2026-08-01) ─────────────────────────────────────
// 돔은 지금까지 순수 수직 그라디언트(캔버스 4×256)라 방위 정보가 없었다. 그래서 부감이 어느
//   쪽을 물든 하늘 밴드가 똑같았고, 역광 프레이밍의 "태양이 저기 있다"는 신호를 post 의
//   sunGlow 스프라이트 하나가 전담했다. 캔버스를 가로로 열어(방위 = u) 태양 방위에 낮은
//   에너지의 온색 구간을 둔다 — 부감이 태양 쪽을 물면 따뜻한 밴드를, 반대쪽을 물면 중립
//   대기를 물게 된다.
// 세로 프로파일은 지평 바로 위(pos 0.545)를 중심으로 한 가우시안이고, 여기에 지평 아래를
//   0 으로 닫는 smoothstep 게이트를 곱한다 — 위 HAZE_TINT 와 같은 이유로 pos ≤ 0.40 의
//   배경 동일색 수렴은 침해하지 않는다.
// 게이트 영향: 글로우가 위로 갈수록 세지므로 부감 밴드의 상승 구배를 **키운다**
//   (gold 태양방위 +3.69 → +8.62 / 100행). 워시와 무관하다 — fog 가 아니라 돔 픽셀이고,
//   방위 폭 ±42° 밖에서는 사실상 0 이다.
const SUN_BAND = {
  posCenter: 0.545, posSigma: 0.085, posGateLo: 0.40, posGateHi: 0.50,
  azSigmaDeg: 42, peak: 0.26, uSteps: 48,
};

const HAZE_EPS = 1 / 512;   // sRGB 1/2 LSB — 이보다 작은 변화로는 텍스처를 다시 올리지 않는다
const DOME_TEX_W = 128;     // 방위 해상도(2.8°/px). 세로 256 은 기존과 동일.

// 전환 길이·이징 ---------------------------------------------------------------
const DUR_TIME = 1.8;      // 시간대 크로스페이드(초) — 짧은 타임랩스감(그림자가 스윽 돈다)
const SEASON_RATE = 2.6;   // 가을 능선 틴트 지수 접근 속도(seasons.js 수목 틴트와 결이 맞게)
const easeInOut = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

// '#rrggbb' → {r,g,b} 원시 sRGB(0..1, 디코드 없음). 캔버스 그라디언트가 스톱 사이를 sRGB 로
// 보간하므로, 시간대 간 스톱 색도 sRGB 로 보간해야 캔버스 룩과 일치한다.
function parseHexSRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// 하늘 돔 + 등불. mountains(setPalette) 를 함께 물려 대기원근을 동기화.
export function createSky({ scene, sun, hemi, renderer, group, mountains, layout }) {
  // Celestial presentation is scene-level. Village mode hides `group` to swap the
  // single-house terrain, but the sky must remain continuous behind both scenes.
  const skyRoot = new THREE.Group();
  skyRoot.name = 'sky-atmosphere';
  skyRoot.visible = false;
  scene.add(skyRoot);

  // 하늘 돔: 큰 구, 안쪽면, fog 미적용(하늘 자체). 텍스처는 재사용(트윈 중 매 프레임 재그림).
  const domeGeo = new THREE.SphereGeometry(720, 32, 20);
  const domeCanvas = document.createElement('canvas');
  domeCanvas.width = DOME_TEX_W; domeCanvas.height = 256;
  const domeCtx = domeCanvas.getContext('2d');
  // 은하수 확산 밴드(한 번만 베이크 — 돔과 같은 해상도로 1:1 합성).
  const milkyWayCanvas = makeMilkyWayCanvas(DOME_TEX_W, 256);
  const domeTex = new THREE.CanvasTexture(domeCanvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  // 방위축이 생겼으므로 u 는 감싸야 한다 — 태양 밴드가 u=0 을 걸치면 clamp 는 가장자리를 늘인다.
  domeTex.wrapS = THREE.RepeatWrapping;
  const domeMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false, map: domeTex });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.renderOrder = -100;
  // A sky sphere is angular scenery, not world geometry. Follow the render camera so
  // Hanyang aerials and telephoto parcel focus cannot leave the 720 m shell.
  dome.onBeforeRender = (rend, sc, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  skyRoot.add(dome);

  // 현재 대기(fog)색의 원시 sRGB — 돔 헤이즈 오버레이 색. syncHaze 가 갱신한다.
  const hazeSRGB = { r: 0.77, g: 0.64, b: 0.56 };
  const _hazeTmp = { r: 0, g: 0, b: 0 };

  // pos 에서의 프로필 하늘 색(sRGB 0..1) — 캔버스 그라디언트와 같은 sRGB 선형보간.
  function sampleStops(stops, pos) {
    const t = [...stops].sort((a, b) => a.pos - b.pos);
    if (pos <= t[0].pos) return { r: t[0].r, g: t[0].g, b: t[0].b };
    const last = t[t.length - 1];
    if (pos >= last.pos) return { r: last.r, g: last.g, b: last.b };
    for (let i = 1; i < t.length; i++) {
      if (pos <= t[i].pos) {
        const k = (pos - t[i - 1].pos) / (t[i].pos - t[i - 1].pos);
        return {
          r: t[i - 1].r + (t[i].r - t[i - 1].r) * k,
          g: t[i - 1].g + (t[i].g - t[i - 1].g) * k,
          b: t[i - 1].b + (t[i].b - t[i - 1].b) * k,
        };
      }
    }
    return { r: last.r, g: last.g, b: last.b };
  }
  function rampAt(table, key, pos) {
    const t = [...table].sort((a, b) => a.pos - b.pos);
    if (pos <= t[0].pos) return t[0][key];
    if (pos >= t[t.length - 1].pos) return t[t.length - 1][key];
    for (let i = 1; i < t.length; i++) {
      if (pos <= t[i].pos) {
        const k = (pos - t[i - 1].pos) / (t[i].pos - t[i - 1].pos);
        return t[i - 1][key] + (t[i][key] - t[i - 1][key]) * k;
      }
    }
    return t[t.length - 1][key];
  }
  const s2lin = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const lin2s = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
  const srgbLuma = (c) => 0.2126 * s2lin(c.r) + 0.7152 * s2lin(c.g) + 0.0722 * s2lin(c.b);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

  // haze 색: fog 의 휘도는 유지하고 색상만 그 자리 하늘에게 돌려준다(HAZE_TINT 비율).
  const _keep = { r: 0, g: 0, b: 0 };
  function hazeColorAt(stops, pos) {
    const tint = rampAt(HAZE_TINT, 't', pos);
    if (tint <= 0.001) return hazeSRGB;
    const base = sampleStops(stops, pos);
    const bl = srgbLuma(base);
    const fl = srgbLuma(hazeSRGB);
    if (bl <= 1e-6) return hazeSRGB;
    const k = fl / bl;
    _keep.r = lin2s(Math.min(1, s2lin(base.r) * k));
    _keep.g = lin2s(Math.min(1, s2lin(base.g) * k));
    _keep.b = lin2s(Math.min(1, s2lin(base.b) * k));
    return {
      r: hazeSRGB.r + (_keep.r - hazeSRGB.r) * tint,
      g: hazeSRGB.g + (_keep.g - hazeSRGB.g) * tint,
      b: hazeSRGB.b + (_keep.b - hazeSRGB.b) * tint,
    };
  }

  // 태양 방위의 텍스처 u. SphereGeometry 는 phi=u·2π 에서 수평방향 (−cos φ, sin φ) 를 만든다.
  function sunAzimuthU(dir) {
    const h = Math.hypot(dir.x, dir.z);
    if (h < 1e-6) return 0;
    const phi = Math.atan2(dir.z / h, -dir.x / h);
    const u = phi / (Math.PI * 2);
    return u - Math.floor(u);
  }

  // #53 R3 검증 전용 배율(제품 경로는 항상 1). window.__sky 가 이 두 값을 쓰고 돔을 다시 칠하므로
  //   "같은 부팅 · 같은 카메라"에서 SUN_BAND / 은하수 지분을 원자로 분리할 수 있다.
  let dbgSunBandScale = 1;
  let dbgMilkyWayScale = 1;

  // 스톱 배열({pos, r,g,b})로 돔 캔버스를 다시 그린다(텍스처 재사용).
  //   ① 프로필 수직 그라디언트 → ② 대기 결합 오버레이(DOME_HAZE × HAZE_TINT) →
  //   ③ 태양 방위 밝은 구간(SUN_BAND). ②는 지평 아래를 fog 색으로 수렴시키고, ③은 지평
  //   아래에서 0 이 되도록 게이트된다.
  function buildDomeFromStops(stops) {
    const W = DOME_TEX_W;
    const grad = domeCtx.createLinearGradient(0, 0, 0, 256);
    for (const s of stops) {
      const R = Math.round(s.r * 255), G = Math.round(s.g * 255), B = Math.round(s.b * 255);
      grad.addColorStop(1 - s.pos, `rgb(${R},${G},${B})`);
    }
    domeCtx.globalAlpha = 1;
    domeCtx.fillStyle = grad;
    domeCtx.fillRect(0, 0, W, 256);

    const haze = domeCtx.createLinearGradient(0, 0, 0, 256);
    for (const s of DOME_HAZE) {
      const c = hazeColorAt(stops, s.pos);
      const R = Math.round(clamp01(c.r) * 255), G = Math.round(clamp01(c.g) * 255), B = Math.round(clamp01(c.b) * 255);
      haze.addColorStop(1 - s.pos, `rgba(${R},${G},${B},${s.a})`);
    }
    domeCtx.fillStyle = haze;
    domeCtx.fillRect(0, 0, W, 256);

    drawSunBand(W);
    drawMilkyWay(W);
    domeTex.needsUpdate = true;
  }

  // 은하수 확산 밴드: 미리 구운 캔버스를 별 페이드(밤 전용 램프)만큼 얹는다.
  //   dawn(0.18)에서는 milkyWayFade=0 → 합성 자체를 건너뛰므로 박명 돔은 불변이다.
  function drawMilkyWay(W) {
    const weight = MILKY_WAY.peak * milkyWayFade(cur.stars) * dbgMilkyWayScale;
    if (weight <= 0.002) return;
    domeCtx.globalAlpha = weight;
    domeCtx.drawImage(milkyWayCanvas, 0, 0, W, 256);
    domeCtx.globalAlpha = 1;
  }

  // 태양 방위 온색 구간. RGB 는 전 구간 동일(태양색)하고 알파만 방위 가우시안으로 변하므로
  //   가로 그라디언트 하나를 재사용하고 세로는 globalAlpha 로 행마다 스케일한다.
  // #53 R3: 시간대 배율(cur.sunBandScale)은 저작 peak 에 곱해진다. 밤에만 0.31 로 내려가고
  //   낮·노을·새벽은 1 이라 저 프로필들의 돔 바이트는 동결이다. 배율은 트윈 필드이므로
  //   시간대 전환 중에도 연속으로 변한다(하드 컷 금지 계약).
  const _sunSRGB = { r: 1, g: 1, b: 1 };
  function drawSunBand(W) {
    const bandPeak = SUN_BAND.peak * cur.sunBandScale * dbgSunBandScale;
    if (bandPeak <= 0.0005) return;
    cur.sunColor.getRGB(_sunSRGB, THREE.SRGBColorSpace);
    const R = Math.round(clamp01(_sunSRGB.r) * 255);
    const G = Math.round(clamp01(_sunSRGB.g) * 255);
    const B = Math.round(clamp01(_sunSRGB.b) * 255);
    const uSun = sunAzimuthU(cur.sunDir);
    const band = domeCtx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= SUN_BAND.uSteps; i++) {
      const u = i / SUN_BAND.uSteps;
      let d = Math.abs(u - uSun);
      if (d > 0.5) d = 1 - d;                       // 원형 거리
      const a = Math.exp(-0.5 * ((d * 360) / SUN_BAND.azSigmaDeg) ** 2);
      band.addColorStop(u, `rgba(${R},${G},${B},${a.toFixed(4)})`);
    }
    domeCtx.fillStyle = band;
    for (let y = 0; y < 256; y++) {
      const pos = 1 - (y + 0.5) / 256;
      const v = bandPeak
        * smoothstep(SUN_BAND.posGateLo, SUN_BAND.posGateHi, pos)
        * Math.exp(-0.5 * ((pos - SUN_BAND.posCenter) / SUN_BAND.posSigma) ** 2);
      if (v <= 0.004) continue;
      domeCtx.globalAlpha = v;
      domeCtx.fillRect(0, y, W, 1);
    }
    domeCtx.globalAlpha = 1;
  }

  // 최종 합성 대기색(날씨 틴트·마을 모디파이어 이후)으로 돔 헤이즈를 맞춘다. env 의 fog 합성 훅이
  //   매 프레임 호출하므로 실변화가 없으면 텍스처를 다시 올리지 않는다(정착 상태 비용 0).
  function syncHaze(color) {
    if (!color) return;
    color.getRGB(_hazeTmp, THREE.SRGBColorSpace);
    if (Math.abs(_hazeTmp.r - hazeSRGB.r) < HAZE_EPS
      && Math.abs(_hazeTmp.g - hazeSRGB.g) < HAZE_EPS
      && Math.abs(_hazeTmp.b - hazeSRGB.b) < HAZE_EPS) return;
    hazeSRGB.r = _hazeTmp.r; hazeSRGB.g = _hazeTmp.g; hazeSRGB.b = _hazeTmp.b;
    buildDomeFromStops(cur.stops);
  }

  // 처마 네 모서리 등불: 따뜻한 PointLight + 작은 발광 구
  const lx = (layout.xEave ?? 9) * 0.98;
  const lz = (layout.zEave ?? 6) * 0.98;
  const ly = (layout.eaveEdgeY ?? 6.5) - 0.4;
  const lanterns = [];
  // 트윈 중 등불이 서서히 켜지/꺼지도록 발광 구를 반투명으로(정착 시 opacity=1 == 기존 룩).
  // #73 blowout 톤다운: 구 색 0xffca6e 는 R 채널이 255 로 클리핑된 거의 흰빛 웜이라, 야간 bloom
  //   (threshold 0.32)이 이를 흰 blowout 오브로 증폭했다. 채도 있는 웜 앰버(선형 휘도 ≈0.36, 야간
  //   임계 바로 위)로 낮춰 "코어는 호롱불 앰버, 헤일로도 앰버"로 은은히 피게 한다. 채도가 살아 있어
  //   bloom 가산분이 흰색으로 씻기지 않는다. 석양(임계 0.80)에선 이 밝기가 임계 아래라 bloom 없이
  //   작은 앰버 점으로만 남아 골든아워 룩 무회귀.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xdd8836, fog: true, transparent: true, opacity: 1 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const light = new THREE.PointLight(0xffb257, 0, 18, 2);
    light.position.set(sx * lx, ly, sz * lz);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), glowMat);
    bulb.position.copy(light.position);
    bulb.visible = false;
    group.add(light); group.add(bulb);
    lanterns.push({ light, bulb });
  }

  let flickT = 0;              // 등롱 촛불 플리커 누적 시계(결정론)
  let lanternNight = false;   // 등롱 일렁임(등불이 켜져 있을 때)

  // 달 + 달무리 (야간). scene-level sky 자식이며 environment lifecycle이 함께 켜고 정리한다.
  const moonGroup = new THREE.Group();
  moonGroup.name = 'moon';
  moonGroup.userData.optics = DEFAULT_MOON_OPTICS;
  const moonSurfaceTexture = makeMoonSurfaceTexture();
  const moonDisk = new THREE.Mesh(
    new THREE.SphereGeometry(DEFAULT_MOON_OPTICS.diskRadius, 24, 16),
    // 트윈 페이드용 반투명(정착 야간 opacity=1 == 기존 불투명 룩).
    // #53 S2: 균일 원반 → 위상·크레이터 베이크. color 는 달빛 색으로 남고 map 이 명암을 소유한다.
    new THREE.MeshBasicMaterial({
      color: 0xf4efda, map: moonSurfaceTexture, fog: false, depthTest: true, depthWrite: false,
      transparent: true, opacity: 1,
    })
  );
  moonDisk.name = 'moon-disk';
  // The moon is camera-relative. Its world-space bounds still describe the
  // previous frame until onBeforeRender repositions the group, so culling here
  // would prevent that lifecycle hook from ever repairing the placement.
  moonDisk.frustumCulled = false;
  moonDisk.renderOrder = MOON_RENDER_ORDER.disk;
  moonDisk.userData.angularDiameterDeg = DEFAULT_MOON_OPTICS.diskAngularDiameterDeg;
  moonGroup.add(moonDisk);
  const coronaTex = makeMoonCoronaTexture();
  const coronaGeometry = new THREE.PlaneGeometry(
    DEFAULT_MOON_OPTICS.coronaSpan,
    DEFAULT_MOON_OPTICS.coronaSpan,
  );
  const makeCorona = (name, opacity, renderOrder, layer) => {
    const mesh = new THREE.Mesh(
      coronaGeometry,
      new THREE.MeshBasicMaterial({
        map: coronaTex, color: 0xd5def2, transparent: true, opacity,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
      }),
    );
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.userData = {
      angularDiameterDeg: DEFAULT_MOON_OPTICS.coronaAngularDiameterDeg,
      layer,
      baseOpacity: opacity,
    };
    return mesh;
  };
  const transmittedCorona = makeCorona(
    'moon-corona-transmitted',
    MOON_CORONA_ENERGY.transmitted,
    MOON_RENDER_ORDER.coronaTransmitted,
    'transmitted',
  );
  const scatteredCorona = makeCorona(
    'moon-corona-scattered',
    MOON_CORONA_ENERGY.scattered,
    MOON_RENDER_ORDER.coronaScattered,
    'scattered',
  );
  transmittedCorona.frustumCulled = false;
  scatteredCorona.frustumCulled = false;
  moonGroup.add(transmittedCorona, scatteredCorona);
  const coronaLayers = [transmittedCorona, scatteredCorona];
  moonGroup.userData.coronaLayers = Object.freeze([
    Object.freeze({
      name: transmittedCorona.name,
      opacity: MOON_CORONA_ENERGY.transmitted,
      renderOrder: MOON_RENDER_ORDER.coronaTransmitted,
    }),
    Object.freeze({
      name: scatteredCorona.name,
      opacity: MOON_CORONA_ENERGY.scattered,
      renderOrder: MOON_RENDER_ORDER.coronaScattered,
    }),
  ]);
  moonGroup.visible = false;
  skyRoot.add(moonGroup);

  const moonOffset = new THREE.Vector3();
  const placeMoonForCamera = (camera) => {
    // The product directional light position is the shared celestial direction
    // source. Focused hero views may rotate it without rebuilding the sky state.
    moonOffset.copy(sun.position).normalize().multiplyScalar(DEFAULT_MOON_OPTICS.distance);
    moonGroup.position.copy(camera.position).add(moonOffset);
    moonGroup.updateMatrixWorld(true);
  };
  // 위상 베이크는 "로컬 +z = 관측자" 프레임이다. 매 프레임 카메라로 정렬해야 터미네이터가
  //   화면에서 안정적이다(재베이크 0). 코로나와 같은 lookAt→updateMatrixWorld 패턴.
  moonDisk.onBeforeRender = (rend, sc, camera) => {
    placeMoonForCamera(camera);
    moonDisk.lookAt(camera.position);
    moonDisk.updateMatrixWorld();
  };
  for (const corona of coronaLayers) {
    corona.onBeforeRender = (rend, sc, camera) => {
      placeMoonForCamera(camera);
      corona.lookAt(camera.position);
      corona.updateMatrixWorld();
    };
  }

  // ── 태양 원반 (S1) ────────────────────────────────────────────────────────
  // post.js 의 sunGlow(헤일로)·FlarePass(렌즈)는 불침해. 여기서 더하는 것은 같은 반경 위의
  //   "경계 있는 코어"뿐이다. 스프라이트라 항상 카메라를 향하고, scale.y 로 화면 수직을
  //   압축하므로 저고도 편평화가 화면 기준으로 성립한다.
  const sunDiskTexture = makeSunDiskTexture();
  const sunDiskSpan = sunDiskSpanWorld(SUN_DISK.distance);
  const sunDisk = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunDiskTexture, color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  }));
  sunDisk.name = 'sun-disk';
  sunDisk.renderOrder = -45;      // 돔(-100) 뒤 · sunGlow(-40) 앞
  sunDisk.visible = false;
  sunDisk.frustumCulled = false;  // 카메라 상대 배치 — 직전 프레임 바운즈로 컬링되면 안 된다
  sunDisk.onBeforeRender = (rend, sc, camera) => {
    sunDisk.position.copy(camera.position).addScaledVector(cur.sunDir, SUN_DISK.distance);
    sunDisk.updateMatrixWorld();
  };
  skyRoot.add(sunDisk);
  const SUN_CORE_WHITE = 0.45;    // 코어를 태양색보다 흰쪽으로 — 원반은 광원, 온기는 림·글로우 소유
  const _sunCore = new THREE.Color();
  const _white = new THREE.Color(1, 1, 1);

  // ── 별 + 은하수 (S3) ──────────────────────────────────────────────────────
  // 필드 별과 은하수 밴드를 한 버퍼에 실어 1 드로우콜. 배치는 celestial.js 의 지역 시드 rng —
  //   마을 생성의 전역 Math.random 시드창을 건드리지 않는다.
  const starField = buildStarField();
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starField.position, 3));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(starField.color, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starField.size, 1));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(starField.bright, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starField.phase, 1));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), starField.radius * 1.02);
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uTwinkle: { value: STAR_FIELD.twinkleAmp },
      uBias: { value: STAR_FIELD.twilightBias },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.name = 'stars';
  stars.renderOrder = -60;        // 돔 위 · 달(코로나 −1..4)보다 먼저 → 달 원반이 별을 덮는다
  stars.visible = false;
  stars.frustumCulled = false;
  // 카메라 추종(돔과 같은 패턴): 지형은 여전히 깊이를 소유하므로 능선 뒤 별은 가려진다.
  stars.onBeforeRender = (rend, sc, camera) => {
    stars.position.copy(camera.position);
    stars.updateMatrixWorld();
    starMat.uniforms.uPixelRatio.value = rend.getPixelRatio();
  };
  skyRoot.add(stars);
  let starClock = 0;

  // ── 상태(State) 표현 ──────────────────────────────────────────────────────
  // 보간 가능한 모든 시간대 필드를 한 객체로. 색은 setHex(sRGB→선형) 디코드된 THREE.Color 로
  // 저장해 선형에서 lerp 후 copy 로 적용 → 정착값은 기존 setHex 경로와 동일하다.
  function makeState() {
    return {
      sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunInt: 0,
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiInt: 0,
      fogColor: new THREE.Color(), fogNear: 0, fogFar: 0, exposure: 1,
      ridgeNear: new THREE.Color(), ridgeFar: new THREE.Color(), mist: new THREE.Color(),
      mistOp: 0, autumnAmt: 0, winterAmt: 0, lantern: 0, moon: 0,
      // #53: 천체 페이드도 시간대 트윈 필드다(하드 컷 금지 계약 — 별이 툭 켜지면 실패).
      stars: 0, sunDisk: 0,
      // #53 R3: SUN_BAND 시간대 배율도 같은 자리의 트윈 필드다(밤만 0.31 — 하드 컷이면 시간대
      //   전환에서 하늘 밝기가 툭 떨어진다). 기본 1 = 저작값 그대로.
      sunBandScale: 1,
      stops: [0, 1, 2, 3].map(() => ({ pos: 0, r: 0, g: 0, b: 0 })),
    };
  }
  let sunsetLook = DEFAULT_SUNSET_LOOK;
  function resolveInto(out, name) {
    const P = resolveAtmosphereProfile(name, sunsetLook);
    out.sunDir.set(P.sunDir[0], P.sunDir[1], P.sunDir[2]).normalize();
    out.sunColor.setHex(P.sunColor); out.sunInt = P.sunInt;
    out.hemiSky.setHex(P.hemiSky); out.hemiGround.setHex(P.hemiGround); out.hemiInt = P.hemiInt;
    out.fogColor.setHex(P.fog); out.fogNear = P.fogNear; out.fogFar = P.fogFar; out.exposure = P.exposure;
    out.ridgeNear.setHex(P.ridgeNear); out.ridgeFar.setHex(P.ridgeFar); out.mist.setHex(P.mist);
    out.mistOp = P.mistOp;
    out.autumnAmt = AUTUMN_RIDGE_AMT[name] ?? 0.3;
    out.winterAmt = WINTER_RIDGE_AMT[name] ?? 0.3;
    out.lantern = P.lantern || 0; out.moon = P.moon ? 1 : 0;
    // 천체 존재감은 시간대 이름으로 결정된다(노을빛 변주 gold/crimson/violet 공통).
    out.stars = STAR_TIME_FADE[name] ?? 0;
    out.sunDisk = SUN_DISK_TIME[name] ?? 0;
    // 달 방위 글로우 밴드 배율은 프로필이 소유한다(밤 0.31 · 그 외 미지정 = 1).
    out.sunBandScale = P.sunBandScale ?? 1;
    for (let i = 0; i < 4; i++) {
      const c = parseHexSRGB(P.sky[i][1]);
      out.stops[i].pos = P.sky[i][0]; out.stops[i].r = c.r; out.stops[i].g = c.g; out.stops[i].b = c.b;
    }
    return out;
  }
  function copyState(dst, src) {
    dst.sunDir.copy(src.sunDir); dst.sunColor.copy(src.sunColor); dst.sunInt = src.sunInt;
    dst.hemiSky.copy(src.hemiSky); dst.hemiGround.copy(src.hemiGround); dst.hemiInt = src.hemiInt;
    dst.fogColor.copy(src.fogColor); dst.fogNear = src.fogNear; dst.fogFar = src.fogFar; dst.exposure = src.exposure;
    dst.ridgeNear.copy(src.ridgeNear); dst.ridgeFar.copy(src.ridgeFar); dst.mist.copy(src.mist);
    dst.mistOp = src.mistOp; dst.autumnAmt = src.autumnAmt; dst.winterAmt = src.winterAmt;
    dst.lantern = src.lantern; dst.moon = src.moon;
    dst.stars = src.stars; dst.sunDisk = src.sunDisk;
    dst.sunBandScale = src.sunBandScale;
    for (let i = 0; i < 4; i++) {
      dst.stops[i].pos = src.stops[i].pos; dst.stops[i].r = src.stops[i].r;
      dst.stops[i].g = src.stops[i].g; dst.stops[i].b = src.stops[i].b;
    }
  }
  const _l = (a, b, k) => a + (b - a) * k;
  function lerpStateInto(out, a, b, k) {
    out.sunDir.copy(a.sunDir).lerp(b.sunDir, k).normalize();
    out.sunColor.copy(a.sunColor).lerp(b.sunColor, k); out.sunInt = _l(a.sunInt, b.sunInt, k);
    out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, k); out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, k);
    out.hemiInt = _l(a.hemiInt, b.hemiInt, k);
    out.fogColor.copy(a.fogColor).lerp(b.fogColor, k);
    out.fogNear = _l(a.fogNear, b.fogNear, k); out.fogFar = _l(a.fogFar, b.fogFar, k);
    out.exposure = _l(a.exposure, b.exposure, k);
    out.ridgeNear.copy(a.ridgeNear).lerp(b.ridgeNear, k); out.ridgeFar.copy(a.ridgeFar).lerp(b.ridgeFar, k);
    out.mist.copy(a.mist).lerp(b.mist, k);
    out.mistOp = _l(a.mistOp, b.mistOp, k); out.autumnAmt = _l(a.autumnAmt, b.autumnAmt, k);
    out.winterAmt = _l(a.winterAmt, b.winterAmt, k);
    out.lantern = _l(a.lantern, b.lantern, k); out.moon = _l(a.moon, b.moon, k);
    out.stars = _l(a.stars, b.stars, k); out.sunDisk = _l(a.sunDisk, b.sunDisk, k);
    out.sunBandScale = _l(a.sunBandScale, b.sunBandScale, k);
    for (let i = 0; i < 4; i++) {
      out.stops[i].pos = _l(a.stops[i].pos, b.stops[i].pos, k);
      out.stops[i].r = _l(a.stops[i].r, b.stops[i].r, k);
      out.stops[i].g = _l(a.stops[i].g, b.stops[i].g, k);
      out.stops[i].b = _l(a.stops[i].b, b.stops[i].b, k);
    }
  }

  // 현재 화면에 적용 중인 상태(트윈 from 스냅샷·정착값의 단일 소스).
  const cur = makeState();
  const from = makeState();
  const to = makeState();
  const tmp = makeState();      // 리타깃 시 현재 보간값 스냅샷 임시
  // 능선 합성용 재사용 색.
  const _rn = new THREE.Color(), _rf = new THREE.Color(), _rm = new THREE.Color();

  let curName = 'day';
  let curKey = atmosphereProfileKey('day', sunsetLook);
  let tw = null;                // { t, dur, name, key } (진행 중 시간대/노을빛 트윈)
  let curSeason = 'summer';
  let autumn01 = 0;             // 가을 능선 세기 0..1 (계절 트윈)
  let autumnGoal = 0;
  let winter01 = 0;
  let winterGoal = 0;

  // cur 상태를 씬에 적용한다(트윈 매 프레임·정착·스냅 공통).
  function applyCur() {
    sun.position.copy(cur.sunDir).multiplyScalar(64);
    sun.color.copy(cur.sunColor); sun.intensity = cur.sunInt;
    hemi.color.copy(cur.hemiSky); hemi.groundColor.copy(cur.hemiGround); hemi.intensity = cur.hemiInt;
    if (!scene.fog) scene.fog = new THREE.Fog(0, 1, 100);
    scene.fog.color.copy(cur.fogColor); scene.fog.near = cur.fogNear; scene.fog.far = cur.fogFar;
    if (scene.background && scene.background.isColor) scene.background.copy(cur.fogColor);
    else scene.background = cur.fogColor.clone();
    renderer.toneMappingExposure = cur.exposure;
    applyRidge();
    // 등불(트윈 중 서서히). base=플리커 기준값, bulb 페이드.
    // #73: 야간 강도 대폭 하향(구 lantern*26 → *9.5). 26 은 저고도 처마 등롱이 기복 지형을
    //   레이킹해 마당 전체에 강한 방사형 빛줄기·그림자를 냈다(호롱불이 아니라 서치라이트). 9.5
    //   면 처마 소핏에 은은한 웜 풀만 남고 마당 레이킹이 사라진다. 석양(lantern 0.15)은 1.4 로
    //   밝은 역광 씬에선 거의 감지 안 됨(무회귀).
    const lanScale = Math.min(1, Math.max(0, cur.lantern / 0.15));  // 등불 최대(석양 0.15)에서 포화
    lanterns.forEach((L) => {
      L.base = cur.lantern * 9.5;
      L.light.intensity = L.base;
      L.bulb.visible = cur.lantern > 0.02;
    });
    glowMat.opacity = Math.min(1, Math.max(0, lanScale));
    lanternNight = cur.lantern > 0.02;
    // 달: moon 세기로 페이드 + 방향은 태양(달) 방향과 정합.
    const m = cur.moon;
    moonGroup.visible = m > 0.02;
    if (m > 0.02) {
      moonDisk.material.opacity = m;
      for (const corona of coronaLayers) {
        corona.material.opacity = corona.userData.baseOpacity * m;
      }
      moonOffset.copy(cur.sunDir).multiplyScalar(DEFAULT_MOON_OPTICS.distance);
      moonGroup.position.copy(moonOffset); // deterministic fallback before first camera render
      moonGroup.updateMatrixWorld(true);
    }
    // 태양 원반(S1): 편평화·확대는 현재 보간된 태양 고도에서 산출하므로 트윈 중에도 연속이다.
    //   밤 프로필은 sunDisk 0 — 밤의 sunDir 은 달 방향을 겸하기 때문에 원반이 남으면 달이 둘이 된다.
    const sunElevDeg = elevationDegOf(cur.sunDir);
    const sunSpan = sunDiskSpan * sunDiskEnlargement(sunElevDeg);
    sunDisk.scale.set(sunSpan, sunSpan * sunDiskFlattening(sunElevDeg), 1);
    sunDisk.material.opacity = cur.sunDisk;
    // 코어는 HDR 광원이다: 선형 1.0 이면 ACES 숄더에서 밝은 노을 하늘에 묻힌다(실측 1.24×).
    _sunCore.copy(cur.sunColor).lerp(_white, SUN_CORE_WHITE).multiplyScalar(SUN_DISK.coreHdrGain);
    sunDisk.material.color.copy(_sunCore);
    sunDisk.visible = cur.sunDisk > 0.002;
    // 별(S3): 페이드는 상태 필드(크로스페이드), 반짝임 위상은 update 의 시계가 소유.
    starMat.uniforms.uFade.value = cur.stars;
    stars.visible = cur.stars > 0.002;
    // 돔 헤이즈는 시간대 base fog 로 먼저 맞춘다(모디파이어가 있으면 같은 프레임에 syncHaze 가 덮는다).
    cur.fogColor.getRGB(hazeSRGB, THREE.SRGBColorSpace);
    buildDomeFromStops(cur.stops);
  }

  // 능선 대기원근: cur(시간대 보간)의 능선색 × 가을 세기(autumn01) 합성. 매 프레임 저렴.
  function applyRidge() {
    const amt = cur.autumnAmt * autumn01;
    const winterAmt = cur.winterAmt * winter01;
    if (amt > 0.001) {
      const farAmt = Math.min(1, amt * 1.3);
      _rn.copy(cur.ridgeNear).lerp(AUTUMN_RIDGE.near, amt);
      _rf.copy(cur.ridgeFar).lerp(AUTUMN_RIDGE.far, farAmt);
      _rm.copy(cur.mist).lerp(AUTUMN_RIDGE.mist, amt * 0.7);
      if (winterAmt > 0.001) {
        _rn.lerp(WINTER_RIDGE.near, winterAmt);
        _rf.lerp(WINTER_RIDGE.far, Math.min(1, winterAmt * 1.18));
        _rm.lerp(WINTER_RIDGE.mist, winterAmt * 0.8);
      }
      mountains.setPalette(_rn, _rf, _rm, cur.mistOp);
    } else if (winterAmt > 0.001) {
      _rn.copy(cur.ridgeNear).lerp(WINTER_RIDGE.near, winterAmt);
      _rf.copy(cur.ridgeFar).lerp(WINTER_RIDGE.far, Math.min(1, winterAmt * 1.18));
      _rm.copy(cur.mist).lerp(WINTER_RIDGE.mist, winterAmt * 0.8);
      mountains.setPalette(_rn, _rf, _rm, cur.mistOp);
    } else {
      mountains.setPalette(cur.ridgeNear, cur.ridgeFar, cur.mist, cur.mistOp);
    }
  }

  // 시간대 적용. opts.immediate=true(shot·초기 로드) 면 즉시 스냅, 아니면 크로스페이드.
  //   같은 상태로의 재적용(reapplyEnvBase 등)은 스냅(멱등 복구) — 날씨가 만진 fog 를 되돌린다.
  function apply(name, opts = {}) {
    if (!(name in TIME_PRESETS)) name = 'day';
    const key = atmosphereProfileKey(name, sunsetLook);
    if (opts.immediate) {
      resolveInto(cur, name); curName = name; curKey = key; tw = null;
      applyCur();
      return;
    }
    if (tw) {
      if (key === tw.key) return;                   // 진행 중인 동일 프로필 목표 → 계속
      copyState(from, cur);                          // 현재 보간값을 새 from 으로(리타깃)
      resolveInto(to, name);
      tw = { t: 0, dur: DUR_TIME, name, key };
      return;
    }
    resolveInto(to, name);
    if (key === curKey) {                            // 정착 상태에서 같은 프로필 재적용 → 스냅 복구
      copyState(cur, to); applyCur(); return;
    }
    copyState(from, cur);
    tw = { t: 0, dur: DUR_TIME, name, key };
  }

  function setSunsetLook(name, opts = {}) {
    const next = normalizeSunsetLook(name);
    if (next === sunsetLook && curName !== 'sunset' && tw?.name !== 'sunset') return next;
    sunsetLook = next;
    if (curName === 'sunset' || tw?.name === 'sunset') apply('sunset', opts);
    return sunsetLook;
  }

  // 매 프레임: 시간대 트윈 + 가을 능선 트윈 진행. env.update 에서 호출.
  function update(dt) {
    // 별 반짝임: 별이 보일 때만 도는 미세 변조 시계. shot 모드는 t=0 고정(캡처 재현성).
    if (!SHOT && cur.stars > 0.002) {
      starClock += dt;
      starMat.uniforms.uTime.value = starClock;
    }
    let moved = false;
    if (tw) {
      tw.t += dt;
      const k = easeInOut(tw.t / tw.dur);
      lerpStateInto(cur, from, to, k);
      applyCur();
      moved = true;
      if (tw.t >= tw.dur) { copyState(cur, to); curName = tw.name; curKey = tw.key; tw = null; }
    }
    // 가을 능선 세기(지수 접근). 시간대 트윈이 없을 때도 능선만 갱신.
    if (Math.abs(autumn01 - autumnGoal) > 1e-4) {
      autumn01 += (autumnGoal - autumn01) * Math.min(1, dt * SEASON_RATE);
      if (Math.abs(autumn01 - autumnGoal) <= 1e-4) autumn01 = autumnGoal;
      if (!moved) applyRidge();
    }
    if (Math.abs(winter01 - winterGoal) > 1e-4) {
      winter01 += (winterGoal - winter01) * Math.min(1, dt * SEASON_RATE);
      if (Math.abs(winter01 - winterGoal) <= 1e-4) winter01 = winterGoal;
      if (!moved) applyRidge();
    }
  }

  // 처마 등롱 촛불 일렁임 — env.update 경유(매 프레임). 등불이 켜져 있을 때만 변조.
  function updateFlicker(dt) {
    if (!lanternNight) return;
    flickT += dt;
    lanterns.forEach((L, i) => {
      if (L.base > 0) L.light.intensity = L.base * candleFlicker(flickT, 5.5 + i * 1.9);
    });
  }

  // 계절 설정: 가을 능선 훅. immediate 면 즉시, 아니면 SEASON_RATE 로 크로스페이드(update 진행).
  function setSeason(name, opts = {}) {
    curSeason = name;
    autumnGoal = name === 'autumn' ? 1 : 0;
    winterGoal = name === 'winter' ? 1 : 0;
    if (opts.immediate) { autumn01 = autumnGoal; winter01 = winterGoal; applyRidge(); }
  }

  // env fog 합성용: 현재 시간대 base fog(트윈 보간값). 모디파이어 적용 전 원본.
  function getBaseFog() { return { color: cur.fogColor, near: cur.fogNear, far: cur.fogFar }; }
  function isTweening() { return !!tw; }

  function setEnabled(value) { skyRoot.visible = !!value; }

  // #53 R3 검증 훅: 돔의 두 가산항(달 방위 SUN_BAND · 은하수)을 같은 부팅·같은 카메라에서
  //   원자로 분리한다. 배율만 곱하고 제품 산술을 그대로 재실행하므로, 미러 구현이 아니라
  //   제품 픽셀을 잰다. restore() 로 프로필 값 복귀.
  let skyDebug = null;
  if (typeof window !== 'undefined') {
    skyDebug = {
      get sunBandScale() { return cur.sunBandScale * dbgSunBandScale; },
      get milkyWayScale() { return dbgMilkyWayScale; },
      setSunBand: (v) => {
        dbgSunBandScale = Math.max(0, Number(v) || 0);
        buildDomeFromStops(cur.stops);
        return cur.sunBandScale * dbgSunBandScale;
      },
      setMilkyWay: (v) => {
        dbgMilkyWayScale = Math.max(0, Number(v) || 0);
        buildDomeFromStops(cur.stops);
        return dbgMilkyWayScale;
      },
      restore: () => {
        dbgSunBandScale = 1; dbgMilkyWayScale = 1;
        buildDomeFromStops(cur.stops);
      },
    };
    window.__sky = skyDebug;
  }

  function dispose() {
    if (typeof window !== 'undefined' && window.__sky === skyDebug) delete window.__sky;
    scene.remove(skyRoot);
    // three 의 Sprite 는 모든 인스턴스가 모듈 전역 지오메트리 하나를 공유한다
    //   (three/src/objects/Sprite.js `_geometry`). environment 트리의 연기 스프라이트 풀이 이미
    //   그 지오를 소유·해제하므로, 태양 원반을 트리 워크에 남기면 같은 지오가 두 번 dispose 된다.
    //   post.js 의 sunGlow 와 같은 계약으로 자기 재질·텍스처만 해제한다.
    skyRoot.remove(sunDisk);
    sunDisk.material.dispose();
    sunDiskTexture.dispose();
    disposeObjectTree(skyRoot);
    skyRoot.clear();
  }

  return {
    apply, setSunsetLook, setSeason, update, updateFlicker, getBaseFog, isTweening, syncHaze,
    setEnabled, dispose, root: skyRoot, dome, lanterns,
    // 검증 하네스용 핸들(제품 코드는 상태기계만 쓴다).
    sunDisk, stars, moonDisk, starCount: starField.count,
    get sunsetLook() { return sunsetLook; },
  };
}
