# 성능 캠페인 — 카메라 난사 + 집 편집 실시간

- **상태**: main #196–#201 머지 완료 · 추가 라운드 진행 (2026-07-27)
- **목표**: (1) 카메라를 거칠게 돌려도 프레임이 무너지지 않음 (2) 집 편집 슬라이더가 자연스럽게 실시간 (3) 정착 프레임 시각 품질 ≥ 현행
- **비목표**: WebGPU 메인 전환 (후순위 실험)

## 1차 측정 (구조 비용, post=0 고립 씬)

`node tools/shoot-cityperf.mjs village capital hanyang` (헤드리스 frame ms는 참고만):

| scale | houses | aerial calls / tris | eye calls / tris |
|---|---:|---:|---:|
| village | 35 | 852 / 3.7M | 852 / 3.7M |
| capital | 57 | 956 / 6.1M | 954 / 6.0M |
| hanyang | 301 | 906 / 3.3M (FAR 17) | 1136 / 3.6M |

관찰:

- draw call은 인스턴싱으로 이미 눌려 있음. 제품 경로 병목은 **후처리 fill + 편집 rebuild CPU**.
- 그림자 캐시는 정적 부감/오빗에서 이미 꺼짐(카메라만 움직일 때 shadow 재렌더 0).
- 보케 품질은 모션 시 0으로 내려감 — fill 해상도는 1차까지 고정이었다.

## 1차 구현 (커밋 `50ad3e7`)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Adaptive fill scale** | 카메라 moving/settling 중 composer pixel ratio ×0.78, stable에서 1.0. 모드 경계에서만 RT 재할당 | 정착 프레임 동일. 오빗 중 미세 해상도 하락(의도) |
| **Live preview warm skip** | 슬라이더 preview는 `rimRescan`만, `compileAsync`·focus ring 재부착은 commit | 정착 동일 |
| **Wall reuse** | yard signature + roof AABB 동일하면 담/부속채 메시 재사용 | 동일 |
| **Thatch-only fast path** | 초가 thatchAge만 바뀌면 텍스처 재적용, 지오 0 | 동일 |
| **Scheduler cadence** | min 24ms / max 80ms (이전 32/96) | — |
| **Screen-door compose** | LOD + instFade 로컬 변수 유일화·idempotent inject | 셰이더 재정의 버그 수정 |

브라우저 실측 (`check:parcel-rebuild:browser`, M1 Pro Chrome):  
`drag 21→8 previews`, threshold retained ~24ms, programs +0.

## 2차 구현 (capital chunk LOD)

| 항목 | 무엇 | 실측 (capital, post=0) |
|---|---|---|
| **minSiteR 340→260** | capital이 Hanyang과 같은 FAR/MID/FULL 스택 사용 | aerial **956→404 calls, 6.1M→1.0M tris** |

## 3차 구현 (부감 bloom + openings + 제품 벤치)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Aerial bloom half-res** | 부감/비focus는 bloom 반해상도, focus에서 풀 해상도 (compact는 항상 half) | 부감 헤이즈는 유지, 근경 bloom 풀 |
| **Openings-only wall keep** | structure signature 동일 시 roof AABB 검사 생략·담 재사용 확정 | 동일 |
| **Product path bench** | `npm run bench:product-path` — capital 오빗 fillScale + focus rebuild med | 구조 예산 계측 |

## 4차 구현 (house-only swap + town LOD + tighter scheduler)

| 항목 | 무엇 | 실측 |
|---|---|---|
| **Openings house-only swap** | 그룹/담 유지, house 메시만 교체 | openings preview **~15–22ms** |
| **town chunk LOD** | minSiteR 220 | town aerial **~1.1M tris** FAR stack |
| **movingFillScale 0.72** | 오빗 fill 더 공격적 | settle 시 1.0 복원 |
| **Scheduler 20/72/1.8** | 더 촘촘한 라이브 프리뷰 | browser cadence 동기화 |
| **Aerial MSAA 2×** | 부감 2× / focus 4× (desktop) | bench: aerial msaa 2, focus 4 |

## 5차 구현 (house-only shell path)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **House-only overlay** | openings + roof pitch/eave/curve/bays 등 야드 불변 편집 시 오버레이 그룹·matrix 유지, house 메시만 교체 | 동일 |
| **AABB-gated wall** | 새 지붕 AABB가 맞으면 담/부속채 유지, 어긋나면 제자리 wall rebuild (그룹 dispose 없음) | 동일 |
| **isResidentialHouseOnlyEdit** | 순수 시그니처 게이트로 openings를 포함해 shell 축을 포괄 | — |

## 6차 구현 (motion budget)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **motionBudget** | non-stable 모드에서 true (fillScale과 동일 경계) | 정착 시 false |
| **Outline sleep** | 오빗/settle 중 OutlinePass.enabled=false | 정착 후 호버 아웃라인 복원 |
| **Focus MSAA hold** | 모션 중 focus여도 MSAA 2× 유지, 정착 시 4× | 정착 프레임 동일 |

## 7차 구현 (flare motion sleep)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Flare motion sleep** | motionBudget 중 FlarePass.enabled=false (depth 뷰 스킵), product intent 보존 후 정착 복원 | 오빗 중 렌즈 플레어 일시 소실 → 정착 시 복원 |

## 8차 구현 (motion MSAA 0)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Motion MSAA off** | motionBudget 중 `setSamples(0)` — 멀티샘플 컬러 버퍼 해제. 정착 부감 2× / focus 4× 복원 | 오빗 중 계단 허용, 정착 동일 |

## Product-path bench (Chrome M1 Pro, post ON, capital/7)

`npm run bench:product-path` after #196–#198 stack:

| regime | med | notes |
|---|---:|---|
| aerial settle frame | 9.7 ms | fill 1, bloom ¼ beauty, msaa 2 |
| openings preview | 21 ms | house-only swap |
| roof-pitch preview | 24.4 ms | house-only + AABB-gated wall |
| commit (flora) | 66.8 ms | warm path |

## 9차 구현 (motion focus bloom half)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Motion bloom half** | focus여도 motionBudget 중 bloom을 aerial과 같이 beauty ¼ 해상도로 유지 | 오빗 중 헤이즈 약간 부드러움, 정착 시 full bloom |

## 10차 구현 (preview shadow defer)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **Thatch no dirty** | thatchAge 틴트는 caster 불변 → representationDirty 생략 | 동일 |
| **House-only preview** | 슬라이더 preview는 그림자 캐시 무효화 지연, commit(persist) 시 갱신 | preview 중 그림자 1메시 지연 가능, commit 정확 |

## 11차 구현 (fill 0.65)

| 항목 | 무엇 | 품질 영향 |
|---|---|---|
| **movingFillScale 0.65** | 오빗 중 픽셀 ~0.42× full DPR (0.72²→0.65²) | 정착 1.0 동일 |

## 다음 라운드 (우선순위)

1. grade half-res during motionBudget (look risk — measure first)
2. roofTone-only material re-tint without rebuild (giwa)
3. WebGPU/TSL 후처리 실험 브랜치 (메인 동결)

## 게이트

- `npm run check:dof` — fillScale 이진 계약
- `npm run check:live-edit` — scheduler + signature
- `npm run check:parcel-rebuild` / browser — 편집 트랜잭션
- `npm run check:pr` — 영향 라우팅

## 스펙 조정 허용 범위

- 오빗 중 해상도/보케 샘플 축소 허용 (정착 시 복원)
- 슬라이더 preview 중 flora/ring 지연 허용 (pointer-up commit)
- 숲·산 밀도 축소 금지 (look grammar)
- 림/블룸 제품 룩 삭제 금지
