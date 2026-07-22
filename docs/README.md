# cheoma 문서 지도

이 디렉터리의 문서는 모두 같은 종류가 아니다. 구현 계약, 설계 리서치, 특정 시점의 판단 기록을 구분하지 않으면 오래된 기획을 현재 코드의 사실로 오해하기 쉽다. 작업을 시작할 때는 아래 순서와 상태를 기준으로 읽는다.

## 먼저 읽을 것

1. [`AGENTS.md`](../AGENTS.md) — 코드 경계, 핵심 아키텍처, 결정론·성능 불변식, 기본 명령.
2. 이 문서 — 어떤 문서가 현재 계약이고 어떤 문서가 참고 자료인지 확인.
3. [`project-status.md`](project-status.md) — 현재 마무리 방향, 활성 작업, 유지·보류 결정.
4. [`architecture-refactor.md`](architecture-refactor.md) — 현재 진행 중인 구조 개선의 목표 레이어와 마이그레이션 순서.
5. 작업별 계약 — 사찰 터 이력은 [`SANSA-HANDOFF.md`](../SANSA-HANDOFF.md), 현재 복합 가람 생성기는 [`temple-generator.md`](temple-generator.md).
6. [`verification.md`](verification.md) — 실제로 쓸 수 있는 검증 도구와 알려진 공백.

문서와 코드가 충돌하면 현재 코드와 실행 결과가 우선이다. 의도에 관한 충돌은 `AGENTS.md` → 활성 작업 브리프 → 현재 계약 문서 → 리서치/스냅샷 순으로 해석하고, 차이가 확인되면 같은 작업에서 문서도 갱신한다.

## 문서 상태

- **계약**: 현재 구현이 지켜야 할 구조나 UX 규약. 코드 변경과 함께 갱신한다.
- **활성 작업**: 아직 완료되지 않은 한정된 작업 브리프. 완료 후 상태와 결과를 기록한다.
- **리서치**: 구현 판단의 근거. 현재 코드가 전부 구현했다는 뜻은 아니다.
- **스냅샷**: 특정 날짜의 분석·결정. 시간이 지나면 재검증한다.
- **완료 기록**: 이미 끝난 제작 과정이나 자산 전달 기록. 새 요구사항으로 해석하지 않는다.

## 문서 목록

| 문서 | 상태 | 용도와 주의점 |
| --- | --- | --- |
| [`architecture-refactor.md`](architecture-refactor.md) | 계약 | 완료된 1차 분할, façade·순수 커널·generator·runtime 경계와 후속 개선 조건. |
| [`ink-landscape.md`](ink-landscape.md) | 계약 + 리서치 | 조선 진경산수 근거, PBR↔수묵 렌더·색공간·성능·접근성 계약. |
| [`../SANSA-HANDOFF.md`](../SANSA-HANDOFF.md) | 완료 기록 | #5 사찰 터·대지·진입로·식생 여백의 승인된 계약과 검증 결과. |
| [`temple-generator.md`](temple-generator.md) | 계약 | #12의 재사용 가능한 복합 가람, 전각·석등·석탑·당간지주·부도, 편집·수명주기·성능 검증 경계. |
| [`dancheong.md`](dancheong.md) | 계약 + 리서치 | 궁 기본 모로·사찰 중심 불전 금단청 위계, 선명도/격식 축, 불변 source 캐시·수명·성능 계약과 공식 근거. |
| [`house-diversity.md`](house-diversity.md) | 계약 | 일반 주택의 필지·살림 위계, ㅡ·ㄱ·ㄷ 레퍼토리, ㄷ 최소 4칸과 실제 처마 fit·성능 예산. |
| [`architectural-authenticity.md`](architectural-authenticity.md) | 계약 + 리서치 | 지붕 장식·민가 창호·부엌/구들·담장/마당 감사, 사실→경량 구현 번역, 완료/잔여 체크리스트와 공식 근거. |
| [`surface-materials.md`](surface-materials.md) | 계약 + 리서치 | 재사용 가능한 결정론 표면 source/Three adapter 경계, 흙길 월드 UV·색공간·LOD·수명·성능·A/B 채택 기준. |
| [`project-status.md`](project-status.md) | 계약 | 프로젝트 마무리 방향, 유지해야 할 사용자 결정, 현재 작업 상태. |
| [`verification.md`](verification.md) | 계약 | 빌드·문법·Playwright·결정론 검증의 실제 사용 범위와 함정. |
| [`mode-integration.md`](mode-integration.md) | 계약 | 모드/카메라/focus 통합. `ui-design.md`의 초기 모드 구상보다 우선한다. |
| [`ui-design.md`](ui-design.md) | 리서치 | 초기 UI 설계와 상호작용 언어. 현재 focus 연속체는 `mode-integration.md`를 따른다. |
| [`joseon-city.md`](joseon-city.md) | 리서치 | 도성·읍성·촌락·사찰 입지와 가람 원리. 사찰 작업은 특히 §5·§7G 참조. |
| [`palace-layout.md`](palace-layout.md) | 리서치 | 궁궐 다일곽·축선·행각 공유 규칙과 구현 파라미터. |
| [`village-walls-parcels.md`](village-walls-parcels.md) | 리서치 | 담장·필지·정원·보호수의 실증 근거와 알고리즘 번역. |
| [`tooling.md`](tooling.md) | 스냅샷 | 후보 라이브러리 평가와 채택 판단. 현재 설치 목록으로 오해하지 않는다. |
| [`perf-webgpu.md`](perf-webgpu.md) | 스냅샷 | 2026-07-17 기준 WebGPU·성능 조사. 버전·브라우저 수치는 재검증 필요. |
| [`demo-analysis.md`](demo-analysis.md) | 스냅샷 | 바이럴 데모 사례와 제품 방향 분석. 구현 계약이 아니다. |
| [`references.md`](references.md) | 리서치 | 동아시아 전통건축 도면·3D·비례 자료의 상세 조사 카탈로그. |
| [`credits.md`](credits.md) | 완료 기록 | 공개 크레딧과 출처 표기용 선별 목록. `references.md`와 목적이 다르다. |
| [`suno-prompts.md`](suno-prompts.md) | 완료 기록 | BGM 생성 프롬프트와 6/6 수령 기록. |

## Claude Code 메모리에서 승격한 내용

개인 메모리 경로(`/Users/hckim/.claude/projects/-Users-hckim-repo-asiahouse/memory/`)에는 풍부한 작업 이력이 있지만, 다른 환경에서는 없을 수 있고 완료·폐기된 구현도 섞여 있다. 레포 문서는 그 경로에 의존하지 않도록 다음처럼 정리했다.

| 메모리 묶음 | 레포의 기준 위치 |
| --- | --- |
| 프로젝트 마무리 방향, 릴리스 감사, 보류 결정 | [`project-status.md`](project-status.md) |
| 코어/앱 경계, village 파이프라인, worker, 셰이더 함정 | [`AGENTS.md`](../AGENTS.md) |
| Playwright 실행법, 시각 루프, worker HMR 함정 | [`verification.md`](verification.md) |
| 절 어깨 벤치, relief 패드, 숲 마스크, 지형 예산 | [`SANSA-HANDOFF.md`](../SANSA-HANDOFF.md) |

`forest-canopy-rocks.md`처럼 후속 구현에 의해 폐기된 메모리, 특정 에이전트 플러그인·모델·인증 정보, 임시 포트와 scratchpad 경로는 현재 계약으로 승격하지 않았다. 필요하면 이력 조사에만 사용한다.

## 유지 규칙

- 새 문서는 첫 부분에 목적과 상태를 적고 이 인덱스에 한 줄을 추가한다.
- 활성 브리프는 문제, 범위, 불변식, 검증, 완료 결과만 담는다. 모델 이름·인증·개인 임시 경로에 의존하지 않는다.
- 코드 주석이 문서 절을 직접 인용하므로 기존 설계 문서의 파일명과 절 번호는 함부로 바꾸지 않는다.
- 조사 당시의 수치나 제품 버전에는 날짜를 붙인다.
- 완료된 작업의 세부 일지는 새 계약 문서로 늘리기보다 Git 이력과 기존 브리프의 결과 섹션에 남긴다.
