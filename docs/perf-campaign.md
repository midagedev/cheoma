# 성능 캠페인 — 카메라 난사 + 집 편집 실시간

- **상태**: 진행 중 (2026-07-26 1차 착수)
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

## 다음 라운드 (우선순위)

1. 제품 경로 브라우저 하네스: focus orbit + rebuild med ms + `postFillScale` 판독
2. openings-only / roof-pitch 전용 부분 리빌드 계측 후 더 쪼개기
3. town(R≈240) chunk LOD 검토 (룩 게이트 통과 시에만)
4. WebGPU/TSL 후처리 실험 브랜치 (메인 동결)

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
