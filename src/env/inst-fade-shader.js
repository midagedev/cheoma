// Shared screen-door fade shader contract for village tree color and DoF depth.
// Both passes must discard the exact same pixels or a faded canopy remains as an
// invisible opaque depth blob and makes focus appear to pulse.

export const INST_FADE_PROGRAM_VERSION = 'cheoma-inst-fade-v1';

const VERTEX_DECLARATION = '#include <common>\nattribute float instFade;\nvarying float vInstFade;';
const VERTEX_ASSIGNMENT = '#include <begin_vertex>\nvInstFade = instFade;';
const FRAGMENT_DECLARATION = '#include <common>\nvarying float vInstFade;';
const FRAGMENT_DISCARD = `#include <clipping_planes_fragment>
  if (vInstFade < 0.999) {
    float _ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (vInstFade < _ign) discard;
  }`;

export function patchInstFadeShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', VERTEX_DECLARATION)
    .replace('#include <begin_vertex>', VERTEX_ASSIGNMENT);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', FRAGMENT_DECLARATION)
    .replace('#include <clipping_planes_fragment>', FRAGMENT_DISCARD);
}
