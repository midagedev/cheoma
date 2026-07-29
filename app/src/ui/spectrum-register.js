// Side-effect registration of Spectrum Web Components used by cheoma chrome.
// Import once from main.js. Keep the set explicit — do not use the full bundle.
//
// The CAD inspector owns its own controls (ui/tokens.css `.cad-*` + native
// elements) because Spectrum's consumer affordances — the iOS switch, the pill
// segment, the 46px accent button — are the vocabulary that column must not
// speak, and its gray ramp is too compressed to read as tool depth. What is left
// here is the theme root plus the one component still used over the scene: the
// floating environment dial on solo (non-village) scenes.
//
// A tag that appears in no template needs no registration, so anything added
// back here must come with a real `<sp-…>` usage.

import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/spectrum-two/theme-dark.js';
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';

import '@spectrum-web-components/action-button/sp-action-button.js';
