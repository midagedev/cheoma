import { planVillage } from '../../village/plan.js';
import { populateVillage, populateVillageSteps } from '../../village/populate.js';
import { createVillageRandomWindow, resolveVillageSeed } from './random-window.js';
import { crunchForestInWorker, forestWorkerAllowed } from './forest-worker-client.js';
import { createVillageHandle } from './handle.js';

export function createVillage(opts = {}) {
  const seed = resolveVillageSeed(opts.seed);
  const runSeeded = createVillageRandomWindow(seed);
  let plan;
  let group;
  runSeeded(() => {
    plan = planVillage({ ...opts, seed });
    group = populateVillage(plan);
  });
  return createVillageHandle(opts, seed, plan, group);
}

// plan과 populate generator의 각 slice만 seeded window에 넣는다. slice 사이의 render loop는 원래
// Math.random을 쓰되, 동일 RNG closure를 재사용하므로 sync와 소비 순서가 byte-identical하다.
export function createVillageAsync(opts = {}, { onStep, budgetMs = 8, nextFrame } = {}) {
  const seed = resolveVillageSeed(opts.seed);
  const runSeeded = createVillageRandomWindow(seed);
  const schedule = nextFrame || (typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 0));

  const forestCrunch = { value: null };
  const usesWorker = forestWorkerAllowed();
  let workerFailed = false;
  if (usesWorker) {
    crunchForestInWorker(opts, seed).then(
      (result) => { forestCrunch.value = result; },
      () => { workerFailed = true; },
    );
  }

  return new Promise((resolve, reject) => {
    let plan = null;
    let steps = null;
    let stepIndex = 0;
    let lastLabel = null;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function runSlice() {
      try {
        const startedAt = now();
        if (!plan) {
          runSeeded(() => { plan = planVillage({ ...opts, seed }); });
          steps = populateVillageSteps(plan, { forestCrunchRef: forestCrunch });
          onStep?.('plan', stepIndex++);
          if (now() - startedAt < budgetMs) return runSlice();
          schedule(runSlice);
          return;
        }

        let result = { done: false };
        do {
          // 다음 generator step이 forest 조립이면 worker buffer가 도착할 때까지 메인 thread를 양보한다.
          if (lastLabel === 'trees' && usesWorker && !forestCrunch.value && !workerFailed) {
            schedule(runSlice);
            return;
          }
          result = runSeeded(() => steps.next());
          if (!result.done) {
            lastLabel = result.value;
            onStep?.(result.value, stepIndex++);
          }
        } while (!result.done && now() - startedAt < budgetMs);

        if (result.done) {
          resolve(createVillageHandle(opts, seed, plan, result.value));
          return;
        }
        schedule(runSlice);
      } catch (error) {
        reject(error);
      }
    }

    schedule(runSlice);
  });
}
