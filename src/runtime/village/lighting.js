import * as THREE from 'three';
import { TIME_PRESETS } from '../../env/sky.js';

// 마을 부감에서 배산 북사면과 처마 밑이 순흑으로 뭉개지지 않게 하는 전용 보조광.
// scene의 주 태양·hemi·post 값은 건드리지 않고, 마을 모드 수명 동안 rig 자체를 add/remove한다.
export const VILLAGE_LIGHT_BY_TIME = {
  dawn: {
    // P1′ (2026-08-01) — dawn fill 중성화 + 그늘면 리프트.
    //   fill 은 정의상 안티솔라(태양 반대편) 방향광이라 이 리그가 닿는 면은 전부 그늘면이다.
    //   구 0xffcda0(hue 30·HSL sat 1.0)은 sunset 리그가 이미 중성으로 옮긴 그 규율
    //   (look-grammar §2-3: 웜은 하이라이트·림·발광에만)을 dawn 만 그대로 어기고 있었다.
    //   순수 노드 실측(그늘면 표본 15종 = 사면 25/40/55° × 알베도 5종, fogFactor 0.30):
    //   중성 알베도(화강암)가 hue 24·HSV 채도 0.262 로 물들고 밴드 평균 r−b 가 +13.1 이었다.
    //   0xd0d0d2 로 중성화하면 채도 0.262 → 0.021 · r−b +13.1 → +2.0 이 된다.
    //   hemiGround(0x86745c)는 지면 바운스라 웜이 물리적으로 옳고, 위 실측의 지분도 작아
    //   그대로 둔다 — 위반의 실질 소유자는 fill 이었다.
    // 강도는 ① 그늘면 리프트와 합산해 정한다: hemiInt 0.62 → 0.80 · fillInt 0.85 → 0.95.
    //   밴드 평균 42.9 → 54.9 · 소핏 15.1/23.3/57.5 → 29.1/37.3/71.5(sRGB 휘도).
    hemiSky: 0xb9c2da, hemiGround: 0x86745c, hemiInt: 0.80,
    fillColor: 0xd0d0d2, fillInt: 0.95, fillElev: 0.34, glowBoost: 1.0,
  },
  day: {
    hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.22,
    fillColor: 0xfff0e0, fillInt: 0.18, fillElev: 0.4, glowBoost: 1.0,
  },
  sunset: {
    // 쿨한 상부광은 유지하고 웜 바운스와 fill을 낮춰 큰 능선의 주황 blowout을 막는다.
    //
    // fill 은 안티솔라(태양 반대편·카메라 쪽) 방향광이므로 이 리그가 비추는 면은 정의상 전부
    //   그늘면이다. 그래서 색은 웜이 아니라 중성~쿨이어야 한다(look-grammar §2-3: 웜은
    //   하이라이트·림·발광에만, 그림자·미드톤은 중성). 0xecc09c(hue 30·sat 0.42)는 이 규율을
    //   정면으로 어겼고, 태양보다 화면 기여가 큰 광원이라 실제 워시의 주범이었다 —
    //   부감 실측(객체 패밀리별 렌더 색, seed 20260718 crimson): 27개 패밀리 중 25개가
    //   hue 17~44 밴드에 뭉치고 기와가 hue 6(적색)으로, 화강암이 hue 2(순적색)로 떨어졌다.
    //   골든 빌드도 같은 웜 fill 이었으므로 이것은 회귀 복원이 아니라 절대축 상향이다.
    // 쿨로 옮기면 골든아워의 색온도 대비(수광면 웜 ↔ 암부 쿨)가 서고, 기와는 청회 슬레이트로,
    //   수목은 쿨 그린으로, 화강암은 중성 회색으로 다시 갈라진다.
    // 색은 무채 회청이 아니라 채도가 있는 청색이어야 한다: 중성 회색 fill 을 세게 넣으면 hue 는
    //   갈라지지만 프레임 전체 채도가 무너져 흐린 날처럼 읽혔다(실측 fill 0xc2cade@0.78 →
    //   forest-pine sat 0.26→0.11). 채도 있는 청을 원래 강도 근처에서 넣으면 암부가 청록으로
    //   물들면서 웜 수광면과 보색 대비가 서고, 프레임 채도는 유지된다.
    // 최종값은 청색이 아니라 살짝 쿨한 중성이다. 계약 문구가 "shadows and midtones stay
    //   neutral" 이므로 쿨로 넘어가면 반대쪽 실패가 된다 — 0x9db4de(hue 216·sat 0.5)는 hue 는
    //   갈라놨지만 분지 바닥을 청록으로 물들여 프레임이 하늘(앰버)과 다른 빛 아래 있는 것처럼
    //   읽혔다. 중성 회색광은 알베도 hue 를 그대로 통과시키므로 색 분리는 유지된다.
    // P1′ (2026-08-01) — #35-R2 fog 3축 교정의 후속. fog 선형휘도를 표면 중앙값의 ~2배로 내리자
    //   원경·중경이 fog 에서 받던 에어라이트 리프트가 함께 사라졌고, 산 중턱 그늘 밴드가 low 대역에
    //   잠겼다. fog 를 되올리면 워시 회귀이므로(그 라운드의 귀속 실측) 리프트는 표면 휘도 축에서만
    //   되찾는다 = 이 리그.
    //   왜 리그만으로는 부족한가(순수 노드 실측): fog 는 알베도와 무관한 가산 혼합이지만 조명은
    //   알베도에 곱해진다. 이 밴드의 알베도는 선형 0.02~0.03(솔잎·숲바닥)이라, hemiInt 를 0.54 →
    //   1.00 으로 밀어도 밴드 평균은 43.9 → 47.4(+8%)에 그친다. 그래서 리그는 형태를 살리는
    //   몫만 맡고(아래), 나머지는 알베도 독립 가산항인 GradePass lift 가 받는다
    //   (atmosphere-profiles.js 의 lift 0.022 → 0.042 주석).
    //   hemiGround 0x2a241e 는 거의 순흑이라 처마 소핏·하향면이 뭉개지던 항이다("bounce light
    //   must lift the shadow side — no crushed-black silhouettes"). 중성 다크 0x3a3733 으로
    //   올린다 — 웜/쿨 어느 쪽도 아니라 암부 중립 규율에 걸리지 않는다.
    //   실측(그늘면 15표본 fogFactor 0.30 / 소핏 3표본 0.12, sRGB 휘도):
    //     밴드 평균 43.9 → 55.1 · 소핏 25.8/33.2/67.1 → 36.4/44.1/80.6
    //     수광면/그늘면 대비 1.34 → 1.23(대비는 유지, 평탄화 아님)
    //     밴드 r−b +2.6 → −0.9 (암부가 더 중립으로 이동)
    hemiSky: 0x9fb0d6, hemiGround: 0x3a3733, hemiInt: 0.86,
    fillColor: 0xb6b9c4, fillInt: 0.92, fillElev: 0.42, glowBoost: 1.0,
  },
  // #150-H: retune only the existing village hemi + anti-solar fill (no new lights).
  // Cooler moon fill models wall/column depth under eaves; glowBoost still scales hanji only.
  night: {
    hemiSky: 0x42567a, hemiGround: 0x1e2838, hemiInt: 0.50,
    fillColor: 0xb0c4e6, fillInt: 0.38, fillElev: 0.42, glowBoost: 1.5,
  },
};

export function createVillageLightRig() {
  const rig = new THREE.Group();
  rig.name = 'village-lights';

  const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0);
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  fill.castShadow = false;
  rig.add(hemi, fill, fill.target);

  const rate = 2.4;
  const targetHemiSky = new THREE.Color();
  const targetHemiGround = new THREE.Color();
  const targetFillColor = new THREE.Color();
  const currentDirection = new THREE.Vector3(1, 0.4, 1).normalize();
  const targetDirection = new THREE.Vector3(1, 0.4, 1).normalize();
  const position = new THREE.Vector3();
  let targetHemiIntensity = 0;
  let targetFillIntensity = 0;
  let warmScale = 1;

  function setSiteRadius(radius) {
    const siteRadius = typeof radius === 'number' && radius > 0 ? radius : 150;
    const scaleT = Math.min(1, Math.max(0, (siteRadius - 170) / (300 - 170)));
    warmScale = Math.max(0.3, 1 - scaleT * 0.6);
  }

  function setTarget(name) {
    const preset = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
    targetHemiSky.setHex(preset.hemiSky);
    targetHemiGround.setHex(preset.hemiGround);
    targetHemiIntensity = preset.hemiInt;
    targetFillColor.setHex(preset.fillColor);
    targetFillIntensity = preset.fillInt;
    if (name === 'sunset' || name === 'dawn') {
      targetHemiIntensity *= warmScale;
      targetFillIntensity *= warmScale;
    }

    const sun = (TIME_PRESETS[name] || TIME_PRESETS.day).sunDir;
    const horizontal = Math.hypot(sun[0], sun[2]) || 1;
    targetDirection.set(-sun[0], horizontal * preset.fillElev, -sun[2]).normalize();
  }

  function placeFill() {
    position.copy(currentDirection).multiplyScalar(200);
    fill.position.copy(position);
    fill.target.position.set(0, 0, 0);
    fill.target.updateMatrixWorld();
  }

  function apply(name, { immediate = false } = {}) {
    setTarget(name);
    if (!immediate) return;
    hemi.color.copy(targetHemiSky);
    hemi.groundColor.copy(targetHemiGround);
    hemi.intensity = targetHemiIntensity;
    fill.color.copy(targetFillColor);
    fill.intensity = targetFillIntensity;
    currentDirection.copy(targetDirection);
    placeFill();
  }

  function update(dt) {
    const amount = Math.min(1, dt * rate);
    hemi.color.lerp(targetHemiSky, amount);
    hemi.groundColor.lerp(targetHemiGround, amount);
    hemi.intensity += (targetHemiIntensity - hemi.intensity) * amount;
    fill.color.lerp(targetFillColor, amount);
    fill.intensity += (targetFillIntensity - fill.intensity) * amount;
    currentDirection.lerp(targetDirection, amount).normalize();
    placeFill();
  }

  return {
    rig,
    apply,
    update,
    setSiteRadius,
    dispose() {
      hemi.dispose();
      fill.dispose();
    },
  };
}
