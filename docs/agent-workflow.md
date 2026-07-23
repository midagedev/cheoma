# 에이전트 작업·검증 워크플로

> - **상태**: 현재 계약
> - **목적**: 독립 작업을 안전하게 병렬화하고, 반복 검증의 벽시계를 줄이면서 머지 안전성을 유지한다.

## 1. 작업 시작: 필요한 문서만 읽는다

모든 작업이 전체 설계 문서를 읽을 필요는 없다. 공통 시작점은 `AGENTS.md`, `docs/README.md`, 이 문서 세 개다. 그 뒤 변경 경로에 맞는 문서만 추가한다.

| 변경 경로 | 추가로 읽을 문서 |
| --- | --- |
| `src/village`, `src/generators`, `src/runtime/village` | `architecture-refactor.md`, 관련 마을 도메인 문서 |
| `src/env`, `src/render`, `src/camera`, `src/cinematic` | `verification.md`, `mode-integration.md` |
| `src/temple` | `temple-generator.md`; 과거 터 재배치가 관련될 때만 `SANSA-HANDOFF.md` |
| `app/` | `mode-integration.md`, `ui-design.md` 중 현재 계약 부분 |
| 외부 자료를 사용하는 시각·고증 변경 | 관련 리서치 문서, `references.md`, `credits.md` |

`project-status.md`는 안정된 사용자 결정과 활성 방향을 확인할 때 읽는다. 완료 이력은 Git/PR과 도메인 문서에서 찾는다.

## 2. 독립 worktree와 소유권

새 이슈는 기본적으로 sibling worktree와 `codex/` 브랜치를 사용한다. 의존성은 primary worktree에 한 번 설치하고, lockfile이 같은 worktree에만 안전한 심볼릭 링크를 만든다.

```bash
npm run wt -- create issue-92-speed \
  --issue 92 \
  --owner integration \
  --owns tools/lib/verification-plan.mjs \
  --owns docs/agent-workflow.md \
  --gate check:pr

npm run wt -- status
npm run wt -- doctor issue-92-speed
npm run wt -- handoff issue-92-speed --json
```

`--owns`는 정확한 파일이나 `/`로 끝나는 디렉터리 prefix다. glob은 허용하지 않는다. 활성 claim과 겹치면 생성·갱신을 거부한다. 구현 작업자는 자기 소유 파일만 고치고, 공유 façade·golden·문서는 통합 레인이 한 번에 갱신한다.

수동 생성 worktree도 `claim`과 `deps link`로 같은 계약에 들어올 수 있다.

```bash
npm run wt -- claim issue-88-source-depth \
  --issue 88 --owner issue-88-impl \
  --owns src/env/circular-bokeh-shader.js
npm run wt -- deps link issue-88-source-depth
```

공유 링크를 둔 worktree에서는 `npm install`을 실행하지 않는다. root나 app lockfile을 바꾸는 dependency PR은 이 CLI의 공유 의존성·자동 cleanup 대상이 아니다. 먼저 별도 PR로 lockfile을 머지하고 primary에서 설치한 뒤 구현 worktree를 만들거나, 수동 worktree에 독립 설치하고 그 경로와 수동 정리 책임을 handoff에 명시한다.

## 3. 세 단계 검증

### Inner loop — 코드 변경 직후

```bash
npm run check:pr -- --dry-run
npm run check:pr
```

`check:pr`는 변경 파일의 정적 import closure와 명시된 도메인 경계를 합쳐 영향받은 순수 계약만 실행한다. 문서만 바뀌면 `check:docs`만 실행한다. 새 경로, 미분류 경로, 공용 검증 인프라, dependency/build 설정, public aggregate API는 `check:full`로 fail-closed한다.

`check:pr`는 기본 두 작업을 허용하지만 실제 브라우저 게이트는 한 레인에서 직렬 실행한다. 순수 계약이나 build만 그 옆에서 겹칠 수 있다. focus와 wave가 함께 필요하면 `check:lod:app` 한 번으로 합쳐 같은 앱 부팅을 재사용한다. 실행 후 가장 느린 세 게이트를 출력하므로 다음 병목을 추측하지 않고 측정할 수 있다.

게이트 전체 목록과 소유 tier는 다음 명령으로 본다.

```bash
npm run check:list
```

### Issue checkpoint — 행동·시각 확인

영향받은 browser/Worker 게이트와 도메인 시각 하네스를 한 번 실행한다. 수치 PASS만으로 미감을 대신하지 않는다. 캡처는 OS 임시 폴더에 두고, 최종 판정에 필요한 최소 이미지와 측정만 남긴다.

- 환경 모듈은 가능하면 직접-import 하네스로 먼저 검사한다. 병렬 작업 중 미완성 앱 통합에 흔들리지 않는다.
- Worker ON만 실패하고 sync/fallback이 통과하면 전용 Vite server와 cache를 깨끗이 다시 시작한 뒤 코드 회귀로 판정한다.
- GPU query, 프레임 cadence, 절대 성능 비교는 다른 browser 작업과 겹치지 않는다. 실행기가 Git common dir의 공용 browser lock을 사용하므로 별도 worktree의 검증도 서로 겹치지 않는다.

독점 실행이 필요하면 다음처럼 직렬화한다.

```bash
CHEOMA_GATE_JOBS=1 CHEOMA_BROWSER_JOBS=1 npm run check:pr
```

### Merge checkpoint — 최종 HEAD에서 성공 한 번

```bash
npm run check:full
```

`check:full`은 기존 전체 순수·앱·Worker/fallback·audio·사찰·필지 재건축·표면·DoF·rim·LOD/wave·cinematic·production build 범위를 줄이지 않는다. 자원 스케줄러가 순수 CPU 작업을 브라우저 레인과 겹칠 뿐, 브라우저끼리는 기본 직렬이다. 반복 단계마다 full을 재실행하지 않고, 최종 변경이 끝난 동일 HEAD에서 성공 1회를 남긴다. 실패 뒤 수정했거나 통과 뒤 diff가 바뀌면 다시 실행한다.

## 4. 인계와 통합

서브 작업의 인계에는 다음 필드를 빠뜨리지 않는다.

- 이슈와 목표
- base SHA와 worktree/branch
- 소유 파일과 실제 변경 파일
- 실행한 빠른/브라우저 게이트
- 직접 본 이미지·행동·성능 결과
- 아직 전달되지 않았거나 미결인 지시

작업 중 보낸 추가 지시는 작업자가 수신 확인하기 전까지 미전달로 간주한다. 통합 담당은 handoff의 미결 지시와 원 요청을 대조한다. 큰 이미지·브라우저 상태를 오래 쌓은 완료 작업자는 새 이슈에 그대로 재사용하지 않고, 짧은 텍스트 handoff로 새 작업 컨텍스트를 시작한다.

`npm run wt -- handoff <slug> --json`이 Git·의존성·claim 상태를 기계 판독 가능하게 출력한다. 보고만 믿지 않고 `doctor`가 claim 밖 변경과 의존성 불일치를 검사한다.

PR 머지 뒤에는 안전 조건을 통과한 worktree만 정리한다.

```bash
npm run wt -- cleanup issue-92-speed
```

`cleanup`은 primary, dirty/untracked/ignored 산출물, detached, prunable, 미머지 branch, 잘못된 dependency link를 거부한다. `--force`, `rm -rf`, 자동 prune을 사용하지 않으며 도구가 만든 정확한 두 링크만 해제한 뒤 `git worktree remove`와 기대 HEAD를 조건으로 한 branch ref 삭제를 사용한다.

## 5. 배포 최소 계약

배포는 production branch의 검증된 HEAD에서 다음 순서로 수행한다.

```bash
(cd app && npm run build)
npx wrangler pages deploy app/dist --project-name=cheoma --branch=main
```

Vite가 `app/dist`를 비운 뒤 만든 clean build인지 로그에서 확인한다. 배포 뒤 `https://cheoma.pages.dev`와
`https://cheoma.midagedev.com`의 HTML이 가리키는 `/assets/index-*.js` 이름이 같은지 비교하고, 두 주소의 HTTP
성공과 실제 custom domain 첫 장면 부팅을 확인한다. 인증정보와 임시 배포 경로는 문서나 handoff에 남기지 않는다.

## 6. 속도 회귀 기준

- 문서-only `check:pr`은 무거운 village plan을 실행하지 않는다.
- DoF shader inner loop는 roads/layout/citywall을 실행하지 않는다.
- 같은 LOD 하네스의 focus+wave는 한 번의 browser boot로 실행한다.
- 성능 계측은 독점 레인, 일반 browser 검증은 한 레인을 기본값으로 유지한다.
- final merge coverage는 줄이지 않는다.
- 라우터가 불확실하면 빠르게 통과시키지 않고 full로 승격한다.

이 기준은 검증을 생략하는 규칙이 아니라, 가장 싼 실패를 먼저 발견하고 비싼 증거를 한 번만 만드는 규칙이다.
