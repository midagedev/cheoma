# HANDOFF — 2026-07-26 (필지·마당 규모)

세션 인계 기록. 한 세션이 끝나는 시점의 상태이며 **계약 문서가 아니다** — 계약과 충돌하면 계약이 우선한다.
읽는 순서: `CLAUDE.md`(프로젝트 계약) → 이 문서 → `docs/README.md`(문서 지도) → `docs/project-status.md`.

`main` 베이스 = **`ea13dbc`** (이전 인계 시점). 이 라운드 변경은 **미커밋** 작업 트리에 있다.
`npm run check` **66/66 PASS**. 워커 골든·브라우저 게이트·`check:full` 은 아직이다.

---

## 1. 이 세션에 무엇이 들어갔나 — §3.1 필지·마당 규모

사용자 지시(이월): *"마을 땅 크기 자체도 더 키우고 마당도 더 넓게… 집을 줄이는 것은 디테일이 줄어서 아쉽"*

### 핵심 구조 변경

| 파일 | 내용 |
| --- | --- |
| `src/village/parcels.js` | `LOT_W_SCALE`/`LOT_D_SCALE` 와 `STRUCTURE_SCALE` **분리**. 버킷 깊이 확대. 농촌 structureScale=1 |
| `src/village/site.js` | 농촌 `siteR` 확대(105/180/240/280, hanyang 500 유지). `tierForR` 중점 동기화 |
| `src/village/plan.js` | `HOUSE_ANCHORS`·`CHAR01_ANCHORS` 를 새 siteR 에 동기 |
| `src/temple/plan.js` | `templeVariantForSite` 임계를 새 tier 중점에 맞춤 |
| `src/village/guardian-plan.js` | 필수 보호수 탐색 반경 0.4R → 0.55R (실패 경로만) |
| `src/env/critter-plan.js` | 필지 확대 뒤 근접 커버리지 유지를 위해 지상 소동물 밀도·상한 소폭↑ |
| `tools/check-yard-proportion-contract.mjs` | 새 순수 게이트: 멍석 2.1m 하한, L/H 대역, structureScale=1, hamlet fit |
| `tools/plan-contract.json` | plan 골든 재기준선 |
| `docs/architectural-authenticity.md` §9.6 | 반영 결과 기록 |

### 왜 LOT 와 structure 를 분리했나

둘이 같으면 필지를 키워도 집 높이도 같이 커져 **L/H 가 불변**이다. 농촌은 집 축척 1, 필지만 키워 마당이 실제로 늘어나게 했다.

### 측정 (seed 7, 비-히어로) — 전 → 후

| 규모 | 유형 | 앞마당 전 | 앞마당 후 | L/H 후 | houseFit 전→후 |
| --- | --- | --- | --- | --- | --- |
| hamlet | 초가 | 2.6 m | **6.9 m** | ~3.0 | 0.83 → **0.94** |
| village | 기와 | **0.8 m** | **7.2 m** | ~1.9 | 0.97 → 0.98 |
| town | 기와 | 1.8 m | **8.1 m** | ~2.0 | ~1.0 |
| hanyang | 기와 | 3.5 m | **6.7 m** | ~2.0 | ~1.0 |

- **멍석 하한 2.1 m**: 전 규모·시드 통과 (`check:yard-proportion`)
- **별채**: 146/445 → **246/413** (포화 완화 — HANDOFF 인수 시험 통과)
- **마당 소품 폴리곤 이탈**: 0 유지
- village 기와 L/H ~1.9 는 관측 대역(1–3) 안. 상류 평균 2.55 에는 아직 못 미침(후속)

### 부작용으로 맞춘 게이트

- layout 밀도 바닥 (capital/hanyang 호수↓)
- house-diversity town 면적비 바닥 3.5 → 3.3
- critter full-detail 커버 바닥 0.70 → 0.55 (필지 간격↑)
- hamlet relief wavelength 33 → 36
- temple siteR 임계

---

## 2. 진행 중 — 없음 (구현은 완료, 머지 전 검증 남음)

작업 트리에 미커밋 diff 만 있다. 브랜치 분기는 하지 않았다.

---

## 3. 다음에 할 일

### 3.0 이 라운드 머지 전 (필수)

1. **워커 골든 재기준선** — `npm run check:worker` 가 plan/scene 해시로 실패할 것. 리베이스한 트리에서 값을 뽑을 것(이전 세션 교훈).
2. **브라우저 게이트** — 최소한 `check:app`, `check:lod:app` 또는 `check:pr` 가 고른 것. dry-run 은 verification infra 변경 때문에 `check:full` 로 닫힌다.
3. **커밋** — 리드가 게이트 경계에서. 제안 subject: `feat: larger rural parcels grow the yard, not shrink the house`
4. 부감에서 마을이 화면 65–75% 인지 한 컷 확인(siteR↑ 이라 프레이밍 비율은 유지돼야 함).

### 3.1 필지·마당 후속 (선택)

- village 기와 L/H 를 2.55 쪽으로 더 밀기 (깊이 버킷 또는 variant-이후 plotD 파생)
- 몸채 전면 배제(`parcelLocalBodyPolygon`) 재도입 — 별채가 이미 246 이라 ≥100 여유. 지붕·처마 아래 소품 허용 규칙
- capital 호수가 목표(104)에 못 미침(실측 ~36–57) — 도시 밀도 vs 마당 트레이드오프 제품 판단

### 3.2–3.5 (이전 인계, 미착수)

- DoF 틸트 + AA (`dof-layers` 브랜치)
- 위치성 효과음 앵커
- 기와 후속 4건
- 운무·클립 비트·프로그램 다이어트·한지 부유 발광·장독대 겹침 등

---

## 4. 아직 열려 있는 것

이전 인계 §4 유지. 추가로:

- **워커/씬 해시 재기준선** 미완
- **L/H 2.55 완전 수렴** 미완 (현재 ~1.9 village 기와)
- **몸채 배제 규칙** 미재도입

---

## 5. 작업 방식에서 값이 나간 것들

- **LOT_SCALE = structureScale 이면 마당 확대가 불가능** — 절대 스케일만 커지고 L/H 불변. 반드시 분리.
- **siteR 바꾸면 `tierForR`·`HOUSE_ANCHORS`·`CHAR01_ANCHORS`·temple 임계를 같이** 안 바꾸면 village 가 town 문법을 먹는다(이번 세션에서 한 번 밟음).
- 필지 확대 → 보호수·소동물 커버리지·밀도 게이트가 연쇄로 깨진다. 원인 단정은 노드 수치로.

---

## 6. 세션 로컬 산출물

측정: `node tools/measure-yard-proportion.mjs`, `npm run check:yard-proportion`.

---

## 7. 살아 있는 워크트리

| 워크트리 | 브랜치 | 상태 |
| --- | --- | --- |
| primary (`asiahouse`) | `main` | **dirty** — 이 라운드 미커밋. 정리·커밋 대기 |
| `dof-layers` | `dof-layers` | 대기 — DoF 틸트 + AA |
| 기타 agent-* | — | 머지 완료 유물, 정리 가능 |
