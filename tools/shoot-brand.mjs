// 리브랜딩(#39) + 레퍼런스 모달(#42) 검증 캡처. 출력: shots/brand-*.png
//   실행: node tools/shoot-brand.mjs
// 정적 서버(ROOT) 4179 에서 빌드본 app/dist-brand 를 서빙(다른 에이전트 dist 와 격리).
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    if (path.endsWith('/')) path += 'index.html';
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
const PORT = 4179;
await new Promise((ok, no) => { server.on('error', no); server.listen(PORT, '127.0.0.1', ok); })
  .catch(async () => { await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); });
const port = server.address().port;
const SPA = `http://127.0.0.1:${port}/app/dist-brand`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let errors = 0;
const check = (name, pass, detail = '') => {
  if (pass) console.log(`  PASS ${name}${detail ? ` (${detail})` : ''}`);
  else { errors++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
};
const trackErrors = (pg) => {
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
  pg.on('pageerror', (e) => { errors++; console.error('[pageerror]', e.message); });
};

const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });
trackErrors(page);
const ready = () => page.waitForFunction('window.__engine', null, { timeout: 30000 });
const settle = (ms = 500) => page.waitForTimeout(ms);
const shot = async (name, opts) => { await page.screenshot({ path: join(OUT, `brand-${name}.png`), ...opts }); console.log('saved', `brand-${name}.png`); };

// 크로마 깨우기(페이드 방지) + 레퍼런스 모달 열기.
async function openRefModal(pg = page) {
  await pg.mouse.move(680, 425);
  await pg.waitForTimeout(250);
  await pg.locator('.seal-label .info').click({ timeout: 5000 });
  await pg.waitForSelector('.modal[role="dialog"]', { timeout: 5000 });
  await pg.waitForTimeout(500);
}

// ---------- 히어로 타이틀 (cheoma · 처마 + 태그라인) ----------
async function hero() {
  for (const lang of ['ko', 'en']) {
    await page.goto(`${SPA}/?lang=${lang}&seed=20260716`, { waitUntil: 'load' });
    await ready(); await settle(1100);
    await shot(`hero-${lang}`);
  }
}

// ---------- 좌하 낙관·세로쓰기 (브랜드) ----------
async function seal() {
  await page.goto(`${SPA}/?hero=0&lang=ko&seed=20260716&time=sunset`, { waitUntil: 'load' });
  await ready(); await settle(1300);
  await page.mouse.move(680, 425); await settle(300);
  await shot('seal-full');
  // 좌하 코너 확대 — 낙관 전각 밀도·세로쓰기 육안 판정용.
  await shot('seal-closeup', { clip: { x: 0, y: 690, width: 300, height: 160 } });
}

// ---------- 레퍼런스 모달 (ko/en, 데스크톱) ----------
async function refDesktop() {
  for (const lang of ['ko', 'en']) {
    await page.goto(`${SPA}/?hero=0&lang=${lang}&seed=20260716&time=sunset`, { waitUntil: 'load' });
    await ready(); await settle(1200);
    await openRefModal();
    await shot(`ref-${lang}-top`);
    // 아래로 스크롤 → 카테고리·제작 노트 렌더 확인.
    await page.locator('.modal .scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await settle(400);
    await shot(`ref-${lang}-bottom`);
  }
}

// ---------- 레퍼런스 모달 (모바일 세로 풀스크린 시트) ----------
async function refMobile() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const pg = await ctx.newPage();
  trackErrors(pg);
  await pg.goto(`${SPA}/?hero=0&lang=ko&seed=20260716&time=sunset`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__engine', null, { timeout: 30000 });
  await pg.waitForTimeout(1300);
  await pg.mouse.move(195, 420); await pg.waitForTimeout(250);
  await pg.locator('.seal-label .info').click({ timeout: 5000 });
  await pg.waitForSelector('.modal[role="dialog"]', { timeout: 5000 });
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: join(OUT, 'brand-ref-mobile.png') });
  console.log('saved', 'brand-ref-mobile.png');
  await ctx.close();
}

// ---------- 사진 찍기 명칭 + 캡처 낙관(처마 전각) ----------
async function postcard() {
  for (const { lang, label, tip } of [
    { lang: 'ko', label: '사진 찍기', tip: '낙관을 더해 사진으로 저장·공유' },
    { lang: 'en', label: 'Take photo', tip: 'Save & share a photo with the cheoma seal' },
  ]) {
    await page.goto(`${SPA}/?hero=0&lang=${lang}&seed=20260716&time=sunset`, { waitUntil: 'load' });
    await ready(); await settle(700);
    await page.mouse.move(680, 425); await settle(150);
    const button = page.locator('.actions button').filter({ hasText: label });
    check(`${lang} photo action unique`, await button.count() === 1);
    check(`${lang} photo action label`, (await button.locator('.face').textContent())?.trim() === label);
    check(`${lang} photo action tooltip`, await button.getAttribute('title') === tip);
    if (lang === 'ko') await button.screenshot({ path: join(OUT, 'brand-photo-action-ko.png') });
  }

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.actions button').filter({ hasText: 'Take photo' }).click();
  const download = await downloadPromise;
  check('photo action downloads PNG', /^cheoma-.+\.png$/.test(download.suggestedFilename()), download.suggestedFilename());

  const capture = await page.evaluate(async () => {
    const dataUrl = window.__engine.postcard({ download: false });
    const image = await new Promise((resolveImage, rejectImage) => {
      const element = new Image();
      element.onload = () => resolveImage(element);
      element.onerror = rejectImage;
      element.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const sealH = Math.round(image.height * 0.062);
    const sealW = Math.round(sealH * 0.76);
    const margin = Math.round(image.height * 0.035);
    const x = image.width - margin - sealW, y = image.height - margin - sealH;
    const pixels = context.getImageData(x, y, sealW, sealH).data;
    let sealRedPixels = 0, sealPaperPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
      if (Math.abs(red - 177) < 40 && Math.abs(green - 54) < 34 && Math.abs(blue - 43) < 34) sealRedPixels++;
      if (red > 220 && green > 210 && blue > 190) sealPaperPixels++;
    }
    return {
      dataUrl,
      width: image.width,
      height: image.height,
      sealRedPixels,
      sealPaperPixels,
      sealArea: sealW * sealH,
    };
  });
  check('photo capture has output size', capture.width > 0 && capture.height > 0, `${capture.width}×${capture.height}`);
  check(
    'photo capture contains lower-right seal ink',
    capture.sealRedPixels / capture.sealArea > 0.35,
    `${capture.sealRedPixels}/${capture.sealArea} pixels`,
  );
  check('photo capture contains seal lettering', capture.sealPaperPixels > 30, `${capture.sealPaperPixels} paper pixels`);
  const buf = Buffer.from(capture.dataUrl.split(',')[1], 'base64');
  await writeFile(join(OUT, 'brand-postcard.png'), buf);
  console.log('saved', 'brand-postcard.png');
}

const steps = { hero, seal, refDesktop, refMobile, postcard };
const only = process.argv[2] || 'all';
for (const [name, fn] of Object.entries(steps)) {
  if (only === 'all' || only === name) {
    console.log(`\n== ${name} ==`);
    try { await fn(); }
    catch (e) { console.error(`CAPTURE ERROR [${name}]`, e.message); errors++; }
  }
}

await browser.close();
server.close();
console.log(`\npageerror/console-error total: ${errors}`);
process.exit(errors > 0 ? 1 : 0);
