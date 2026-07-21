import { chromium } from 'playwright';

const BROWSER_MODES = new Set(['auto', 'chrome', 'chromium']);
const LOG_PREFIX = '[verification-browser]';

function browserMode() {
  const mode = process.env.CHEOMA_BROWSER ?? 'auto';
  if (!BROWSER_MODES.has(mode)) {
    throw new Error(
      `CHEOMA_BROWSER must be auto, chrome, or chromium (received ${JSON.stringify(mode)})`,
    );
  }
  return mode;
}

async function launchChrome(launchOptions) {
  return chromium.launch({ ...launchOptions, channel: 'chrome' });
}

/**
 * Launch the browser used by visual and app-level verification.
 *
 * The default prefers the locally installed Chrome channel, which can use the host GPU,
 * and falls back to Playwright's bundled Chromium when Chrome is unavailable. Explicit
 * CHEOMA_BROWSER choices never fall back, so CI and diagnostics remain reproducible.
 */
export async function launchVerificationBrowser(launchOptions = {}) {
  if (Object.hasOwn(launchOptions, 'channel') || Object.hasOwn(launchOptions, 'executablePath')) {
    throw new Error('Set CHEOMA_BROWSER instead of launchOptions.channel or executablePath');
  }
  const mode = browserMode();

  if (mode === 'chrome') {
    try {
      const browser = await launchChrome(launchOptions);
      console.log(`${LOG_PREFIX} browser=chrome mode=chrome`);
      return browser;
    } catch (error) {
      throw new Error('CHEOMA_BROWSER=chrome requested, but the Chrome channel could not launch', {
        cause: error,
      });
    }
  }

  if (mode === 'chromium') {
    const browser = await chromium.launch(launchOptions);
    console.log(`${LOG_PREFIX} browser=chromium mode=chromium`);
    return browser;
  }

  try {
    const browser = await launchChrome(launchOptions);
    console.log(`${LOG_PREFIX} browser=chrome mode=auto`);
    return browser;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n', 1)[0] : String(error);
    console.warn(`${LOG_PREFIX} Chrome unavailable (${reason}); falling back to bundled Chromium`);
    const browser = await chromium.launch(launchOptions);
    console.log(`${LOG_PREFIX} browser=chromium mode=auto fallback=chrome-unavailable`);
    return browser;
  }
}

/** Best-effort diagnostic only; renderer discovery must never change gate semantics. */
export async function reportWebGLRenderer(page, label = 'page') {
  try {
    const info = await page.evaluate(() => {
      let gl = window.__engine?.renderer?.getContext?.() || null;
      if (!gl) {
        for (const canvas of document.querySelectorAll('canvas')) {
          gl = canvas.getContext('webgl2')
            || canvas.getContext('webgl')
            || canvas.getContext('experimental-webgl');
          if (gl) break;
        }
      }
      if (!gl) return null;

      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        vendor: debug
          ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
      };
    });

    if (info?.renderer) {
      console.log(`${LOG_PREFIX} ${label} WebGL renderer=${info.renderer} vendor=${info.vendor || 'unknown'}`);
    } else {
      console.log(`${LOG_PREFIX} ${label} WebGL renderer=unavailable`);
    }
    return info;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n', 1)[0] : String(error);
    console.warn(`${LOG_PREFIX} ${label} WebGL renderer probe skipped (${reason})`);
    return null;
  }
}
