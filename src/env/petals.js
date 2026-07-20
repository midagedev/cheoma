import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { makeRng } from '../rng.js';

// 계절 입자 필드(태스크 #111) — 봄 벚꽃 꽃잎 · 가을 낙엽의 "카메라 추종 볼륨".
//
// 배경: 기존 계절 낙엽/꽃잎(env/seasons.js seasonLeaves)은 나무 수관에서 방출돼 env 원점(≈마을
//   중심)에 고정된다. 마을 focus 근경(원점에서 벗어난 집)에선 나무가 화면 밖이라 낙엽/꽃잎이
//   안 보였다("가을만큼 봄의 흩날리는 벚꽃이 백미인데" 사용자 피드백). 이 모듈은 눈·비와 동일한
//   "카메라 타깃을 따라오는 낙하 볼륨"을 계절 입자로 만들어, 보는 곳 어디서나 꽃잎·낙엽이 흩날리게
//   한다. seasons.js 원점 방출분과 공존(마을 중심 근경에선 둘 다, 원점 밖 focus 근경에선 이 필드만).
//
// 소유·구동: 이 필드는 weather.js 가 소유해 scene 루트에 붙이고(눈·비처럼 env.group 은닉을 우회 →
//   마을에서도 보임), 매 프레임 setWeatherCenter 로 카메라 타깃에 이설한다. season 은 weather 가
//   setSeason 으로 전달(env.setSeason → window.__wx.setSeason 브릿지). present(조기노출 게이트)·
//   camDist(고도 게이트)도 weather 가 판정해 넘긴다.
//
// 눈과의 차이(팔랑거림): 눈은 거의 수직 낙하 + 미세 흔들림. 꽃잎/낙엽은 (1) 훨씬 느린 부유 낙하,
//   (2) 개별 위상·진폭의 큰 좌우 플러터(사인 합성 → 변위 시계열 비단조), (3) 스프라이트 개별 회전
//   (프래그먼트에서 gl_PointCoord 회전). 낙엽은 꽃잎보다 크고 회전이 격해 "구르듯" 떨어진다.

const TAU = Math.PI * 2;
const FIELD_SEED = 0x9e7a1;

// 계절별 팔레트·형상·물성. 봄=분홍~흰 둥근 꽃잎(느리고 가벼움), 가을=주홍·주황·황·갈 뾰족한 잎(구름).
const SEASON_CFG = {
  spring: {
    colors: [0xffe3ec, 0xffd0dd, 0xf9b8cc, 0xfff2f6, 0xf6c6d7, 0xffdce6],
    shape: 0.0,           // 0=둥근 꽃잎
    size: [1.3, 2.8],     // 스프라이트 픽셀 기준(uScale 로 원근 보정). #116 근접 과대(손바닥) 톤다운.
    fall: [0.75, 1.7],    // 낙하 속도(부유감 — 눈 2.4~6.0 보다 훨씬 느림)
    flutter: [1.3, 2.9],  // 좌우 팔랑 진폭
    freq: [0.5, 1.25],    // 팔랑 주파수(rad/s)
    rot: [0.5, 1.7],      // 스프라이트 회전 속도
    windCarry: 3.2,
  },
  autumn: {
    colors: [0xc7452a, 0xd8792a, 0xd9a531, 0xb85a26, 0xa8662e, 0xcf8b3a, 0xbf5a2b],
    shape: 1.0,           // 1=뾰족한 잎
    size: [1.9, 4.0],     // #116 근접 과대 톤다운(잎은 꽃잎보다 크게 유지)
    fall: [1.2, 2.6],     // 낙엽은 꽃잎보다 조금 빠르되 여전히 느림
    flutter: [1.6, 3.3],
    freq: [0.45, 1.15],
    rot: [1.1, 3.2],      // 구르듯 격한 회전
    windCarry: 4.0,
  },
};

// 고도 게이트: 꽃잎·낙엽은 근경·focus 에서만 의미(부감에선 능선 틴트·마당 단풍이 무드 담당, #98 규약).
//   정밀 신호는 카메라 높이(camY>46 OFF, adapter seasonLeaves 게이트와 정합). weather 가 camY 를
//   넘겨주지 못하는 경로(현행 engine 은 camDist 만 전달)에선 camDist 프록시로 대체한다.
//   camY=46 은 부감 앙각(31°)에서 camDist≈77 에 대응 → 프록시 66→88 로 근사(focus<60 전량, 부감>88 소거).
function altGateFrom(camDist, camY) {
  if (camY != null && Number.isFinite(camY)) return 1 - smoothstep(40, 52, camY);
  if (Number.isFinite(camDist)) return 1 - smoothstep(66, 88, camDist);
  return 1; // 신호 없음(env 단독 하네스·단일건물 초기) → 근경 취급(ON)
}


// 잎 실루엣 절차 생성(#116) — "낙엽을 낙엽답게": 원형 점이 아니라 은행잎(부채꼴)·단풍잎(손바닥)
//   형태를 흰 알파로 그린다(색은 aColor 로 곱함). 셀 중심(32,32), 위=−y. kind 0=벚꽃 꽃잎·1=은행·2=단풍.
//   회전은 프래그에서 gl_PointCoord 를 vRot 로 돌려 적용하므로, 잎을 셀 안쪽(반경≤24)에 그려
//   회전 시 모서리가 인접 픽셀을 건드리지 않게 여백을 남긴다.
function drawLeafShape(g, kind) {
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
  if (kind === 0) {                       // 벚꽃 꽃잎(둥근 타원 + 끝 파임)
    g.beginPath();
    g.moveTo(0, 21);
    g.bezierCurveTo(15, 13, 14, -13, 3, -19);
    g.quadraticCurveTo(0, -15, -3, -19);
    g.bezierCurveTo(-14, -13, -15, 13, 0, 21);
    g.fill();
  } else if (kind === 1) {                 // 은행잎(부채꼴 + 중앙 결각 + 잎자루)
    g.beginPath();
    g.moveTo(0, 20);
    g.quadraticCurveTo(-17, 12, -22, -9);
    g.quadraticCurveTo(-13, -19, -4, -11);
    g.quadraticCurveTo(0, -8, 4, -11);
    g.quadraticCurveTo(13, -19, 22, -9);
    g.quadraticCurveTo(17, 12, 0, 20);
    g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 18); g.lineTo(0, 29); g.stroke();
  } else {                                 // 단풍잎(5갈래 손바닥 + 잎자루)
    const tips = [0, 65, 135, 225, 295];
    const R = 23;
    g.beginPath();
    for (let i = 0; i < tips.length; i++) {
      const a = tips[i] * Math.PI / 180;
      const x = Math.sin(a) * R, y = -Math.cos(a) * R;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      const n = tips[(i + 1) % tips.length];
      const mid = (tips[i] + (n > tips[i] ? n : n + 360)) / 2;
      const bottom = Math.abs(((mid % 360) + 360) % 360 - 180) < 20;
      const rv = bottom ? 5 : 10;
      const av = mid * Math.PI / 180;
      g.lineTo(Math.sin(av) * rv, -Math.cos(av) * rv);
    }
    g.closePath(); g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 6); g.lineTo(0, 30); g.stroke();
  }
}

function makeLeafTex(kind) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d'); g.clearRect(0, 0, 64, 64);
  g.save(); g.translate(32, 32); drawLeafShape(g, kind); g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 가을 잎 종별 팔레트: 은행=순수 황금, 단풍=진홍~주황(#116).
const GINKGO_COLS = [0xf2c53d, 0xf0b429, 0xe8b21f, 0xf5ce4a];
const MAPLE_COLS = [0xc0392b, 0xd35400, 0xe0491f, 0xb83a1e, 0xd9622b];

// createPetalField({ getWind, lowPerf }) →
//   { points, setSeason(name), update(dt, {t, camDist, camY, present, wind}), get level, get count, get season, aabb(), dispose() }
export function createPetalField({ getWind, lowPerf = false } = {}) {
  // #125 대폭 감축(사용자: "색종이 축제 아니라 바람에 이따금 지는 잎"). 기존 1200 → 460. 실제 동시
  //   가시 수는 아래 돌풍 게이트(uActive)가 더 조인다 — 잔잔할 땐 한 자릿수~십수 장, 돌풍에 잠깐 늘었다
  //   잦아든다. per-frame 갱신 루프도 N 감축분만큼 저비용(성능 우선).
  const N = lowPerf ? 220 : 460;
  const half = 44;             // 수평 반경(카메라 타깃 주변 볼륨) — 눈 볼륨(46)과 유사
  const yBottom = -1.0;
  const yTop = 40.0;
  const H = yTop - yBottom;

  const rng = makeRng(FIELD_SEED);

  // 위치·물성 버퍼(계절 무관 궤적 파라미터는 고정, 색/형상/속도만 setSeason 으로 갱신)
  const pos = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aColor = new Float32Array(N * 3);
  const aRot = new Float32Array(N);      // 회전 위상(초기)
  const aRotSpd = new Float32Array(N);   // 회전 속도
  const aOpacity = new Float32Array(N);
  const aSpecies = new Float32Array(N);  // 잎 종(0=꽃잎,1=은행,2=단풍) — setSeason 에서 배정
  const aThresh = new Float32Array(N);   // #125 돌풍 게이트 임계값(개체별) — uActive 가 이걸 넘어야 보임

  // CPU 궤적 상태(월드 로컬 — points.position 이 카메라 타깃으로 이설)
  const bx = new Float32Array(N), bz = new Float32Array(N), py = new Float32Array(N);
  const phase = new Float32Array(N);     // 팔랑 위상
  const fAmp = new Float32Array(N);      // 팔랑 진폭
  const fFreq = new Float32Array(N);     // 팔랑 주파수
  const fall = new Float32Array(N);      // 낙하 속도

  for (let i = 0; i < N; i++) {
    bx[i] = (rng() * 2 - 1) * half;
    bz[i] = (rng() * 2 - 1) * half;
    py[i] = yBottom + rng() * H;
    phase[i] = rng() * TAU;
    aRot[i] = rng() * TAU;
    aOpacity[i] = rng.range(0.7, 1.0);
    aThresh[i] = rng();
    pos[i * 3] = bx[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = bz[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geo.setAttribute('aRot', new THREE.BufferAttribute(aRot, 1));
  geo.setAttribute('aRotSpd', new THREE.BufferAttribute(aRotSpd, 1));
  geo.setAttribute('aOpacity', new THREE.BufferAttribute(aOpacity, 1));
  geo.setAttribute('aSpecies', new THREE.BufferAttribute(aSpecies, 1));
  geo.setAttribute('aThresh', new THREE.BufferAttribute(aThresh, 1));

  const texPetal = makeLeafTex(0), texGinkgo = makeLeafTex(1), texMaple = makeLeafTex(2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uScale: { value: 180 },   // #125 근경 과대 재조정(260→180) — 사람 스케일 대비 자연스러운 꽃잎·낙엽
      uTime: { value: 0 },
      uMaxPx: { value: 15.0 }, // #125 스프라이트 상한(px) 26→15 — 근경/1인칭 "손바닥만한" 잎 방지(사용자 피드백)
      uActive: { value: 0 },    // #125 돌풍 게이트(0..1) — 개체별 aThresh 를 넘긴 잎만 보임(간헐 리듬)
      uTexPetal: { value: texPetal },   // 잎 실루엣 텍스처(종별) — 회전은 프래그에서 gl_PointCoord 로.
      uTexGinkgo: { value: texGinkgo },
      uTexMaple: { value: texMaple },
    },
    transparent: true, depthWrite: false,
    vertexShader: `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aRot;
      attribute float aRotSpd;
      attribute float aOpacity;
      attribute float aSpecies;
      attribute float aThresh;
      uniform float uScale;
      uniform float uTime;
      uniform float uMaxPx;
      uniform float uActive;
      varying vec3 vCol;
      varying float vRot;
      varying float vOp;
      varying float vSpecies;
      varying float vGust;
      void main() {
        vCol = aColor;
        vOp = aOpacity;
        vSpecies = aSpecies;
        // #125 돌풍 게이트: uActive 가 개체 임계(aThresh)를 넘어야 서서히 나타남 → 잔잔할 땐 드물게,
        //   돌풍에 잠깐 늘었다 잦아든다("바람에 이따금 지는 잎").
        vGust = smoothstep(aThresh - 0.16, aThresh + 0.04, uActive);
        vRot = aRot + uTime * aRotSpd;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(aSize * (uScale / max(-mv.z, 1.0)), uMaxPx);
      }`,
    fragmentShader: `
      uniform float uFade;
      uniform sampler2D uTexPetal;
      uniform sampler2D uTexGinkgo;
      uniform sampler2D uTexMaple;
      varying vec3 vCol;
      varying float vRot;
      varying float vOp;
      varying float vSpecies;
      varying float vGust;
      void main() {
        // gl_PointCoord 를 vRot 로 회전 → 잎 실루엣 텍스처를 종별로 샘플(떨어지며 팔랑·구르는 잎).
        vec2 uv = gl_PointCoord - 0.5;
        float c = cos(vRot), s = sin(vRot);
        vec2 cell = mat2(c, -s, s, c) * uv + 0.5;
        vec4 tx = (vSpecies < 0.5) ? texture2D(uTexPetal, cell)
                : (vSpecies < 1.5) ? texture2D(uTexGinkgo, cell)
                                   : texture2D(uTexMaple, cell);
        float a = tx.a * vOp * uFade * vGust;
        if (a < 0.02) discard;
        gl_FragColor = vec4(vCol, a);
      }`,
  });

  const points = new THREE.Points(geo, mat);
  points.name = 'seasonPetals';
  points.frustumCulled = false;   // 카메라 타깃으로 이설되므로 컬링 부적합(눈·비와 동일)
  points.renderOrder = 18;        // 눈(20)·비(21) 아래(대기 입자 레이어)
  points.visible = false;

  let season = 'summer';          // 'spring'|'autumn' 이면 활성, 그 외 OFF
  let level = 0;                  // 현재 유효 강도(season*present*altGate)
  let activeSmooth = 0;           // #125 돌풍 게이트 평활값(간헐 리듬)
  const tmpColor = new THREE.Color();

  // 계절별 색/형상/속도/회전 재생성(결정론 — 같은 계절이면 같은 배치). 궤적 위상/기저 좌표는 불변.
  function setSeason(name) {
    const active = name === 'spring' || name === 'autumn';
    season = name;
    if (!active) { points.visible = false; level = 0; return; }
    const cfg = SEASON_CFG[name];
    const autumn = name === 'autumn';
    const cr = makeRng(FIELD_SEED ^ (name === 'spring' ? 0x5091 : 0xa07a));
    for (let i = 0; i < N; i++) {
      // 가을=은행(황금)·단풍(주홍~주황) 개체별 배정, 봄=벚꽃 꽃잎(분홍). 실루엣은 aSpecies 로 종별 텍스처.
      let hex, species;
      if (autumn) {
        const isGinkgo = cr() < 0.5;
        species = isGinkgo ? 1 : 2;
        hex = cr.pick(isGinkgo ? GINKGO_COLS : MAPLE_COLS);
      } else {
        species = 0;
        hex = cr.pick(cfg.colors);
      }
      tmpColor.setHex(hex);
      aColor[i * 3] = tmpColor.r; aColor[i * 3 + 1] = tmpColor.g; aColor[i * 3 + 2] = tmpColor.b;
      aSpecies[i] = species;
      aSize[i] = cr.range(cfg.size[0], cfg.size[1]);
      aRotSpd[i] = cr.range(cfg.rot[0], cfg.rot[1]) * (cr() < 0.5 ? -1 : 1);
      fall[i] = cr.range(cfg.fall[0], cfg.fall[1]);
      fAmp[i] = cr.range(cfg.flutter[0], cfg.flutter[1]);
      fFreq[i] = cr.range(cfg.freq[0], cfg.freq[1]);
    }
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotSpd.needsUpdate = true;
    geo.attributes.aSpecies.needsUpdate = true;
  }

  const posAttr = geo.attributes.position;

  // update(dt, { t, camDist, camY, present, wind })
  //   t: 누적 시간(회전·팔랑 위상), present: 조기노출 게이트(0..1, weather 판정),
  //   camDist/camY: 고도 게이트 신호, wind: getWind(t) 결과(공유 바람).
  function update(dt, { t = 0, camDist = NaN, camY = null, present = 1, wind = null } = {}) {
    const active = season === 'spring' || season === 'autumn';
    const alt = altGateFrom(camDist, camY);
    level = active ? Math.max(0, Math.min(1, present)) * alt : 0;
    mat.uniforms.uFade.value = level;
    mat.uniforms.uTime.value = t;
    points.visible = level > 0.002;
    if (!points.visible) return;   // 비가시면 CPU 궤적 갱신 생략(성능)

    const cfg = SEASON_CFG[season];
    const w = wind || (getWind ? getWind(t) : { dirX: 1, dirZ: 0, speed: 0.2, gust: 0 });
    // #125 돌풍 게이트: 계절 기저(봄=꽃보라로 조금 더 풍성, 가을=희소) + 돌풍 가산, 완만 평활
    //   → "잠깐 늘었다 잦아드는" 리듬(기존 바람 필드 gust 재사용). 잔잔할 땐 한 자릿수~십수 장만 보임.
    const gustBase = season === 'spring' ? 0.34 : 0.12;
    const gustTarget = Math.min(1, gustBase + (w.gust || 0) * 0.85);
    activeSmooth += (gustTarget - activeSmooth) * Math.min(1, dt * 1.4);
    mat.uniforms.uActive.value = activeSmooth;
    const wx = w.dirX * w.speed, wz = w.dirZ * w.speed;
    const carry = cfg.windCarry;
    const swirl = 1.0 + w.gust * 1.8;   // 돌풍에 팔랑이 격해진다
    const arr = posAttr.array;
    for (let i = 0; i < N; i++) {
      // 낙하(단조 감소) — 부유감
      py[i] -= fall[i] * dt;
      // 기저 좌표를 바람에 실어 나르고 박스 내 랩(순환)
      bx[i] += wx * carry * dt;
      bz[i] += wz * carry * dt;
      if (bx[i] > half) bx[i] -= 2 * half; else if (bx[i] < -half) bx[i] += 2 * half;
      if (bz[i] > half) bz[i] -= 2 * half; else if (bz[i] < -half) bz[i] += 2 * half;
      if (py[i] < yBottom) py[i] += H;   // 바닥 도달 시 상단 재순환
      // 팔랑(비단조 좌우 변위 — 사인 합성). x 는 강한 1차 + 약한 2차, z 는 위상차 코사인.
      const ph = phase[i];
      arr[i * 3] = bx[i]
        + Math.sin(t * fFreq[i] + ph) * fAmp[i] * swirl
        + Math.sin(t * fFreq[i] * 2.3 + ph * 1.7) * fAmp[i] * 0.35;
      arr[i * 3 + 1] = py[i];
      arr[i * 3 + 2] = bz[i]
        + Math.cos(t * fFreq[i] * 0.85 + ph) * fAmp[i] * 0.8 * swirl;
    }
    posAttr.needsUpdate = true;
  }

  function aabb() {
    const box = new THREE.Box3().setFromBufferAttribute(posAttr);
    box.translate(points.position);   // 카메라 이설분 반영(월드 AABB)
    return box;
  }

  function dispose() {
    geo.dispose();
    mat.dispose();
    texPetal.dispose(); texGinkgo.dispose(); texMaple.dispose();
  }

  return {
    points, setSeason, update, aabb, dispose,
    get level() { return level; },
    get count() { return level > 0.01 ? N : 0; },
    get season() { return season; },
  };
}
