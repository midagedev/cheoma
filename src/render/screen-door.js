// One static screen-space IGN vocabulary for opaque screen-door presentation.
// A positive signed coverage owns the low subset; a negative one owns the complementary high
// subset. Complementary c and -(1-c) therefore cover every pixel exactly once.
export function screenDoorDiscard(varyingName) {
  return `float _screenDoorCoverage = clamp(abs(${varyingName}), 0.0, 1.0);
  if (_screenDoorCoverage < 0.999) {
    float _screenDoorIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (${varyingName} >= 0.0) {
      if (_screenDoorIgn >= _screenDoorCoverage) discard;
    } else {
      if (_screenDoorIgn < 1.0 - _screenDoorCoverage) discard;
    }
  }`;
}
