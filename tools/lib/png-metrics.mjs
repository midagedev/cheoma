import { PNG } from 'pngjs';

// Prove that a semantic layer contributes to the rendered canvas instead of
// merely projecting inside the camera frustum.
export function countChangedPixels(firstBuffer, secondBuffer, threshold = 12) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) return -1;

  let changed = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    const delta = Math.abs(first.data[index] - second.data[index])
      + Math.abs(first.data[index + 1] - second.data[index + 1])
      + Math.abs(first.data[index + 2] - second.data[index + 2]);
    if (delta >= threshold) changed++;
  }
  return changed;
}
