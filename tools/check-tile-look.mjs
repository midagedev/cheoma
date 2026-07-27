// #150 item I — 기와 회흑·roughness·지붕 instanceColor 좁은 변주 순수 계약.
// 새 재질군 없이 telephoto 검은 선 뭉침을 줄이는 팔레트 토큰 밴드를 고정한다.
// 픽셀·드로우콜·MSAA 미감은 이 게이트의 일이 아니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  KOREA_COLORS,
  TILE_LOOK,
  VILLAGE_MATERIAL_COLORS,
  srgbRelativeLuminance,
  tileLookBandViolations,
} from '../src/builder/material-colors.js';
import { GIWA_ROOF } from '../src/village/variants.js';

const ROOT = resolve(import.meta.dirname, '..');

const bandFails = tileLookBandViolations();
assert.equal(bandFails.length, 0, bandFails.join('; ') || 'tile look bands');

const tileLum = srgbRelativeLuminance(KOREA_COLORS.tile);
const darkLum = srgbRelativeLuminance(KOREA_COLORS.tileDark);
assert.ok(tileLum > darkLum, 'tileDark must sit below tile for ridge hierarchy');
assert.ok(
  tileLum - darkLum >= TILE_LOOK.tileDarkSeparationMin,
  'tileDark separation too small (ridge reads same as field)',
);

// GIWA roof instanceColor ends stay inside the narrow band (plus jitter ceiling).
for (const end of [GIWA_ROOF.lo, GIWA_ROOF.hi]) {
  for (const ch of end) {
    assert.ok(
      ch >= TILE_LOOK.roofToneChannelMin && ch <= TILE_LOOK.roofToneChannelMax,
      `GIWA_ROOF channel ${ch} outside [${TILE_LOOK.roofToneChannelMin}, ${TILE_LOOK.roofToneChannelMax}]`,
    );
  }
}
assert.ok(
  GIWA_ROOF.jitter <= TILE_LOOK.roofToneJitterMax,
  `GIWA_ROOF.jitter ${GIWA_ROOF.jitter} exceeds ${TILE_LOOK.roofToneJitterMax}`,
);
// lo must still be darker-ish than hi on channel sum so wealth monotone can reach tone.
const loSum = GIWA_ROOF.lo.reduce((a, b) => a + b, 0);
const hiSum = GIWA_ROOF.hi.reduce((a, b) => a + b, 0);
assert.ok(hiSum > loSum, 'GIWA_ROOF hi must sum above lo for household wealth signal');

// palette.js must wire TILE_LOOK roughness + bump defaults (no scattered magic numbers).
const paletteSrc = readFileSync(resolve(ROOT, 'src/builder/palette.js'), 'utf8');
assert.match(paletteSrc, /TILE_LOOK\.tileFlatRoughness/);
assert.match(paletteSrc, /TILE_LOOK\.tileRidgeRoughness/);
assert.match(paletteSrc, /TILE_LOOK\.tileConvexRoughness/);
assert.match(paletteSrc, /TILE_LOOK\.tileSurfaceRoughness/);
assert.match(paletteSrc, /TILE_LOOK\.sugiwaRoughness/);
assert.match(paletteSrc, /TILE_LOOK\.bumpSurface/);
assert.match(paletteSrc, /TILE_LOOK\.bumpSugiwa/);
assert.ok(TILE_LOOK.bumpSurface > 0 && TILE_LOOK.bumpSurface < 0.5);
assert.ok(TILE_LOOK.bumpSugiwa > 0 && TILE_LOOK.bumpSugiwa <= TILE_LOOK.bumpSurface);
assert.ok(TILE_LOOK.bumpMatbae >= TILE_LOOK.bumpSurface && TILE_LOOK.bumpMatbae < 0.6);
const skeletonSrc = readFileSync(resolve(ROOT, 'src/layout/roof-skeleton.js'), 'utf8');
assert.match(skeletonSrc, /TILE_LOOK\.bumpSurface/);
assert.match(skeletonSrc, /TILE_LOOK\.bumpSugiwa/);
// Softened groove fillStyle (not near-black high-contrast seam) — telephoto black-line clump fix.
assert.match(paletteSrc, /g\.fillStyle\s*=\s*['"]rgba\(48,\s*50,\s*56,\s*0\.32\)['"]/);
assert.doesNotMatch(paletteSrc, /g\.fillStyle\s*=\s*['"]rgba\(30,\s*31,\s*36,\s*0\.5\)['"]/);

// Impostor far-proxy still reads the same tokens (no second roof palette).
const impostorSrc = readFileSync(resolve(ROOT, 'src/village/impostor-spec.js'), 'utf8');
assert.match(impostorSrc, /VILLAGE_MATERIAL_COLORS\.giwaRoofAverage/);
assert.match(impostorSrc, /KOREA_COLORS\.tileDark/);
assert.equal(VILLAGE_MATERIAL_COLORS.giwaRoofAverage, 0x56585f);

console.log(
  `TILE LOOK: PASS (tile Y=${tileLum.toFixed(3)}, tileDark Y=${darkLum.toFixed(3)}, `
  + `sep=${(tileLum - darkLum).toFixed(3)}, GIWA_ROOF sum ${loSum.toFixed(2)}→${hiSum.toFixed(2)}, `
  + `jitter=${GIWA_ROOF.jitter}, bump ${TILE_LOOK.bumpSurface}/${TILE_LOOK.bumpSugiwa}/${TILE_LOOK.bumpMatbae}, `
  + `rough ${TILE_LOOK.tileSurfaceRoughness})`,
);
