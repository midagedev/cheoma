// Renderer-independent atmosphere profiles. A "time" keeps the simulation contract
// (animals, lanterns, water, audio), while sunsetLook varies only the presentation.
// Keeping sky, lighting, haze, ridge and post values in one profile prevents a purple
// sky from retaining an unrelated orange rim or fog treatment.

export const DEFAULT_SUNSET_LOOK = 'gold';
export const SUNSET_LOOK_IDS = Object.freeze(['gold', 'crimson', 'violet']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const profile = (atmosphere, post) => deepFreeze({ atmosphere, post });

const DAWN = profile({
  // P1′ dawn 돔 정체성 복원(2026-08-01). 구 스톱은 지평 밴드(pos 0.44~0.52)가 0.35 의 회분홍과
  //   0.7 의 청회 사이 중간값이라 그 자체가 거의 무채였고, #35-R2 가 fog 를 중립으로 옮긴 뒤
  //   DOME_HAZE 가 그 위를 덮자 부감 하늘이 회색판이 됐다(실측: 밴드 평균 HSV 채도 0.049,
  //   색상이 24°→300° 로 흔들리는 회보라 뭉갬 — "새벽"이 아니라 "흐림"으로 읽힌다).
  //   fog 축은 손대지 않고 돔 축으로만 고친다: 지평(0.52)에 온색 스톱을 놓아 부감이 실제로 보는
  //   밴드를 새벽 온기로 채우고, 0.78·1.0 을 냉청·남색으로 남겨 "상단 냉청 → 지평 온색"
  //   그라디언트를 세운다. 스톱 수는 네 개 유지(프로필 간 1:1 보간 계약).
  //   실측(부감 밴드, 태양 반대 방위 = 최악): 평균 채도 0.049 → 0.298, 색상 24°→300° 가
  //   27°→26° 로 안정. 구배는 100행당 +13.0 → +13.3(게이트 하한 +1.5 유지).
  sky: [[0.0, '#f5cca6'], [0.52, '#e2a97f'], [0.78, '#8e9ac6'], [1.0, '#4f6096']],
  sunDir: [26, 9, 34], sunColor: 0xffd7ac, sunInt: 1.7,
  hemiSky: 0xc3bcd0, hemiGround: 0x6f6252, hemiInt: 0.75,
  // #35-R2 대기 3축 교정(2026-08-01) — 유도는 아래 gold 주석에 한 번만 적는다. dawn 도 같은 결함을
  //   공유했다(fog 선형휘도 0.648 = 이 프로필 표면 휘도 중앙값의 15.1배 — 네 프로필 중 최악).
  //   e4cfbd(H28·S_HSL 0.419·Y 0.648) → 474541(H40·S_HSL 0.050·Y 0.060).
  fog: 0x474541, fogNear: 55, fogFar: 430, exposure: 1.02,
  // P1′ 원경 정합(2026-08-01) — 유도는 gold 의 같은 줄 주석에 한 번만 적는다. dawn 이 네 프로필 중
  //   가장 어긋나 있었다(ridgeFar 9.3배 · mist 13.0배).
  ridgeNear: 0x4a5069, ridgeFar: 0x7e7577, mist: 0x928980, mistOp: 0.72,
  lantern: 0.0,
}, {
  // P1′ (2026-08-01) — dawn 에도 에어라이트 토 리프트를 둔다. 유도는 gold 의 P1′ 주석과 같다
  //   (fog 휘도 인하로 사라진 알베도 독립 가산분을 색이 아니라 밝기로만 되찾는 자리).
  //   dawn 은 fog 휘도 비율이 네 프로필 중 최악(15.1배)이었던 만큼 잃은 리프트도 컸다.
  //   sunset 보다 낮은 0.030 인 이유: dawn 리그의 fill 중성화(lighting.js)가 같은 밴드를 이미
  //   올려서, 0.042 를 그대로 쓰면 수광면/그늘면 대비가 1.2 아래로 내려간다.
  //   실측(그늘면 15표본 fogFactor 0.30, 리그 변경과 합산): 밴드 평균 42.9 → 54.9, 대비 1.32 → 1.23.
  bloomStrength: 0.55, bloomRadius: 0.55, bloomThreshold: 0.82,
  lift: 0.030, liftColor: 0x9aa6bd,
  rim: 1.15, rimColor: 0xffd6bc, rimPower: 2.1, rimWrap: 0.14,
  sunGlow: 0.70, sunGlowSize: 70, sunGlowColor: 0xffdcb4, sat: 1.12,
  flare: 0.55, flareColor: 0xffd9b4,
});

const DAY = profile({
  sky: [[0.0, '#d3dfe8'], [0.4, '#a9c4de'], [0.75, '#7ba6d6'], [1.0, '#5f8fca']],
  sunDir: [30, 42, 26], sunColor: 0xfff3e0, sunInt: 2.6,
  hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.9,
  fog: 0xcfdde8, fogNear: 95, fogFar: 500, exposure: 1.05,
  ridgeNear: 0x445f6d, ridgeFar: 0xbdd0dc, mist: 0xeef4f8, mistOp: 0.6,
  lantern: 0.0,
}, {
  bloomStrength: 0.42, bloomRadius: 0.5, bloomThreshold: 0.92,
  rim: 0.45, rimColor: 0xfff6ea, rimPower: 2.6, rimWrap: 0.12,
  sunGlow: 0.55, sunGlowSize: 46, sunGlowColor: 0xfff4e6, sat: 1.0,
  flare: 0.24, flareColor: 0xfff2e2,
});

// #150-H night depth legibility + #212 U2 night aerial moon-in-frame:
// form-model eaves/columns/walls with the *existing* moon (directional sun slot),
// hemisphere fill, fog layering, and post grade/rim. No new lights, material families,
// or emissive paths. Day/dawn/sunset are untouched.
// bloomThreshold stays 0.32 — moon-optics soft-knee is calibrated to that night floor.
// sunDir y is a low positive elevation so the product night aerial (15°) admits disc
// + corona in the upper sky band while light still arrives from above (raking moonlight).
const NIGHT = profile({
  // Slightly lifted mid-sky so the cool lunar band reads as haze rather than crushed navy.
  // #53 R2 (2026-08-04, vision FIX — star contrast): the lift above is what made stars
  //   unreadable. Measured product night aerial sky band was 78/255, so even the brightest
  //   authored star reached only 2.1x local contrast ("effectively invisible" verdict).
  //   This is a **small** step down (≈ −13% sRGB luminance per stop), not a reversal of the
  //   #150-H decision: the lunar haze reading is preserved and the floor stays well above
  //   crushed navy. Fog comes down with it (below) so sky and moonlit terrain stay one
  //   atmosphere — darkening the dome alone would make the terrain float, which is the
  //   named failure mode. Conflict with #150-H is deliberate and lead-reviewable.
  sky: [[0.0, '#293856'], [0.4, '#1b2845'], [0.75, '#131f33'], [1.0, '#0b111e']],
  // Azimuth unchanged (north-ridge moon); elevation lowered for aerial framing (was y=5).
  sunDir: [-7, 3, -32], sunColor: 0xa8bce6, sunInt: 1.14,
  // Hemi fill lifts soffits and wall faces the moon never reaches without erasing direction.
  hemiSky: 0x3d4c6e, hemiGround: 0x1c2436, hemiInt: 0.44,
  // Near architecture stays readable; far fog still layers ridges for aerial depth.
  // #53 R2: fog steps down with the sky stops (0x1e2c46 → 0x1a2740, ≈ −13% luminance) so the
  //   horizon band, scene.background and distant aerial perspective stay coupled to the dome.
  //   exposure/lighting untouched — near architecture legibility is unchanged.
  fog: 0x1a2740, fogNear: 70, fogFar: 420, exposure: 1.24,
  ridgeNear: 0x26324e, ridgeFar: 0x4a5a78, mist: 0x5a6a92, mistOp: 0.55,
  lantern: 1.0, moon: true,
  // #53 R3 (2026-08-04, lead look call): night-only multiplier on the dome's lunar azimuth
  //   glow band (sky.js SUN_BAND, authored peak 0.26 — the literal stays put because
  //   tools/check-fog-wash.mjs parses it from source). Attribution: the R3 ablation ladder
  //   pinned 97% of the night aerial sky floor and 84% of the skyward floor on that band,
  //   with bloom/stars/moon/cloud shares ≈ 0. The measured frontier over night peak
  //   (0.26 → 0) showed effective peak 0.08 takes the skyward sky floor 63.4 → 35.6/255 and
  //   lifts star contrast to 4.93x (1st) / 3.20x (20th) / 2.96x (30th) — clearing the
  //   2.5x target for the top 20–30 stars **without touching any star constant**.
  //   0.31 × 0.26 = 0.081 is that operating point, and the shipped measurement agrees: in one
  //   boot at one camera the skyward sky floor is 68.6 with the band at its authored peak and
  //   42.8 at 0.31 (31.0 with the milky way also off), while star contrast goes
  //   2.55x → 4.93x (1st), 1.86x → 3.01x (20th), 1.73x → 2.70x (30th). The lunar azimuth glow
  //   survives as a glow rather than being erased: on the dome row at SUN_BAND.posCenter its
  //   azimuthal amplitude drops 39.1 → 12.1/255 with the peak still on the moon's own column.
  //   Day/sunset/dawn keep 1.0, and because the multiplier is a plain × 1.0 there, forcing the
  //   scale explicitly to 1 renders byte-identical frames (0 of ~2.6M channels differ, with a
  //   same-value repaint control also at 0) — those profiles are frozen.
  //   This is a tween field in sky.js, not a hard switch: crossfades stay continuous.
  sunBandScale: 0.31,
}, {
  bloomStrength: 0.72, bloomRadius: 0.62, bloomThreshold: 0.32,
  // Softer, wider moon rim so eave silhouettes and column edges separate from walls.
  rim: 0.58, rimColor: 0xb4c8ec, rimPower: 2.30, rimWrap: 0.17,
  sunGlow: 0.0, sunGlowSize: 0, sunGlowColor: 0xa8bce6, sat: 1.0,
  flare: 0.0, flareColor: 0xa8bce6,
});

export const SUNSET_LOOKS = deepFreeze({
  gold: {
    label: { ko: '금빛 노을', en: 'Golden sunset' },
    ...profile({
      // 기본 노을 = 훨씬 따뜻한 붉은 골든아워. 사용자 지시: "붉은 노을의 느낌을 좋아해".
      //
      // 채도 규율(docs/look-grammar.md §2-3)을 지키면서 붉게 가는 방법은 축을 나누는 것이다.
      //   과감하게 붉히는 축 = 하늘 스톱·태양색·림·태양 글로우·플레어(=하이라이트·발광·역광).
      //   중성에 가깝게 지키는 축 = hemiGround(지면 바운스)·hemiSky(천정 산란)·fog 계열.
      // Phase 1 에서 crimson 프로필이 실패한 이유가 후자였다: 장미빛 앰비언트·대기색이 아래에서
      //   올라와 회벽·그림자·미드톤까지 물들여 "붉은 노을"이 아니라 단일 장미색 워시가 됐다.
      //   그래서 여기서도 hemiGround 0x9c7856·hemiSky 0x8593bd 는 손대지 않는다 — 태양 반대편
      //   (그림자면)은 여전히 차갑고 중성이며, 그 결과 실제 붉은 노을 사진 특유의 높은 색온도
      //   대비(따뜻한 수광면 ↔ 중성 암부)가 생긴다. fog·ridgeFar·mist 는 하늘과 하이라이트가
      //   붉어진 만큼만 살짝 따라간다(원경 대기와 하늘 사이 색상 하드컷 방지, §3 하늘 항).
      // 하늘 스톱 규약: pos 0.5=지평. "능선 바로 위" 밴드(뒷산 완만화 site.js 로 열린 그 자리)에
      //   가장 밝고 따뜻한 스톱을 놓고, 천정은 남색으로 남겨 대비를 만든다. 천정까지 붉히면 하늘
      //   전체가 한 색이 되어 대비가 죽는다.
      //   [2026-08-02 #46 개정] 그 밴드에 있던 진홍(0xc2495c)의 자리가 0.55 였고, 그래서 0.55→1.0
      //   직선이 돔 절반을 모브로 덮었다 — 아래 #46 주석이 실측과 함께 유도를 적는다. 온색 스톱은
      //   지평 바로 위(0.52)로 내려가고 그 위(0.62)에 냉색 스톱이 생겼다. 원 의도(능선 위가 가장
      //   따뜻·천정은 남색)는 그대로이고, 바뀐 것은 그 온기가 끝나는 높이다.
      // 실측 근거(A/B): 부감 프레임은 31° 하향 × 46° 렌즈라 상단 광선이 지평 아래 −8° 다. 즉 화면에
      //   보이는 하늘 밴드는 돔 pos≈0.44~0.50 구간이고, 그 구간은 DOME_HAZE(alpha 0.66~0.93)가
      //   대기색으로 수렴시킨다(sky.js — 지형 절단면 하드컷 방지 계약). 따라서 "부감에서 붉은 노을"은
      //   fog 계열이 담당하고 프로필 하늘 스톱은 아이레벨·히어로 화각에서 발현한다. fog 를 마젠타가
      //   아닌 주홍 쪽(hue≈20°)으로만 올려 원경 대기는 노을빛으로 물들이되, 마을 바닥 미드톤은
      //   불변으로 유지한다(town 부감 A/B 실측: 하늘 밴드 r−b 45→96·원경 능선 밴드 32→63 =
      //   노을은 대기가 받고, 마을 바닥은 r−b 30.5→31.8·luma 43.8→42.3 = 미드톤 워시 없음).
      // sunColor 는 붉힘 축이 아니다 — 프레임의 모든 수광면을 곱하는 유일한 값이라, 적기를 올리면
      //   회색 화강암은 hue 0~5°(순적색), 수목 녹은 hue 32°(갈색)로 끌려가 프레임 전체가 한 계열의
      //   갈색 워시가 된다. 실측(부감 A/B, 객체 패밀리별 렌더 색): 0xff9448 에서 forest-pine hue 32 ·
      //   forest-far hue 41 · forest-rocks hue 2 로 27개 패밀리 중 25개가 hue 17~44 밴드에 뭉쳤다.
      //   0xffa85c 로 되돌린 뒤 녹·암·흙이 다시 갈라진다. 붉은 노을 정체성은 하늘 스톱·rimColor·
      //   sunGlowColor·flareColor 가 갖는다(전부 불변) — 그쪽이 하이라이트·발광·역광 축이다.
      // #46 돔 구조 재저작(2026-08-02) — 세 노을 프로필 공통 유도를 여기 한 번만 적는다.
      //   결함: 드론 원테이크(감상 모드) sunset 캡처의 하늘이 주황 없는 균일 모브 한 톤으로 읽힌다.
      //   귀속(같은 부팅 A/B — 돔 visible=false / 돔 material.color=순수 초록, 마을 드론 τ=0.0714):
      //     상단 12% 밴드가 돔을 끄면 fog 뉴트럴(101,100,104)로, 초록으로 칠하면 전부 초록으로 바뀐다.
      //     즉 마젠타의 100%가 이 돔 텍스처다 — fog·post·모드 리셋의 지분은 0 이고, 같은 프레임의
      //     지면 밴드는 네 조건에서 (92,78,60) 로 완전 불변이었다(지면 분홍 캐스트는 없다).
      //   원인은 스톱 **배치**다: 구 배치는 0.26 부터 1.0 까지가 사실상 한 직선이라, 붉은 스톱에서
      //     남색 천정으로 가는 sRGB 직선이 돔의 절반(pos 0.55~1.0)을 덮었다. R 과 B 가 동시에 G 위에
      //     있는 구간이 곧 모브이므로 그 직선 자체가 마젠타 고원이다(min(R,B)−G 최대 +40, 15 이상이
      //     18/27 표본). 부감(pos 0.44~0.52)은 DOME_HAZE α≥0.62 로 fog 에 수렴해 이 고원을 못 봤고,
      //     드론은 50° 렌즈에 피치 −7~−15° 라 프레임 상단이 지평 위 +12~+18°(pos 0.54~0.60) —
      //     고원의 시작점을 화면 30%로 채운다. 그래서 같은 sunset 인데 부감 컷만 정상이었다.
      //   교정: dawn 이 P1′ 에서 이미 쓰던 구조(지평에 온색 스톱, 그 위에 냉색 스톱)를 노을에도 준다.
      //     스톱 수는 네 개 유지(프로필 간 1:1 보간 계약, tools/check-atmosphere-contract.mjs).
      //     0.52 = 지평 바로 위 온색 밴드(가장 밝고 따뜻) · 0.62 = 냉색 전환 · 1.0 천정 남색은 불변.
      //     0.52→0.62 사이에서 채도가 한 번 낮아지며 색상이 넘어가므로(실제 하늘의 중성 교차 구간)
      //     넓은 램프(0.66·0.70)에서 생기는 저채도 마젠타 스파이크(+12/+10)가 생기지 않는다.
      //   실측(순수 노드 돔 모델, sky.js 합성 산술 복제 · 실 돔 텍스처 리드백과 Δ≤6/255 로 검증):
      //     pos 0.52~1.0 의 min(R,B)−G 최대 gold +40 → +10 · crimson +37 → +10 · violet +22 → +19,
      //     +15 이상 표본(0.02 간격 · 태양/반대 방위) gold 18 → 0 · crimson 15 → 0 · violet 6 → 2.
      //     남은 최대치는 색상이 넘어가는 pos 0.58~0.60 한 점의 저채도 교차라 고원이 아니다.
      //     구조도 함께 선다 — gold 태양방위 휘도 pos 0.52/0.58/0.62/0.66 이 47.2/48.7/44.8/38.2
      //     (Δ9 의 평탄한 고원)에서 55.1/49.7/38.8/33.2(Δ22 단조 하강)로 바뀌고, 같은 구간 R−B 가
      //     +90 → +65(계속 온색)에서 +116 → −36(온색에서 냉색으로 넘어감)이 된다.
      //   불변: 노을 정체성은 지평 스톱·rimColor·sunGlowColor·flareColor 가 갖는다(후자 셋 전부 불변).
      //     0.0 스톱도 불변이다 — pos ≤0.44 는 α 0.94~0.98 로 배경색에 수렴하는 계약 구간이라
      //     화면에 거의 나오지 않는다.
      sky: [[0.0, '#ff9d52'], [0.52, '#ef6a3c'], [0.62, '#4c608a'], [1.0, '#3c4a86']],
      sunDir: [-16, 8, -45], sunColor: 0xffa85c, sunInt: 2.38,
      hemiSky: 0x8593bd, hemiGround: 0x9c7856, hemiInt: 0.72,
      // #31-2 대기색 정합(아래 crimson 주석에 세 프로필 공통 유도). ΔH 26° → 0°, S 0.46 → 0.39.
      // #35-R2 대기 3축 교정(2026-08-01) — 네 프로필 공통 유도를 여기 한 번만 적는다.
      //   증상: 유채 픽셀의 78.6%가 hue 320~30° 한 대역에 뭉치고 foliage 녹(60~180°)은 2.2%,
      //     암부 3분위 채도 0.279 — "그림자·미드톤은 중립"(look-grammar §2-3) 정면 위반.
      //   귀속(순수 노드 ablation, 대표 알베도 12종 × 마을 sunset 리그): fog 색을 같은 휘도의
      //     무채색으로 바꾸면 hueSpread 3.7° → 93.7° 로 복원된다. 톤매핑·exposure·GradePass
      //     sat/lift 의 지분은 0 이었다. 즉 범인은 fog 한 항이고, fogFactor 를 낮춰 풀 수 없다
      //     (설계 최대 0.456 이 아니라 0.20 에서 이미 92° → 7.3° 로 붕괴).
      //   왜 색상 회전만으로는 무효인가: 20° 로 돌리면 마젠타 워시가 주황 워시가 될 뿐이다
      //     (hueSpread 3.1°). 붕괴를 만드는 것은 fog 의 **절대 선형 채도량**이고, 그 양은
      //     선형 휘도에 비례한다 — 구 0xbe6c74 의 Y 0.229 는 이 프로필 표면 휘도 중앙값(0.023)의
      //     9.9배였다. 20% 혼합만으로 fog 가 픽셀의 다수가 되어 표면 색차를 덮는다.
      //   그래서 세 축을 동시에 움직인다: ① 색상을 마젠타(354°)에서 주홍·앰버(22°)로
      //     ② HSL 채도 0.387 → 0.102 ③ 선형 휘도 0.229 → 0.050(표면 중앙값의 2.2배).
      //     모델 실측(fogFactor 0.456): hueSpread 2.6° → 36.8°, rose 대역 12/12 → 4/12,
      //     중성 알베도(화강암·회벽)가 대기에서 얻는 채도 +0.309/+0.292 → +0.017.
      //     실렌더 A/B(마을 부감, fog 가 실제로 지배하는 원경 능선 밴드): rose 81.1% → 63.9%,
      //     foliage 녹 7.3% → 20.8%, 픽셀 hue 산포 30.8° → 59.7°(town 은 92.8→76.3 / 3.0→14.4 /
      //     21.9→41.1). 근경·중경은 fogFactor 가 낮아 색상 분포가 사실상 불변이다 — 워시는
      //     원경 밴드의 문제였고 수정도 거기서 발현한다.
      //   부작용이자 의도된 이득: 지평 밴드가 어두워지면서 sky.js DOME_HAZE α 램프가 비로소
      //     휘도 구배를 만든다(**돔 기여 기준** 부감 100행당 −2.2 → +3.7 — 태양 글로우·플레어·
      //     블룸 가산은 이 모델에 없다). 구 상태는 지평 아래가 지평 위보다 밝은 무구배 평면이었고
      //     그것이 "안개 띠 위에 뜬 인스턴스"의 실제 원인이었다(결함 #4).
      //     실렌더 A/B(같은 카메라 2부팅, 마을 부감 1440×900): 그 평면의 휘도가 142~150 → 74~81 로
      //     내려와 근경 지면대(50~80)와 같은 자리에 앉고, 평면 아래 경계의 하드 스텝이 3.8 → 0.9 로
      //     줄었다. 색상도 355°(마젠타) 고정에서 3~15°(주홍) 로, 채도는 0.45 고정에서 0.47→0.20 의
      //     변화로 바뀐다. 게이트: tools/check-fog-wash.mjs.
      //   불변: 노을 정체성은 하늘 스톱·rimColor·sunGlowColor·flareColor 가 갖는다(전부 불변).
      fog: 0x463e39, fogNear: 70, fogFar: 470, exposure: 1.13,
      // P1′ 원경 정합(2026-08-01) — 네 프로필 공통 유도를 여기 한 번만 적는다.
      //   #35-R2 는 fog 를 표면 휘도 근처로 내렸지만 능선·안개(mountains.js, 단독 건물 모드의
      //   겹겹 능선 + 안개 띠)는 그대로 뒀다. 그래서 원경이 자신이 녹아들어야 할 대기보다
      //   ridgeFar 7.1배 · mist 10.2배 밝은 상태가 됐다 — 대기 원근이 아니라 "유백색 판" 이다
      //   (crimson 주석의 #31-2 에서 이미 같은 실패를 한 번 지적했던 그 현상).
      //   실측(단독 건물 모드 1440×900 sunset 캡처의 행 프로파일): 하늘 돔 y=280 이 휘도 110.8·
      //   채도 0.47 인데 바로 아래 y=320~400 이 휘도 136.7·채도 0.29 로 **밝고 탈색된 띠**를
      //   만들고, 그 아래 능선이 91.6 으로 급락한다(하늘 구간 국소 돌출 +10.6).
      //   대조군: day 는 ridgeFar/fog 0.9배 · mist/fog 1.3배로 정합적이고, 같은 자리가 단조
      //   감소한다(돌출 +2.2). 즉 결함은 "저녁·새벽 프로필만 fog 를 따라 내려오지 않았다" 이다.
      //   교정: 색상·채도는 그대로 두고 선형 휘도만 fog 기준 배수로 내린다(ridgeFar ≈3x ·
      //   mist ≈4x). day 수준(≈1x)까지 내리지 않는 이유는 겹겹 능선의 층 분리가 룩의 일부라서다
      //   — 판을 없애되 깊이는 남긴다.
      ridgeNear: 0x574863, ridgeFar: 0x8b6550, mist: 0x967a68, mistOp: 0.6,
      lantern: 0.15,
    }, {
      // rim 2.05 는 그대로 둔다 — tools/check-rim-facing.mjs 의 HDR 에너지 상한(2.05×1.85)이
      //   이 숫자를 기준으로 캘리브레이션돼 있고, 붉힘은 rimColor 로만 가져간다(휘도는 오히려 감소).
      // lift / liftColor: 에어라이트 토 리프트(GradePass, 선형 HDR·ACES 전). 역광 노을에서 대면적
      //   기와·수관·처마밑이 sRGB 3~8 로 뭉개져 실루엣이 아니라 구멍으로 읽히는 것을 막는다
      //   (계약: "bounce light must lift the shadow side — no crushed-black silhouettes").
      //   가중이 (1-col) 이라 하이라이트·림·플레어는 수치상 불침해다. 색은 쿨 중성 슬레이트 —
      //   웜으로 들어올리면 그림자·미드톤이 다시 주황 워시가 된다(§2-3 채도 규율).
      // P1′ lift 0.022 → 0.042 (2026-08-01). #35-R2 가 fog 선형휘도를 9.9배 → 2.2배로 내리면서
      //   원경·중경이 fog 에서 받던 에어라이트 리프트가 함께 사라졌다(부감 프레임 평균 117.7 →
      //   72.7). fog 를 되올리는 것은 워시 회귀라 금지이고, exposure 로는 복구되지 않는다(실측).
      //   조명 리그(lighting.js)는 알베도에 곱해지므로 선형 0.02~0.03 짜리 솔잎·숲바닥에서는
      //   한계가 있다 — hemiInt 0.54 → 1.00 을 밀어도 밴드 평균 +8%. 이 lift 항만이 fog 와 같은
      //   **알베도 독립 가산**이고, 가중이 (1-col) 이라 하이라이트·림·플레어는 수치상 불침해다.
      //   즉 fog 가 하던 에어라이트 몫을 색이 아니라 밝기로만 되돌려 받는 자리다.
      //   실측(그늘면 15표본 fogFactor 0.30, 리그 상향과 합산, sRGB 휘도): 밴드 평균 43.9 → 55.1,
      //   수광면/그늘면 대비 1.34 → 1.23, 밴드 r−b +2.6 → −0.9. 0.042 를 넘기면 대비가 1.2 아래로
      //   내려가고 쿨 슬레이트 색이 암부에 보이기 시작한다(0.070 에서 r−b −5.3) — 그게 상한 근거다.
      bloomStrength: 0.66, bloomRadius: 0.38, bloomThreshold: 0.80,
      lift: 0.042, liftColor: 0x9aa6bd,
      rim: 2.05, rimColor: 0xffa757, rimPower: 1.7, rimWrap: 0.13,
      sunGlow: 0.98, sunGlowSize: 42, sunGlowColor: 0xff8f45, sat: 1.20,
      flare: 1.0, flareColor: 0xffa155,
    }),
  },
  crimson: {
    label: { ko: '붉은 노을', en: 'Crimson sunset' },
    ...profile({
      // A clearer, aerosol-rich afterglow: hot peach at the horizon, red lower sky,
      // restrained plum above. Ambient light stays mauve so foliage does not turn brown.
      //
      // 채도 규율(docs/look-grammar.md §2-3): 붉은 노을의 정체성은 하늘·태양·플레어가 갖고,
      //   앰비언트와 대기색은 중성에 가까워야 한다. 이전 hemiGround 0x925f50 / fog 0xbd8d89 는
      //   장미빛 자체가 아래에서 올라와 회벽·그림자·미드톤까지 물들였고(A/B 실측: 같은 컷의
      //   gold 대비 프레임 평균 채도는 같은데 밝기 −16%, 흰 재질의 색조가 마젠타로 이동),
      //   결과가 "붉은 노을"이 아니라 단일 장미색 워시였다. 마젠타 성분만 덜어 흙빛으로 옮긴다
      //   — 하늘 스톱·태양색·플레어는 불변이므로 룩 정체성은 유지된다.
      // sunColor: gold 와 같은 이유로 적기를 덜어냈다(위 gold 주석의 실측이 이 프로필 캡처였다).
      //   붉음은 하늘 스톱·rim·glow·flare 가 유지하므로 crimson 의 정체성은 그대로다.
      // #46 돔 구조 재저작(2026-08-02, 유도는 gold 주석). crimson 이 결함 보고의 실제 캡처 프로필이다
      //   — 앱은 seed 로 sunsetLook 을 뽑고 tools/shoot-journey.mjs 의 seed 가 crimson 을 준다.
      //   구 0.57 스톱 0x8d587e 는 그 자체가 자두빛(min(R,B)−G +38)이라 0.57→1.0 직선 전체가 모브였다.
      //   실측: pos 0.52~1.0 의 min(R,B)−G 최대 +37 → +10, 15 이상 표본 15 → 0.
      //   0.52 스톱은 구 0.26 의 붉은 하늘(0xd96862)을 거의 그대로 지평 밴드로 올린 값이라
      //   "붉은 노을" 정체성은 오히려 화면에 처음으로 발현한다(구 배치에서 0.26 은 α≥0.94 로 가려짐).
      sky: [[0.0, '#f6a266'], [0.52, '#d9615c'], [0.62, '#4c6078'], [1.0, '#3d4d80']],
      sunDir: [-16, 8, -45], sunColor: 0xffa672, sunInt: 2.25,
      hemiSky: 0x8a90b6, hemiGround: 0x8e6a54, hemiInt: 0.70,
      // #31-2 대기색 정합(세 노을 프로필 공통 유도 — 여기 한 번만 적는다).
      //   문제: 돔은 지평 밴드를 fog 색으로 수렴시키는데(sky.js DOME_HAZE, pos 0.44~0.62 에서 α
      //   0.74~0.96), fog 의 색상이 그 밴드의 하늘색과 전혀 다른 계열이었다. 실측 색상차(지평
      //   pos 0.52 대비): gold +26° · crimson +46° · violet +13°. crimson 은 지평 하늘이 장미-자두
      //   (H331)인데 fog 가 따뜻한 황갈(H17)이라, 수렴이 아니라 **색상 이음매**로 읽혔다
      //   (docs/look-grammar.md §3 "지평 밴드는 fog색으로 수렴" 위반, 비전 2라운드 지적).
      //   또 fog 가 수렴 대상 하늘 밴드보다 **밝았다**(crimson relL 0.362 vs 하늘 0.478→L기준 더 밝음)
      //   — 원경이 뒤 하늘보다 밝은 색으로 씻기니 대기 원근이 아니라 유백색 판이 됐다.
      //   해법: 색상은 지평 밴드(pos 0.52)에 맞추고, 채도는 오히려 **낮추고**, 명도는 fog 와 그
      //   하늘 밴드의 중간으로 내린다. 채도가 세 프로필 모두 내려가므로(§2-3 채도 규율) "이전
      //   fog 0xbd8d89 장미빛이 미드톤을 물들였다"는 그 실측 근거는 약화되지 않는다 — 색조 방향만
      //   돔과 일치시키고 색의 양은 줄이는 변경이다. 노을 정체성은 여전히 하늘 스톱·rim·glow·
      //   flare 가 갖는다(전부 불변).
      //   crimson: ΔH 46° → 0°, S 0.30 → 0.22, relL 0.362 → 0.237.
      // #35-R2 대기 3축 교정(2026-08-01, 유도는 gold 주석). 그 정합은 **색상**만 맞췄고 fog 의
      //   절대 채도량은 그대로였다 — crimson 도 fogFactor 0.456 에서 hueSpread 3.5°·rose 12/12 로
      //   gold 와 같은 워시였다. a8788f(H331·S_HSL 0.216·Y 0.237) → 453e3b(H16·S_HSL 0.080·Y 0.050).
      //   실측: hueSpread 3.5° → 42.1°, rose 12/12 → 5/12, 돔 밴드 구배 −2.4 → +4.7/100행.
      fog: 0x453e3b, fogNear: 70, fogFar: 462, exposure: 1.11,
      // P1′ 원경 정합(위 gold 주석). crimson: ridgeFar 6.5배 → 3.0배 · mist 9.5배 → 4.1배.
      ridgeNear: 0x54465b, ridgeFar: 0x84655c, mist: 0x90786f, mistOp: 0.61,
      lantern: 0.15,
    }, {
      bloomStrength: 0.61, bloomRadius: 0.37, bloomThreshold: 0.80,
      lift: 0.042, liftColor: 0x9aa6bd,       // gold 와 동일 근거(위 P1′ 주석). 밴드 42.9 → 53.9
      rim: 1.98, rimColor: 0xffad7d, rimPower: 1.75, rimWrap: 0.13,
      sunGlow: 0.90, sunGlowSize: 39, sunGlowColor: 0xff9974, sat: 1.14,
      flare: 0.96, flareColor: 0xffad86,
    }),
  },
  violet: {
    label: { ko: '보랏빛 노을', en: 'Violet sunset' },
    ...profile({
      // Late civil twilight: a warm solar band remains at the horizon while scattered
      // blue light mixes with red afterglow into mauve and indigo higher in the dome.
      // #46 돔 구조 재저작(2026-08-02, 유도는 gold 주석). violet 은 모브가 정체성이라 셋 중 결함이
      //   가장 약했고(최대 +22) 교정도 가장 얕게 간다 — 0.62 스톱을 회청이 아니라 청보라(0x55607e)로
      //   두어 상부 하늘의 보랏빛을 남긴다. 실측: 최대 +22 → +19, +15 이상 표본 6 → 2.
      //   바뀌는 것은 색보다 구조다 — 태양방위 휘도 pos 0.52/0.58/0.62/0.66 이 53.2/54.0/49.1/41.1
      //   (Δ12, 지평보다 그 위가 밝은 평탄 고원)에서 60.8/55.7/42.2/35.5(Δ25, 지평이 최대)로 선다.
      sky: [[0.0, '#e9aa82'], [0.52, '#c97f8e'], [0.62, '#55607e'], [1.0, '#354777']],
      sunDir: [-16, 8, -45], sunColor: 0xffbea0, sunInt: 2.14,
      hemiSky: 0x7d83b8, hemiGround: 0x806078, hemiInt: 0.72,
      // #31-2 대기색 정합(위 crimson 주석 유도). ΔH 13° → 1°, S 0.12 → 0.10 — 이미 거의 정합이라
      //   변화가 가장 작다. dawn(ΔH 46°)은 이번 지시 범위(sunset) 밖이라 그대로 둔다.
      // #35-R2 대기 3축 교정(2026-08-01, 유도는 gold 주석). violet 은 색상 축이 이미 무해했고
      //   (rose 0/12) 남은 결함은 휘도였다 — Y 0.252 = 표면 중앙값의 11.2배로 네 프로필 중 최대
      //   비율이었다. 그래서 여기서는 색상을 옮기지 않는다(보랏빛 정체성 보존): 91859c
      //   (H271·S_HSL 0.104·Y 0.252) → 48434e(H267·S_HSL 0.076·Y 0.059).
      //   채도를 함께 내리는 이유: 휘도만 내리면 같은 HSL 채도가 어두운 픽셀에서 상대적으로 더
      //   크게 작용해 중성 알베도(화강암)의 색조 전이가 +0.027 → +0.079 로 오히려 늘어난다.
      //   실측: hueSpread 12.0° → 43.5°, rose 0/12 → 2/12, 돔 밴드 구배 −1.9 → +6.1/100행.
      fog: 0x48434e, fogNear: 68, fogFar: 455, exposure: 1.12,
      // P1′ 원경 정합(위 gold 주석). violet: ridgeFar 4.7배 → 2.5배 · mist 7.8배 → 3.5배.
      ridgeNear: 0x4b4c68, ridgeFar: 0x71687e, mist: 0x847c86, mistOp: 0.62,
      lantern: 0.18,
    }, {
      bloomStrength: 0.60, bloomRadius: 0.39, bloomThreshold: 0.79,
      lift: 0.042, liftColor: 0x9aa6bd,       // gold 와 동일 근거(위 P1′ 주석). 밴드 45.3 → 56.3
      rim: 1.90, rimColor: 0xe9bec5, rimPower: 1.82, rimWrap: 0.13,
      sunGlow: 0.86, sunGlowSize: 38, sunGlowColor: 0xf2ad9f, sat: 1.20,
      flare: 0.88, flareColor: 0xe5b4c5,
    }),
  },
});

export const TIME_PROFILES = deepFreeze({ dawn: DAWN, day: DAY, night: NIGHT });

// Backward-compatible atmosphere-only view for consumers that only need the canonical
// direction or lighting values. `sunset` intentionally remains the flagship gold look.
export const TIME_PRESETS = deepFreeze({
  dawn: DAWN.atmosphere,
  day: DAY.atmosphere,
  sunset: SUNSET_LOOKS[DEFAULT_SUNSET_LOOK].atmosphere,
  night: NIGHT.atmosphere,
});

export function normalizeSunsetLook(value) {
  return SUNSET_LOOK_IDS.includes(value) ? value : DEFAULT_SUNSET_LOOK;
}

export function resolveAtmosphereProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].atmosphere;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).atmosphere;
}

export function resolvePostProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].post;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).post;
}

export function atmosphereProfileKey(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  return time === 'sunset' ? `sunset:${normalizeSunsetLook(sunsetLook)}` : (time in TIME_PROFILES ? time : 'day');
}
