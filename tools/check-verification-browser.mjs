import assert from 'node:assert/strict';
import { launchVerificationBrowser } from './lib/verification-browser.mjs';

const originalMode = process.env.CHEOMA_BROWSER;
try {
  await assert.rejects(
    launchVerificationBrowser({ channel: 'chrome' }),
    /Set CHEOMA_BROWSER/,
  );
  await assert.rejects(
    launchVerificationBrowser({ executablePath: '/not/a/browser' }),
    /Set CHEOMA_BROWSER/,
  );
  process.env.CHEOMA_BROWSER = 'invalid';
  await assert.rejects(
    launchVerificationBrowser(),
    /CHEOMA_BROWSER must be auto, chrome, or chromium/,
  );
} finally {
  if (originalMode === undefined) delete process.env.CHEOMA_BROWSER;
  else process.env.CHEOMA_BROWSER = originalMode;
}

console.log('VERIFICATION BROWSER: PASS (backend selector conflicts and invalid modes fail fast)');
