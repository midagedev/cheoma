# 산사(山寺) 재배치 작업 브리프

> - **상태**: 착수 전 / 구현 준비 완료
> - **브리프 기준 커밋**: `5ca668e` — 시작할 때 현재 `HEAD`와 다시 대조
> - **구현 범위**: `src/village/plan.js`, `src/generators/village/features.js`, `src/village/forest-crunch.js`
> - **커밋 정책**: 구현은 워킹 트리에 남겨 사람 리뷰를 받는다. 별도 지시 없이 커밋하지 않는다.
> - **관련 문서**: [`docs/project-status.md`](docs/project-status.md), [`docs/verification.md`](docs/verification.md), [`docs/joseon-city.md`](docs/joseon-city.md#5-산지-사찰-가람)

이 문서는 Claude Code 메모리의 `temple-hillside-placement`, `relief-pads-harness`, `village-algorithm`, `village-worker-offload`, `forest-keep-worker-not-cut`, `terrain-extent-budget`, `vite-worker-hmr-staleness`와 폐기된 1차 구현에서 얻은 난점을 현재 코드와 대조해 합친 자립형 브리프다. 구현에 개인 메모리나 `/private/tmp` 파일이 필요하지 않다.

## 0. 시작 순서와 우선순위

1. 루트 [`AGENTS.md`](AGENTS.md)와 [`docs/README.md`](docs/README.md)를 읽는다.
2. `git status --short`와 현재 `HEAD`를 확인한다. 기존 사용자 변경을 보존한다.
3. 아래 세 대상 함수와 `tools/shoot-templesite.mjs`의 현재 내용을 다시 확인한다.
4. 같은 코드·시드·`mode=current`로 before 수치와 이미지를 저장한 뒤 구현한다.

충돌 시 현재 코드와 실행 결과가 우선이고, 의도는 `AGENTS.md` → 이 브리프 → 설계 리서치 순으로 해석한다. 범위 밖 리팩터나 신규 기능 확장은 하지 않는다.

## 1. 문제와 확정 방향

사용자 피드백은 “절이 산 중턱에 턱하니 얹혀 이상하다. 지형을 자연스럽게 다듬고 길을 만들거나 마을에 붙이는 편이 낫다”는 것이다.

확정 방향은 **마을 편입이 아닌 제대로 된 산사**다. 산기슭의 평탄한 자리에 안착시키고, 숲이 감싸게 하며, 짧은 진입로로 마을과 연결한다.

현재 잔여 문제는 세 가지다.

1. `templeCap`을 최대 18m로 올린 결과, 절 앞에 큰 회색 단일 축대 선반이 생긴다.
2. 절 중심 32m 원형 tree/rock clearing이 산에 민둥 후광을 만든다.
3. 마을 도로와 연결이 없고 높은 외곽 사면에 떨어져 있어 고립감이 강하다.

## 2. 현재 코드에서 확인된 사실

### `src/village/plan.js`

- `planVillage`는 도로를 3단계, 필지를 4단계에서 확정하고 절을 9단계에서 배치한다. 즉 절 배치 시 `roadsResult.roads`와 `parcels`를 이미 사용할 수 있다.
- `placeTemple(site, seed)`는 `er=0.50..0.70`, 목표 `0.60`, 반경 `0.55R..1.00R`, 측면 각도 `0.34..0.52π`를 스캔한다.
- 점수는 `-slope*3.0 + backdrop*0.35 - |er-0.60|*Hmax*0.30 - edge`다.
- 좌우 선택과 절 seed는 입력 seed에서 파생하며 공유 rng를 소비하지 않는다. 이 규약을 유지해야 절 OFF 회귀가 안전하다.
- 반환 계약 `{x, z, frontDir, seed}`는 pick proxy가 사용한다. `path` 추가는 허용하지만 기존 필드는 유지한다.

### `src/generators/village/features.js`

- `buildFeatureObjects(plan, site, ...)`는 `plan`을 받지만 절 빌더에는 `T=plan.features.temple`과 `site`만 넘긴다. 경로를 `T.path`에 두면 추가 plan 의존 없이 사용할 수 있다.
- `buildTempleCluster`는 30×30m compound와 33×33m pad를 만들며 `templeCap=min(18,max(5,Hmax*0.16))`를 사용한다.
- `buildPadRect`는 `padY=min(maxCorner, lo+cap)+PAD_LIFT`다. `emitPad`는 `padY`보다 낮은 쪽에 성토 스커트만 만들며 실제 지형을 깎지 않는다.

### `src/village/forest-crunch.js`

- `makeTreeMask(plan, site)`의 절 clearing은 중심 반경 32m 원이다. tree와 granite가 같은 mask를 공유한다.
- `makeClearance`에는 절 중심과 회전된 33m footprint 모서리가 들어간다.
- 이 모듈은 worker와 메인 동기 경로가 공유하므로 `features.temple`처럼 plan에 직렬화된 데이터만 읽어야 한다.
- `warpInner`와 지형 샘플러 식은 worker/sync 결정론 계약이므로 이번 작업에서 건드리지 않는다.

### 기준 수치

`tools/shoot-templesite.mjs`, `mode=current`의 브리프 작성 당시 값이다.

| 규모 | 위치 | 표고 | footprint 낙차 | backdrop | calls |
| --- | --- | --- | --- | --- | --- |
| village, R=128/H=68 | `xf=-0.93`, `zf=-0.05` | `er=0.602`, `gy=40.9` | `6.2m` | `27.0m` | 858 |
| capital, R=250/H=124 | `xf=-0.78`, `zf=-0.13` | `er=0.568`, `gy=70.4` | `30.9m` | `54.8m` | 1247 |

시작 전 같은 조건으로 다시 측정한다. 하네스의 `mode=old`는 #94 이전 급벽 재현이므로 이번 작업의 before가 아니다.

## 3. 구현 계약

### A. 산기슭의 평탄한 벤치 선택

`placeTemple`이 도로와 필지를 함께 보도록 입력을 확장한다.

- 목표 표고는 대략 `er=0.30..0.50`, 중심 `0.40`으로 낮춘다. 전 규모에서 후보가 부족하면 상단을 약 `0.55`까지 완화할 수 있다.
- 반경은 대략 `0.45R..0.72R`로 안쪽에 둔다. `terrainR` 안전 클램프는 유지한다.
- 각도·반경 샘플 수를 늘려 단일 시드가 아닌 전 규모에서 평탄 후보를 찾는다.
- 33m footprint 낙차에 강한 페널티를 주고, 가능한 후보에서는 약 8–9m 이하를 선호한다.
- 북쪽 능선이 뒤로 솟는 backdrop 보상은 유지한다.
- 회전된 절 footprint와 필지 polygon, 도로 폭+마진이 겹치는 후보는 제외한다.
- strict 후보가 없을 때의 폴백도 seed 파생·결정론적이어야 하며, 왜 완화됐는지 진단 가능해야 한다.

### B. plan 단계의 진입로

`features.temple.path = [{x,z}, ...]`를 plan에서 만든다.

- 시작점은 일주문 앞변, 대략 `temple center + frontDir * 15m`다.
- 종점은 가장 가까운 마을 도로 polyline 위의 최근접점이다.
- 도로가 없으면 가장 가까운 필지 변, 그것도 없으면 `site.center` 방향의 짧은 고정 길이 경로를 쓴다.
- 경로는 지형에 drape할 수 있도록 촘촘히 샘플하고, 완만한 굴절을 주되 건물·필지를 관통하지 않는다.
- 새 `Math.random` 소비를 만들지 않는다. 변주가 필요하면 `T.seed`에서 파생한다.
- 절 OFF일 때 path 계산도 실행하지 않는다.

### C. 낮고 자연스러운 대지와 진입로 메시

- 평탄 후보는 대략 `min(8,max(4,Hmax*0.08))` 수준의 낮은 cap으로 처리한다.
- footprint 낙차가 불가피하게 큰 후보는 하나의 거대한 전면 벽 대신 2–3단의 좁은 석축으로 나눈다.
- 실제 heightfield를 전역 변경하지 않는다. 필요하면 산쪽 절토면처럼 읽히는 짧은 마감면을 pad 내부에서 처리한다.
- 낮은 cap 때문에 대웅전 뒷면이 지형에 파묻히지 않는지 각 규모에서 확인한다.
- `T.path`를 따라 폭 약 2.5m의 흙/돌 리본을 `site.heightAt`에 drape한다. z-fight 방지용 작은 lift를 둔다.
- 급경사 구간에만 이산 돌계단 또는 가로 단을 넣는다.
- 기존 `padStoneMat`/`padTopMat` 계열을 재사용하고, 경로 전체의 신규 드로우콜은 최대 2다.

### D. 숲 프레이밍

- 중심 32m 원형 clearing을 footprint+소폭 마진, 대략 반경 22–24m 수준으로 줄인다.
- 건물·담장·석축을 큰 수관이 관통하지 않는 최소 마진은 유지한다.
- `T.path`를 따라 반폭 약 4m의 가는 clearing을 추가한다.
- `makeTreeMask` 한 곳에서 tree와 granite를 함께 처리하고 plan 데이터만 읽는다.
- 숲 수 자체를 성능 이유로 줄이지 않는다. 산 전체의 인스턴스 숲 유지 결정은 불변이다.

## 4. 평탄 벤치와 낮은 대지의 충돌 처리

폐기된 1차 시도에서 특정 seed의 낮고 clear한 후보가 급경사여서 낮은 cap과 충돌했다. 단일 seed에 상수를 맞추지 말고 다음 순서로 해결한다.

1. 각도·반경 샘플을 넓히고 필지/도로 clearance를 포함해 strict 평탄 후보를 먼저 찾는다.
2. strict 후보가 없으면 표고 상단을 소폭 완화해 평탄성과 마을 접근성을 우선한다.
3. 그래도 낙차가 크면 cap을 무작정 키우지 말고 다단 석축으로 높이를 분산한다.
4. 마지막 폴백은 결정론적으로 선택하고 진단에 폴백 여부와 실제 낙차를 남긴다.

hamlet부터 hanyang까지 여러 seed에서 이 순서를 확인한다. village 한 시드의 목표 수치만 통과한 구현은 완료가 아니다.

## 5. 결정론과 성능 불변식

- worker, 동기 `createVillage`, async의 worker=0 폴백은 관련 plan과 forest 버퍼가 byte-identical이어야 한다.
- worker가 읽는 path와 mask 입력은 반드시 plan 단계에서 만들어야 한다.
- multi-frame seed window와 전역 `Math.random` 복원 규약을 바꾸지 않는다.
- 절 OFF 경로는 이 변경 전과 같은 plan을 만들어야 한다.
- `features.temple`의 기존 네 필드는 유지한다.
- village 렌더 calls는 1000 미만, 진입로 신규 calls는 2 이하다.
- 지형 반경을 늘려 문제를 숨기지 않는다.

## 6. 검증

전체 원칙과 하네스 한계는 [`docs/verification.md`](docs/verification.md)를 따른다.

### 문법

```bash
npx esbuild src/village/plan.js --bundle --format=esm --outfile=/dev/null
npx esbuild src/generators/village/features.js --bundle --format=esm --outfile=/dev/null
npx esbuild src/village/forest-crunch.js --bundle --format=esm --outfile=/dev/null
```

### 산사 수치와 이미지

같은 명령을 구현 전후에 사용한다. 아래는 before용 이름이며, 구현 후에는 이름의 `before`를 `after`로 바꿔 기존 이미지를 보존한다. 기본 `shots/`는 Git에서 제외돼 있다.

```bash
SHOTS='[
  ["sansa-before-village-aerial","scale=village&seed=20260716&mode=current&view=aerial"],
  ["sansa-before-village-focus","scale=village&seed=20260716&mode=current&view=focus"],
  ["sansa-before-capital-aerial","scale=capital&seed=1234&palace=1&mode=current&view=aerial"],
  ["sansa-before-capital-temple","scale=capital&seed=1234&palace=1&mode=current&view=temple"],
  ["sansa-before-town-seed77","scale=town&seed=77&mode=current&view=aerial"],
  ["sansa-before-hanyang-seed7","scale=hanyang&seed=7&palace=1&mode=current&view=aerial"],
  ["sansa-before-anchor-off","scale=village&seed=20260716&mode=current&view=aerial&temple=0"]
]' node tools/shoot-templesite.mjs
```

목표는 village에서 대략 `er=0.30..0.50`, 중심 반경 `|xf|≈0.5..0.7`, footprint 낙차 약 9m 이하다. 지형에 따라 상충하면 수치를 숨기지 말고 폴백과 다단 처리 이유를 보고한다. `pageerror=0`, `console-error=0`, village calls `<1000`을 확인한다.

생성 PNG를 직접 열어 다음을 본다.

- 대웅전 뒷면이 산에 파묻히지 않는다.
- 전면에 하나의 거대한 회색 선반이 없다.
- 나무가 절을 감싸지만 건물과 진입로를 관통하지 않는다.
- 길이 일주문에서 실제 마을 도로까지 시각적으로 이어진다.

### 회귀와 결정론

```bash
npm run check
node tools/verify-solo.mjs
npm run check:worker
```

`verify-solo.mjs`는 보조 게이트일 뿐 worker-vs-sync 전체 일치를 증명하지 않는다. `npm run check:worker`가 sync / 실제 module Worker / `?worker=0` fallback의 전체 scene과 pick proxy 골든 hash를 영구적으로 비교한다. 산사 구현은 temple ON 골든 변경을 검토해 의도적으로 갱신하되 temple OFF plan 골든을 유지한다. worker만 실패하면 하네스가 새 임시 Vite `cacheDir`를 쓰는지 확인한 뒤 재검증한다.

## 7. 완료 보고 계약

최종 보고에는 다음을 포함한다.

1. 파일별 변경 함수와 핵심 상수의 old → new.
2. village와 capital을 포함한 before/after `xf`, `er`, footprint 낙차, backdrop, calls.
3. 추가 seed/scale의 폴백 발생 여부.
4. sync / worker / worker=0 해시와 MATCH/MISMATCH, 정확한 실행법.
5. 생성 PNG의 절대 경로와 에이전트 시각 점검 결과, 사람이 다시 판단할 항목.
6. 평탄 벤치와 낮은 cap 충돌을 어떻게 풀었는지, 스펙에서 벗어났다면 이유.

## 8. 완료 기록

아직 구현되지 않았다. 작업이 끝나면 날짜, 최종 커밋 전 작업 트리 상태, 게이트 결과, 사람 리뷰 결론을 이 절에 추가한다.
