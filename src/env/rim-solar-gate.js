// 역광 림의 태양 게이트 상수 — three 를 쓰지 않는 단독 소유자.
//
// rim.js 에서 분리했다(2026-08-07). 셰이더가 이 값을 문자열로 굽고, 히어로 태양 해(hero-sun.js)가
// 같은 값으로 방위·고도를 고른다. 두 소비자가 각자 상수를 들면 즉시 갈라지므로 파일 하나가 소유한다.
// rim.js 는 이 이름을 재수출하므로 기존 소비자(tools/check-rim-*.mjs)의 임포트 경로는 그대로다.
//
// 아래 서술은 rim.js 에 있던 원문(2026-08-01, #35 round 3 — user-approved P2c)이다.
//
// The physical conditions still shape the rim, but as attenuation rather than as an all-or-nothing
// switch. Real backlit edges glow even in shadow and even somewhat off the sun axis, because the
// whole sky is a source at golden hour — so each condition keeps a floor. The stock lighting loop
// captures the already-shadowed first sun; combining that visibility with directDiffuse keeps a
// later unshadowed fill from reviving a full-strength rim inside the sun's shadow, without another
// sampler fetch or program variant.
//
// facingStart/facingFull describe a **light wrap taper on the lit side of the terminator**, not a
// sun-direction sign gate. The shipped ramp was
// `mix(uRimWrap, 1, smoothstep(facingStart, facingFull, dot(N, sun)))`, i.e. it multiplied the rim
// by the wrap floor 0.10 exactly where a backlit subject presents its camera-facing flank
// (dot(N,sun) < 0 there by definition), while a fragment turned *into* the sun got the full 1.0.
// The stock `_directGate` then charged the same orientation a second time, because
// reflectedLight.directDiffuse is ~0 both inside a cast shadow and on a face merely averted from
// the sun. Measured product expansion (sunset, ndv 0.05, building ×1.5, chain in
// tools/check-rim-master.mjs §5): the sun-opposite backlit face landed at 37.4% of the authored
// peak at 16°/60 m and 21.3% on the 46°/464 m aerial, while a *sun-facing* sliver (dot(N,sun)
// +0.2) saturated the cap at 100%. The flagship rim was therefore brightest in front light and
// dimmest in the backlit silhouette it exists to draw — the exact inverse of the look contract.
//
// The view-level question "is the sun behind the subject" is already answered by `_backlit`
// (-dot(V, sun)); the fragment level must answer "does the shading BRDF already carry this
// energy". It does not on or beyond the terminator (that is where wrap-around sky and grazing sun
// light live and where stock diffuse gives nothing), and it does on a surface turned into the sun.
// So the ramp is inverted and widened: full through the whole terminator band, tapering to the
// sky-scatter floor once the surface is within ~52° of the sun (facingFull 0.62 ≈ cos 52°, up from
// 0.12). And `_directGate` keeps only its real content — cast-shadow occlusion — by taking the
// max of the direct-light evidence and the same shade term, so orientation is charged once.
export const RIM_SOLAR_GATE = Object.freeze({
  facingStart: -0.05,
  facingFull: 0.62,
  backlitStart: 0.02,
  backlitFull: 0.45,
  // 순광·측광 뷰에 남기는 최소 강도. 골든이 전역 backlit 게이트에 두었던 0.18 바닥과 같은 뜻 —
  // 림은 역광에서 읽히는 것이 본질이므로 이 값이 커지면 방향성이 무너진다.
  backlitFloor: 0.20,
  directStart: 0.002,
  directFull: 0.08,
  // 그림자 안(직사광이 도달하지 않는 프래그먼트)에 남기는 바닥. 히어로 태양이 배산에 가려지면
  // 종가 전체가 이 값에 눌린다 — hero-sun.js 가 그 상태를 피해 방위·고도를 고르는 이유다.
  shadowFloor: 0.45,
});
