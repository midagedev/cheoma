import * as THREE from 'three';
import { candleFlicker } from './night-glow.js';

// 달무리(halo) 텍스처: 중심 흰빛 → 가장자리 투명 방사 그라디언트.
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.5)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 시간대 프리셋. dir=태양(달) 방향, 색·강도, 반구광, 안개, 하늘 그라디언트,
// 능선 대기원근 색, 노출, 등불.
// 주의: 모든 프리셋의 sky 그라디언트는 정확히 4스톱(하단→상단)이라 시간대 간 스톱 위치·색을
//   1:1 보간할 수 있다(트윈). 스톱 수를 바꾸면 트윈 로직(lerpStops)이 깨진다.
export const TIME_PRESETS = {
  dawn: {
    sky: [[0.0, '#e7d0b8'], [0.35, '#d9c3bb'], [0.7, '#8f9bbf'], [1.0, '#5d6a97']],
    sunDir: [26, 9, 34], sunColor: 0xffd7ac, sunInt: 1.7,
    hemiSky: 0xc3bcd0, hemiGround: 0x6f6252, hemiInt: 0.75,
    fog: 0xe4cfbd, fogNear: 55, fogFar: 430, exposure: 1.02,
    ridgeNear: 0x4a5069, ridgeFar: 0xcfc1c4, mist: 0xf1e2d4, mistOp: 0.72,
    lantern: 0.0,
  },
  day: {
    sky: [[0.0, '#d3dfe8'], [0.4, '#a9c4de'], [0.75, '#7ba6d6'], [1.0, '#5f8fca']],
    sunDir: [30, 42, 26], sunColor: 0xfff3e0, sunInt: 2.6,
    hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.9,
    fog: 0xcfdde8, fogNear: 95, fogFar: 500, exposure: 1.05,
    ridgeNear: 0x445f6d, ridgeFar: 0xbdd0dc, mist: 0xeef4f8, mistOp: 0.6,
    lantern: 0.0,
  },
  sunset: {
    // 태양 방위를 기본 카메라(three-quarter az≈38, front az=0) '뒤'로 배치해 역광 기본뷰를
    // 만든다: 저고도 alt≈9.5° → 건물 실루엣+금빛 림.
    // R4 색분리: 중간 밴드에 뚜렷한 마젠타/모브 존을 넣어 하늘 그라디언트를 주황-단색이 아니라
    // 주황(하단)→분홍모브(중단)→쪽빛(상단) 3색으로 — hue 히스토그램에 청·자 피크가 생긴다.
    sky: [[0.0, '#f3b877'], [0.26, '#e8a074'], [0.55, '#a87e97'], [1.0, '#45598c']],
    // R3 정정2(그림자 평행): 태양은 무한원 → 물리 그림자는 원래 평행이고, 방사형은 태양이
    // 안티-카메라축과 거의 일치할 때 안티솔라 포인트가 화면에 맺혀 생기는 원근 수렴(지각)이다.
    // 방위를 tq/front 안티-카메라축(각각 az≈218/180)의 정중앙인 az≈200°에 두면 두 뷰 모두
    // 약 19° 비껴 그림자가 부채꼴 없이 대각으로 흐르고, 둘 다 강한 역광(dot≈0.84)으로 유지된다.
    // R4 색온도: 순주황(0xff9d52)은 직사면(지붕·수목 양지쪽)을 갈색으로 죽인다 → 적기를 살짝
    // 빼 금빛(0xffa85c)으로. 태양색은 유일하게 웜을 유지하는 축(스플릿의 웜 쪽).
    sunDir: [-16, 8, -45], sunColor: 0xffa85c, sunInt: 2.3,
    // R4 스플릿 토닝(핵심): 뭉갬의 근인은 hemiSky(위에서 오는 앰비언트)까지 웜 브라운이라
    // 그늘·수목 음지쪽·단청 뇌록이 전부 갈색으로 붙는 것. hemiSky 를 황혼 하늘색(쿨 페리윙클)로
    // 바꾸면 그늘이 시원해져 웜 직사광과 보색 대비 → 음지쪽 녹색은 쿨 그린으로, 뇌록은 청록으로
    // 살아남는다. hemiGround(아래 바운스)는 웜 유지하되 채도를 낮춰(0xa86a3c→0x9c7856) 처마밑
    // 소핏을 과하게 주황으로 물들이지 않게 — "위는 쿨/아래는 웜" 이 골든아워 색분리의 골격.
    // 그늘진 전면의 타깃 리프트는 main.js 안티솔라 웜 필이 맡는다(분담).
    hemiSky: 0x8593bd, hemiGround: 0x9c7856, hemiInt: 0.72,
    // R4 채도 억제: fog·mist 가 과채도 주황이면 원경~중경이 전부 주황 필터로 먹힌다. 명도는
    // 유지하고 채도만 낮춘 더스티 로즈-토프로 — 중간톤이 살아나 수목·능선 색이 구분된다.
    fog: 0xc4a48e, fogNear: 70, fogFar: 470, exposure: 1.11,
    ridgeNear: 0x574863, ridgeFar: 0xc2a284, mist: 0xd8c0ad, mistOp: 0.6,
    lantern: 0.15,
  },
  night: {
    // 달밤 짙은 청람. 지면에 긴 푸른 그림자가 읽히도록 달빛(sun)을 저고도·강도 상향.
    sky: [[0.0, '#2b3a58'], [0.4, '#1c2a48'], [0.75, '#141d33'], [1.0, '#0c1220']],
    sunDir: [-7, 5, -32], sunColor: 0x9fb4d9, sunInt: 0.9,
    hemiSky: 0x33405e, hemiGround: 0x161c28, hemiInt: 0.3,
    fog: 0x1a2740, fogNear: 60, fogFar: 400, exposure: 1.16,
    ridgeNear: 0x222d48, ridgeFar: 0x445270, mist: 0x53628a, mistOp: 0.46,
    lantern: 1.0, moon: true,
  },
};

// 가을 능선 훅: season=autumn 일 때 원경 능선·안개를 단풍든 산자락 색조로 살짝 물들인다.
// 낮엔 분명히(따뜻한 산), 석양엔 이미 따뜻하니 약하게, 밤엔 거의 무채색으로 가라앉힌다.
// 값은 setPalette 와 같은 공간(THREE.Color(hex) 직접) — sRGB 디코드 없이 대기원근 색과 섞인다.
const AUTUMN_RIDGE = {
  near: new THREE.Color(0x8a6440),   // 가까운 능선: 단풍든 숲(대기감쇠로 채도 낮음)
  far: new THREE.Color(0xceac78),    // 원경: 따뜻한 haze (옅은 청색 능선을 상쇄해 회색화 방지)
  mist: new THREE.Color(0xead2ab),   // 능선 사이 안개도 살짝 온기
};
const AUTUMN_RIDGE_AMT = { dawn: 0.16, day: 0.36, sunset: 0.12, night: 0.04 };

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
  // 하늘 돔: 큰 구, 안쪽면, fog 미적용(하늘 자체). 텍스처는 재사용(트윈 중 매 프레임 재그림).
  const domeGeo = new THREE.SphereGeometry(720, 32, 20);
  const domeCanvas = document.createElement('canvas');
  domeCanvas.width = 4; domeCanvas.height = 256;
  const domeCtx = domeCanvas.getContext('2d');
  const domeTex = new THREE.CanvasTexture(domeCanvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  const domeMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false, map: domeTex });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.renderOrder = -100;
  group.add(dome);

  // 스톱 배열({pos, r,g,b})로 돔 캔버스를 다시 그린다(텍스처 재사용).
  function buildDomeFromStops(stops) {
    const grad = domeCtx.createLinearGradient(0, 0, 0, 256);
    for (const s of stops) {
      const R = Math.round(s.r * 255), G = Math.round(s.g * 255), B = Math.round(s.b * 255);
      grad.addColorStop(1 - s.pos, `rgb(${R},${G},${B})`);
    }
    domeCtx.fillStyle = grad;
    domeCtx.fillRect(0, 0, 4, 256);
    domeTex.needsUpdate = true;
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

  // 달 + 달무리 (야간). env group 자식 → env ON/OFF 가시성에 함께 묶인다.
  const moonGroup = new THREE.Group();
  moonGroup.name = 'moon';
  moonGroup.renderOrder = -50;
  const moonDisk = new THREE.Mesh(
    new THREE.SphereGeometry(11, 24, 16),
    // 트윈 페이드용 반투명(정착 야간 opacity=1 == 기존 불투명 룩).
    new THREE.MeshBasicMaterial({ color: 0xf4efda, fog: false, depthWrite: false, transparent: true, opacity: 1 })
  );
  moonGroup.add(moonDisk);
  const haloTex = makeGlowTexture();
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(72, 72),
    new THREE.MeshBasicMaterial({
      map: haloTex, color: 0xccd6ec, transparent: true, opacity: 0.55,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    })
  );
  halo.renderOrder = -51;
  moonGroup.add(halo);
  moonGroup.visible = false;
  group.add(moonGroup);

  // ── 상태(State) 표현 ──────────────────────────────────────────────────────
  // 보간 가능한 모든 시간대 필드를 한 객체로. 색은 setHex(sRGB→선형) 디코드된 THREE.Color 로
  // 저장해 선형에서 lerp 후 copy 로 적용 → 정착값은 기존 setHex 경로와 동일하다.
  function makeState() {
    return {
      sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunInt: 0,
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiInt: 0,
      fogColor: new THREE.Color(), fogNear: 0, fogFar: 0, exposure: 1,
      ridgeNear: new THREE.Color(), ridgeFar: new THREE.Color(), mist: new THREE.Color(),
      mistOp: 0, autumnAmt: 0, lantern: 0, moon: 0,
      stops: [0, 1, 2, 3].map(() => ({ pos: 0, r: 0, g: 0, b: 0 })),
    };
  }
  function resolveInto(out, name) {
    const P = TIME_PRESETS[name] || TIME_PRESETS.day;
    out.sunDir.set(P.sunDir[0], P.sunDir[1], P.sunDir[2]).normalize();
    out.sunColor.setHex(P.sunColor); out.sunInt = P.sunInt;
    out.hemiSky.setHex(P.hemiSky); out.hemiGround.setHex(P.hemiGround); out.hemiInt = P.hemiInt;
    out.fogColor.setHex(P.fog); out.fogNear = P.fogNear; out.fogFar = P.fogFar; out.exposure = P.exposure;
    out.ridgeNear.setHex(P.ridgeNear); out.ridgeFar.setHex(P.ridgeFar); out.mist.setHex(P.mist);
    out.mistOp = P.mistOp; out.autumnAmt = AUTUMN_RIDGE_AMT[name] ?? 0.3;
    out.lantern = P.lantern || 0; out.moon = P.moon ? 1 : 0;
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
    dst.mistOp = src.mistOp; dst.autumnAmt = src.autumnAmt; dst.lantern = src.lantern; dst.moon = src.moon;
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
    out.lantern = _l(a.lantern, b.lantern, k); out.moon = _l(a.moon, b.moon, k);
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
  let tw = null;                // { t, dur, name } (진행 중 시간대 트윈)
  let curSeason = 'summer';
  let autumn01 = 0;             // 가을 능선 세기 0..1 (계절 트윈)
  let autumnGoal = 0;

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
      halo.material.opacity = 0.55 * m;
      const dir = tmp.sunDir.copy(cur.sunDir).multiplyScalar(460);
      moonGroup.position.copy(dir);
      moonGroup.updateMatrixWorld();
      halo.lookAt(0, 0, 0);
    }
    buildDomeFromStops(cur.stops);
  }

  // 능선 대기원근: cur(시간대 보간)의 능선색 × 가을 세기(autumn01) 합성. 매 프레임 저렴.
  function applyRidge() {
    const amt = cur.autumnAmt * autumn01;
    if (amt > 0.001) {
      const farAmt = Math.min(1, amt * 1.3);
      _rn.copy(cur.ridgeNear).lerp(AUTUMN_RIDGE.near, amt);
      _rf.copy(cur.ridgeFar).lerp(AUTUMN_RIDGE.far, farAmt);
      _rm.copy(cur.mist).lerp(AUTUMN_RIDGE.mist, amt * 0.7);
      mountains.setPalette(_rn, _rf, _rm, cur.mistOp);
    } else {
      mountains.setPalette(cur.ridgeNear, cur.ridgeFar, cur.mist, cur.mistOp);
    }
  }

  // 시간대 적용. opts.immediate=true(shot·초기 로드) 면 즉시 스냅, 아니면 크로스페이드.
  //   같은 상태로의 재적용(reapplyEnvBase 등)은 스냅(멱등 복구) — ink/날씨가 만진 fog 를 되돌린다.
  function apply(name, opts = {}) {
    if (!(name in TIME_PRESETS)) name = 'day';
    if (opts.immediate) {
      resolveInto(cur, name); curName = name; tw = null;
      applyCur();
      return;
    }
    if (tw) {
      if (name === tw.name) return;                 // 진행 중 트윈과 같은 목표 → 계속
      copyState(from, cur);                          // 현재 보간값을 새 from 으로(리타깃)
      resolveInto(to, name);
      tw = { t: 0, dur: DUR_TIME, name };
      return;
    }
    resolveInto(to, name);
    if (name === curName) {                          // 정착 상태에서 같은 시간대 재적용 → 스냅 복구
      copyState(cur, to); applyCur(); return;
    }
    copyState(from, cur);
    tw = { t: 0, dur: DUR_TIME, name };
  }

  // 매 프레임: 시간대 트윈 + 가을 능선 트윈 진행. env.update 에서 호출.
  function update(dt) {
    let moved = false;
    if (tw) {
      tw.t += dt;
      const k = easeInOut(tw.t / tw.dur);
      lerpStateInto(cur, from, to, k);
      applyCur();
      moved = true;
      if (tw.t >= tw.dur) { copyState(cur, to); curName = tw.name; tw = null; }
    }
    // 가을 능선 세기(지수 접근). 시간대 트윈이 없을 때도 능선만 갱신.
    if (Math.abs(autumn01 - autumnGoal) > 1e-4) {
      autumn01 += (autumnGoal - autumn01) * Math.min(1, dt * SEASON_RATE);
      if (Math.abs(autumn01 - autumnGoal) <= 1e-4) autumn01 = autumnGoal;
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
    if (opts.immediate) { autumn01 = autumnGoal; applyRidge(); }
  }

  // env fog 합성용: 현재 시간대 base fog(트윈 보간값). 모디파이어 적용 전 원본.
  function getBaseFog() { return { color: cur.fogColor, near: cur.fogNear, far: cur.fogFar }; }
  function isTweening() { return !!tw; }

  return { apply, setSeason, update, updateFlicker, getBaseFog, isTweening, dome, lanterns };
}
