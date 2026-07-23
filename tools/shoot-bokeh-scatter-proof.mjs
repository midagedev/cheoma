// Run the canonical optical chart, then append source-driven scatter artifacts
// and true feature ON/OFF GPU/resource evidence without changing product defaults.
process.env.CHEOMA_BROWSER = 'chrome';
process.env.CHEOMA_BOKEH_SCATTER_PROOF = '1';
await import('./shoot-bokeh-fixture.mjs');
