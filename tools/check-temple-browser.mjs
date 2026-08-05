// Standalone TemplePlan -> THREE lifecycle and render-budget gate. It serves the
// reusable root harness directly, so Svelte and the full village do not inflate
// the edit/renderer feedback loop.
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = resolve(ROOT, `.${pathname === '/' ? '/temple.html' : pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((resolveListen, reject) => {
  server.listen(0, '127.0.0.1', resolveListen).on('error', reject);
});

const port = server.address().port;
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const variants = ['compact', 'courtyard', 'extended'];
// 마을의 절은 mountain 으로 계획된다(village/temple-plan.js). flat 만 재면 단·석축이
// 렌더되지 않으므로 병합 콜 상한이 제품 경로를 재지 못한다 — 두 프로파일 모두 잰다.
const profiles = ['flat', 'mountain'];
const diagnostics = new Map();
const captureDir = process.env.CHEOMA_TEMPLE_CAPTURE_DIR || '';
const captureSeed = Number.parseInt(process.env.CHEOMA_TEMPLE_CAPTURE_SEED || '122', 10) >>> 0;
try {
  for (const variant of variants) {
    for (const profile of profiles) {
    for (const merged of [false, true]) {
      const label = `${variant}:${profile}:${merged ? 'merged' : 'raw'}`;
      const url = `http://127.0.0.1:${port}/temple.html?variant=${variant}&profile=${profile}&shot=1&probe=1${merged ? '&merged=1' : ''}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.templeReady === 'true', null, { timeout: 45000 });
      const diag = await page.evaluate(() => JSON.parse(document.getElementById('app').dataset.templeDiag));
      diagnostics.set(label, diag);

      invariant(diag.variant === variant && diag.merged === merged && diag.profile === profile,
        `${label}: wrong render mode`);
      invariant(diag.issues.length === 0, `${label}: ${diag.issues.join('; ')}`);
      invariant(diag.camera.fov === 26 && diag.camera.southOffset > 0,
        `${label}: focus camera is not on the south-facing telephoto approach`);
      invariant(diag.renderedBounds.x <= diag.size.width + 2.5,
        `${label}: rendered width escaped the reserved precinct`);
      invariant(diag.renderedBounds.z <= diag.size.depth + 2.5,
        `${label}: rendered depth escaped the reserved precinct`);
      invariant(diag.architecture.length === diag.counts.buildings,
        `${label}: renderer lost planned hall architecture records`);
      const main = diag.architecture.find((hall) => hall.role === 'main-hall');
      invariant(main?.architecturalRank === 4
          && diag.architecture.every((hall) => hall.role === 'main-hall' || hall.architecturalRank < 4),
      `${label}: principal worship-hall rank is not unique`);
      for (const hall of diag.architecture) {
        invariant(hall.architectureId && hall.roof && hall.bracket,
          `${label}:${hall.id}: incomplete renderer grammar`);
        if (hall.architecturalRank === 4) {
          const principalPair = `${hall.architectureId}:${hall.roof}:${hall.bracket}`;
          invariant([
            'principal-matbae-dapo:matbae:dapo',
            'principal-paljak-jusimpo:paljak:jusimpo',
          ].includes(principalPair), `${label}:${hall.id}: unsupported principal pairing ${principalPair}`);
        }
        invariant(hall.eave.renderedWidth >= hall.eave.plannedWidth - 0.1
            && hall.eave.renderedWidth <= hall.eave.plannedWidth + 0.9
            && hall.eave.renderedDepth >= hall.eave.plannedDepth - 0.1
            && hall.eave.renderedDepth <= hall.eave.plannedDepth + 0.9,
        `${label}:${hall.id}: rendered roof drifted from planned eave ${JSON.stringify(hall.eave)}`);
      }
      // 주불전 무자 현판: the renderer must actually build the plan-owned board on
      // the principal hall's front face, inside the 창방/공포대 band, with borrowed
      // palette materials. A source-level check is not enough — an unwired
      // renderer keeps the call site and still draws nothing.
      invariant(diag.plaques.length === 1,
        `${label}: expected exactly one rendered principal-hall plaque, got ${diag.plaques.length}`);
      const plaque = diag.plaques[0];
      invariant(plaque.hostRank === 4 && plaque.hostRole === 'main-hall',
        `${label}: plaque host is not the principal worship hall (${plaque.hostRole}/${plaque.hostRank})`);
      invariant(plaque.meshes === 5 && plaque.lettering === 'none' && !plaque.ownTexture,
        `${label}: plaque is not the 5-part uninscribed board ${JSON.stringify(plaque)}`);
      invariant(plaque.borrowedBoard && plaque.borrowedMolding,
        `${label}: plaque stopped borrowing the hall palette (board/molding)`);
      // 처마 그늘에는 환경맵이 없다: metalness는 스페큘러 이득 없이 디퓨즈만 깎아 판을
      // 계조 없는 검은 클램프로 만든다 (2026-08-05 비전 FIX의 실제 원인).
      invariant(plaque.boardMetalness === 0 && plaque.moldingMetalness === 0,
        `${label}: plaque borrowed a metallic material (board ${plaque.boardMetalness},`
        + ` molding ${plaque.moldingMetalness})`);
      invariant(plaque.frontDot > 0.5,
        `${label}: plaque is not on the hall's south front face (frontDot ${plaque.frontDot})`);
      invariant(plaque.localTopY <= plaque.bracketBaseY - 0.02
          && plaque.localTopY >= plaque.columnTopY + 0.25
          && plaque.localTopY < plaque.eaveEdgeY,
      `${label}: rendered plaque left the 창방-above / 공포대-below eave band ${JSON.stringify(plaque)}`);
      invariant(Math.abs(plaque.world.width - plaque.plannedWorld.width) < 0.02
          && Math.abs(plaque.world.height - plaque.plannedWorld.height) < 0.02,
      `${label}: rendered plaque drifted from the planned size ${JSON.stringify(plaque)}`);
      invariant(diag.lifecycle.first && !diag.lifecycle.second && diag.lifecycle.owned,
        `${label}: disposal is not successful and idempotent`);
      invariant(diag.lifecycle.sharedGeometryDisposed === 1, `${label}: caller-palette geometry leaked`);
      invariant(diag.lifecycle.callerMaterialDisposed === 0, `${label}: caller-owned palette was disposed`);
      invariant(diag.lifecycle.ownedMaterialDisposed === 1, `${label}: owned palette was not disposed`);
      // ── 단(段)·막돌 석축 계약 (2026-08-05, refs/temple-old 구조 대조 라운드) ─────────
      // 갭 ③⑤(docs/temple-generator.md §9): 종전에는 전각이 한 높이로 깔리고 균일한 사각
      // precinct-wall 이 남아 "소규모 궁"으로 읽혔다. 아래 단언 전부 FAIL-first 확인:
      // `applyTempleTerraces()` 를 no-op 으로 되돌리면 `diag.terraces` 가 null 이 되어
      // 첫 단언에서 실제로 깨진다(이 라운드에서 직접 확인).
      const terraces = diag.terraces;
      invariant(terraces && terraces.profile === profile,
        `${label}: terrace record missing or profile drifted ${JSON.stringify(terraces)}`);
      if (profile === 'flat') {
        // 평지 가람은 단을 만들지 않는다 — 진입 계약이 `single-run` 계단이라 단차와 충돌한다.
        invariant(terraces.tierCount === 1 && terraces.risers.length === 0 && terraces.rise === 0,
          `${label}: flat precinct grew terraces ${JSON.stringify(terraces)}`);
        invariant(diag.buildingLifts.every((lift) => lift.elevation === 0),
          `${label}: flat precinct lifted halls`);
        invariant(diag.enclosureShapes.every((shape) => shape.closed),
          `${label}: flat precinct wall stopped being a closed loop`);
      } else {
        const expectedTiers = variant === 'compact' ? 2 : 3;
        invariant(terraces.tierCount === expectedTiers,
          `${label}: ${terraces.tierCount} terraces != ${expectedTiers}`);
        invariant(terraces.risers.length === expectedTiers - 1,
          `${label}: ${terraces.risers.length} risers != ${expectedTiers - 1}`);
        // 주불전은 가람의 정점이므로 최고단·최북단에 앉는다(장안사 1930).
        const top = terraces.tiers[0];
        const mainLift = diag.buildingLifts.find((lift) => lift.id === 'main-hall');
        invariant(mainLift?.terraceLevel === top.level && mainLift.elevation === top.elevation,
          `${label}: main hall is not on the highest terrace ${JSON.stringify(mainLift)}`);
        // 단은 남 → 북으로 단조 상승하고 z 대역이 겹치지 않는다.
        for (let index = 1; index < terraces.tiers.length; index++) {
          const previous = terraces.tiers[index - 1];
          const current = terraces.tiers[index];
          invariant(current.elevation < previous.elevation - 1e-6
            && current.northZ >= previous.southZ - 1e-6,
          `${label}: terrace stack is not monotonic ${previous.id}/${current.id}`);
        }
        // 막돌: 상단선이 오르내려야 한다. topSpread 0 이면 정연한 켜쌓기로 읽힌다.
        for (const riser of terraces.risers) {
          invariant(riser.segments >= 2 && riser.topSpread > 0.02,
            `${label}: ${riser.id} rubble top is regular coursing ${JSON.stringify(riser)}`);
          invariant(Math.abs(riser.stairOffset) > 1e-6 && Math.abs(riser.stairOffset) <= 0.7,
            `${label}: ${riser.id} stair is dead-centred or off the axis band ${riser.stairOffset}`);
        }
        // 산지 외곽 담: 최상단 단이 담을 삼키는 규모에서만 진입부를 감싸는 열린 run 이
        // 된다. compact 암자는 단 1.02m < 담 1.75m 라 폐곡선 담이 그대로 성립하므로
        // 여기서 variant 별 기대를 명시한다(구현식을 게이트가 되풀이하지 않도록).
        const outer = diag.enclosureShapes.find((shape) => shape.id === 'outer-precinct');
        const shouldOpen = variant !== 'compact';
        invariant(outer && outer.closed !== shouldOpen
          && outer.gateSeg === (shouldOpen ? 1 : 0),
        `${label}: precinct wall shape wrong (expected ${shouldOpen ? 'open run' : 'closed loop'})`
          + ` ${JSON.stringify(outer)}`);
        // 렌더까지 실제로 도달했는지(병합 전에만 노드가 남는다).
        if (!merged) {
          invariant(diag.renderedTerraceNodes.tiers === expectedTiers
            && diag.renderedTerraceNodes.risers === 1,
          `${label}: renderer dropped terrace geometry ${JSON.stringify(diag.renderedTerraceNodes)}`);
        }
      }

      const programBudget = merged ? 7 : 12;
      invariant(diag.render.programs <= programBudget && diag.render.materials <= 72,
        `${label}: program/material budget drifted ${JSON.stringify(diag.render)}`
        + ` (program budget ${programBudget})`);
      invariant(diag.render.palaceOrnaments === 0,
        `${label}: palace-only roof ornaments leaked into a temple grammar`);
      // 병합 콜 상한 140 → 142 (2026-08-05, 주불전 현판 비전 FIX).
      //   판정 근거: 현판 바탕이 차입한 `hardware`는 병합 그룹을 늘리지 않는 대신 metalness
      //   0.42를 함께 가져왔고, 환경맵이 없는 처마 그늘에서 그것은 스페큘러 이득 0 · 디퓨즈
      //   −42% 순손실이라 판 내부가 계조 없는 검은 클램프로 떨어졌다(비전: "현판이 아니라 구멍").
      //   무광 판벽(`planwall`, metalness 0)으로 바꾸는 것이 유일한 무클론 해법이고, 그 대가로
      //   전각 팔레트에 아직 그려지지 않던 재질 하나가 병합 그룹으로 추가된다.
      //   정당한 파생: 신규 재질 그룹 하나의 실측 비용은 정확히 2콜 — 컬러 패스 1 + 그림자 패스
      //   1(같은 실행에서 raw가 mesh 5개에 +10콜로 움직인 것과 같은 배수). 따라서 상한은
      //   140 + 2 = 142이며, 이는 승인된 재질 그룹 하나만큼이고 여유분이 아니다.
      //   실측(Chrome/M1 Pro): compact 97→99, courtyard 113→115, extended 139→141.
      //   FAIL-first ①: 상한을 종전 140으로 두면 extended 141이 이 단언을 실제로 깬다 —
      //   142는 여유분이 아니라 실측 프런티어다.
      //   FAIL-first ②: 승인되지 않은 두 번째 재질 그룹(몰딩을 `onggi`로)을 넣으면
      //   extended가 143으로 이 단언을 깬다 — 재핀된 상한은 여전히 물린다.
      //   계측 주의: 같은 실험을 `woodBoard`로 하면 콜이 움직이지 않는다 — 맞배 부속 전각이
      //   이미 그리는 재질이라 새 그룹이 아니다. "새 재질 = +2콜"은 재질 목록이 아니라
      //   그 경내가 실제로 그리는 집합을 기준으로 판단해야 한다.
      if (merged) invariant(diag.render.calls <= 142, `${label}: ${diag.render.calls} merged draw calls exceed 142`);
      console.log(`${label.padEnd(26)} calls=${String(diag.render.calls).padStart(4)}`
        + ` tris=${diag.render.triangles} programs=${diag.render.programs} materials=${diag.render.materials}`
        + ` tiers=${diag.terraces?.tierCount ?? '-'}`);
    }
    }
  }

  for (const variant of variants) {
    for (const profile of profiles) {
      const raw = diagnostics.get(`${variant}:${profile}:raw`);
      const merged = diagnostics.get(`${variant}:${profile}:merged`);
      invariant(raw.render.triangles === merged.render.triangles, `${variant}:${profile}: merge changed triangle content`);
      invariant(merged.render.calls <= raw.render.calls * 0.15,
        `${variant}:${profile}: merge reduced ${raw.render.calls} calls by less than 85%`);
      invariant(JSON.stringify(raw.counts) === JSON.stringify(merged.counts), `${variant}:${profile}: semantic counts drifted`);
    }
  }

  await page.goto(
    `http://127.0.0.1:${port}/temple.html?variant=courtyard&shot=1&merged=1&schema=1`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => document.documentElement.dataset.templeReady === 'true', null, { timeout: 45000 });
  const legacy = await page.evaluate(() => JSON.parse(document.getElementById('app').dataset.templeDiag));
  const canonical = diagnostics.get('courtyard:flat:merged');
  invariant(legacy.inputSchemaVersion === 1 && legacy.schemaVersion === 2,
    `legacy TemplePlan did not cross the v1→v2 input boundary: ${JSON.stringify({
      input: legacy.inputSchemaVersion, output: legacy.schemaVersion,
    })}`);
  invariant(JSON.stringify(legacy.architecture) === JSON.stringify(canonical.architecture),
    'legacy TemplePlan rendered a different hall architecture after upgrade');
  invariant(JSON.stringify(legacy.plaques) === JSON.stringify(canonical.plaques),
    'legacy TemplePlan lost or moved the principal-hall plaque after upgrade');
  invariant(legacy.render.calls === canonical.render.calls
      && legacy.render.triangles === canonical.render.triangles
      && legacy.render.programs === canonical.render.programs
      && legacy.render.materials === canonical.render.materials,
  `legacy TemplePlan changed the deterministic render budget: ${JSON.stringify(legacy.render)}`);
  const unsupportedSchema = await page.evaluate(async () => {
    const { buildTempleCompound, planTempleCompound } = await import('/src/api/temple.js');
    const plan = planTempleCompound({ variant: 'compact', seed: 122 });
    try {
      buildTempleCompound({ ...plan, schemaVersion: 99 });
      return null;
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  });
  invariant(unsupportedSchema?.name === 'RangeError'
      && unsupportedSchema.message.includes('unsupported TemplePlan schemaVersion 99'),
  `renderer boundary did not reject a future TemplePlan schema: ${JSON.stringify(unsupportedSchema)}`);

  if (captureDir) {
    await mkdir(captureDir, { recursive: true });
    for (const variant of variants) for (const view of ['focus', 'aerial']) {
      await page.goto(
        `http://127.0.0.1:${port}/temple.html?variant=${variant}&seed=${captureSeed}&shot=1&view=${view}`,
        { waitUntil: 'load' },
      );
      await page.waitForFunction(() => document.documentElement.dataset.templeReady === 'true', null, { timeout: 45000 });
      await page.screenshot({ path: resolve(captureDir, `${variant}-${view}-seed-${captureSeed}.png`) });
    }
    console.log(`temple captures=${resolve(captureDir)} seed=${captureSeed}`);
  }
  await reportWebGLRenderer(page, 'temple');
  invariant(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  invariant(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
  console.log('TEMPLE BROWSER: PASS (3 variants, lifecycle, south camera, raw/merged parity)');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
