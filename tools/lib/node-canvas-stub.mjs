// Shared Node canvas stub for palette/texture paint paths.
// Extracted from check-hero-global-merge-hide.mjs — recording no-op 2d context.
// Pixel fidelity is not claimed; product gates inject this so makeMaterials can
// allocate CanvasTexture without a document.

/**
 * @returns {{ createCanvas: () => object }}
 */
export function makeRecordingCanvasFactory() {
  function createCanvas() {
    let width = 0;
    let height = 0;
    const gradient = { addColorStop() {} };
    const ctx = {
      set fillStyle(_v) {}, get fillStyle() { return '#000'; },
      set strokeStyle(_v) {}, get strokeStyle() { return '#000'; },
      set lineWidth(_v) {}, get lineWidth() { return 1; },
      fillRect() {}, strokeRect() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      rect() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
      save() {}, restore() {}, clip() {}, translate() {}, rotate() {},
      createLinearGradient() { return gradient; },
      createRadialGradient() { return gradient; },
      getImageData(x, y, w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      measureText() { return { width: 0 }; },
      get canvas() { return canvas; },
    };
    const canvas = {
      get width() { return width; },
      set width(v) { width = v; },
      get height() { return height; },
      set height(v) { height = v; },
      getContext(type) {
        if (type !== '2d') throw new Error(`expected 2d, got ${type}`);
        return ctx;
      },
      toDataURL: () => 'data:,',
    };
    return canvas;
  }
  return { createCanvas };
}
