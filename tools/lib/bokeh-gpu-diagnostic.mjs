// Pass-only timer at the product's maximum DPR. This deliberately excludes the
// scene render and every other composer pass, then restores renderer sizing and
// scatter state even when a timer query fails.
export async function runBokehMaxDprGpuDiagnostic(page, maxPixelRatio = 2) {
  return page.evaluate(
    async ({ requestedPixelRatio }) => {
      const engine = window.__engine;
      const renderer = engine.renderer;
      const gl = renderer.getContext();
      const pass = engine.debugPostResources().bokehPass;
      const previousPixelRatio = renderer.getPixelRatio();
      const previousScatterEnabled = pass.debugSourceScatter().enabled;
      const samples = [];
      let disjoint = false;
      const sequence = [false, true, true, false, true, false, false, true];
      try {
        renderer.setPixelRatio(requestedPixelRatio);
        engine.resize();
        engine.debugRenderDofFrame();
        const resources = engine.debugPostResources();
        const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        if (!ext || typeof gl.createQuery !== "function") {
          return {
            available: false,
            pixelRatio: renderer.getPixelRatio(),
            drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          };
        }
        const batchSize = 10;
        for (const enabled of sequence) {
          pass.setSourceScatterEnabled(enabled);
          const query = gl.createQuery();
          try {
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
            for (let index = 0; index < batchSize; index++) {
              pass.render(
                renderer,
                resources.composerWriteBuffer,
                resources.composerReadBuffer,
                0,
                false,
              );
            }
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            gl.flush();
            const deadline = performance.now() + 2500;
            while (
              performance.now() < deadline &&
              !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
            ) {
              await new Promise((resolve) => setTimeout(resolve, 4));
            }
            const available = gl.getQueryParameter(
              query,
              gl.QUERY_RESULT_AVAILABLE,
            );
            samples.push({
              enabled,
              milliseconds: available
                ? gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize
                : null,
            });
            disjoint ||= !!gl.getParameter(ext.GPU_DISJOINT_EXT);
          } finally {
            gl.deleteQuery(query);
          }
        }
        const median = (values) => {
          const sorted = [...values].sort((a, b) => a - b);
          const middle = sorted.length >> 1;
          return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) * 0.5;
        };
        const offMedianMs = median(
          samples
            .filter((sample) => !sample.enabled)
            .map((sample) => sample.milliseconds),
        );
        const onMedianMs = median(
          samples
            .filter((sample) => sample.enabled)
            .map((sample) => sample.milliseconds),
        );
        return {
          available:
            samples.length === sequence.length &&
            samples.every((sample) => sample.milliseconds != null),
          disjoint,
          pixelRatio: renderer.getPixelRatio(),
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          samples,
          offMedianMs,
          onMedianMs,
          deltaMs: onMedianMs - offMedianMs,
          ratio: onMedianMs / offMedianMs,
        };
      } finally {
        pass.setSourceScatterEnabled(previousScatterEnabled);
        renderer.setPixelRatio(previousPixelRatio);
        engine.resize();
        engine.debugRenderDofFrame();
      }
    },
    { requestedPixelRatio: maxPixelRatio },
  );
}
