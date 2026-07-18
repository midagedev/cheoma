// verify-solo.mjs — #114 외딴집(집 한 채)·절-단독 스케일 하한 검증 (plan 레벨, node 전용·무캡처)
//   실행: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/verify-solo.mjs
//   ① R=30 시드 스윕: 필지 정확히 1개 + 그 필지가 hero(hanok 종가)
//   ② R 스윕 30→74: 필지 수 1→10 단조(±1 허용), 전 구간 무예외
//   ③ 절 단독: houses:0 + includeTemple → 필지 0 + temple feature 존재
//   ④ 기존 앵커 카운트 불변(74/128/176/250/500) — check-determinism 과 별개의 명시 카운트 게이트
//   ⑤ 지형 하한: R=30 site 파생(ridgeH·benchDrop·undAmp)이 hamlet 보다 작고 유한
import { planVillage } from '../src/village/plan.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// ① R=30, 시드 24종
{
  let all1 = true, allHero = true, allHanok = true;
  for (let s = 1; s <= 24; s++) {
    const p = planVillage({ siteR: 30, seed: s * 7919 });
    if (p.parcels.length !== 1) { all1 = false; console.log(`  seed=${s * 7919}: parcels=${p.parcels.length}`); }
    else {
      if (!p.parcels[0].hero) allHero = false;
      if (p.parcels[0].heroStyle !== 'hanok') allHanok = false;
    }
  }
  ok(all1, '① R30 24시드: 필지 정확히 1');
  ok(allHero, '① R30 24시드: 유일 필지 hero=true');
  ok(allHanok, '① R30 24시드: heroStyle=hanok(종가)');
}

// ② R 스윕 30→74 (기본 시드)
{
  let prev = 0, mono = true, threw = null;
  const counts = [];
  try {
    for (let R = 30; R <= 74; R += 4) {
      const p = planVillage({ siteR: R });
      counts.push(`${R}:${p.parcels.length}`);
      if (p.parcels.length < prev - 1) mono = false;   // 검증 여유 ±1(배치 확률성)
      prev = p.parcels.length;
    }
  } catch (e) { threw = e; }
  ok(!threw, `② R스윕 30~74 무예외${threw ? ` (${threw.message})` : ''}`);
  ok(mono, `② R스윕 필지수 준단조 [${counts.join(' ')}]`);
}

// ③ 절 단독(houses:0 + includeTemple)
{
  const p = planVillage({ siteR: 40, houses: 0, includeTemple: true });
  ok(p.parcels.length === 0, `③ 절단독: 필지 0 (실측 ${p.parcels.length})`);
  ok(!!p.features?.temple, '③ 절단독: features.temple 존재');
  const p2 = planVillage({ siteR: 40, houses: 0, includeTemple: true });
  ok(JSON.stringify(p.features.temple) === JSON.stringify(p2.features.temple), '③ 절단독: 결정론(동일 시드 동일 절)');
}

// ④ 기존 앵커 필지 카운트 불변(#89 앵커 재현 — 하한 확장 전후 동일해야 함)
{
  const expect = { 74: 10, 128: 32, 176: 70, 250: 104, 500: 340 };
  for (const [R, n] of Object.entries(expect)) {
    const p = planVillage({ siteR: +R, seed: 20260716 });
    ok(p.opts.target === n, `④ R${R} 프론티지 target=${n} (실측 ${p.opts.target}, 총배치 ${p.parcels.length})`);
  }
}

// ⑤ 지형 하한 파생 유한·축소
{
  const p30 = planVillage({ siteR: 30 }), p74 = planVillage({ siteR: 74 });
  const s30 = p30.site, s74 = p74.site;
  ok(isFinite(s30.Hmax) && s30.Hmax > 0 && s30.Hmax < s74.Hmax, `⑤ R30 Hmax<${s74.Hmax?.toFixed?.(1)} (실측 ${s30.Hmax?.toFixed?.(1)})`);
  ok(s30.bowlR < s74.bowlR, `⑤ R30 bowlR<R74 (${s30.bowlR?.toFixed?.(1)} < ${s74.bowlR?.toFixed?.(1)})`);
}

console.log(fails === 0 ? '\nVERIFY-SOLO: ALL PASS' : `\nVERIFY-SOLO: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
