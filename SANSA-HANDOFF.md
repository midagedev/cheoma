# 사찰 터 재배치 작업 브리프

> - **상태**: 구현·시각·사람 검토 완료, GitHub #5 독립 PR로 출판
> - **기준일**: 2026-07-21
> - **작업 브랜치**: `codex/issue-5-sansa-placement`
> - **커밋 정책**: 2026-07-21 사용자가 검토 후 커밋·PR·머지를 승인했다.
> - **후속 작업**: GitHub #12의 복합 가람 생성기는 [`docs/temple-generator.md`](docs/temple-generator.md)에서 별도로 다룬다.

이 문서는 Claude Code 메모리의 사찰 배치·지형 패드·숲 worker 관련 이력과 현재 코드를 대조해 만든 자립형 브리프다. 구현이나 검증에 개인 메모리 경로, 특정 포트, 임시 스크린샷 경로가 필요하지 않다.

## 1. 확정된 사용자 결정

- 목표는 반드시 산속 승원인 **산사**가 아니라, 지형과 마을에 자연스럽게 놓인 아름다운 **한국 사찰**이다.
- 능선 정상과 급사면을 기본 입지로 삼지 않는다. 평지, 골짜기 바닥, 물가, 완만한 산기슭, 작은 분지, 도성 안 사찰이 모두 가능하다.
- 산과 숲의 위요감은 좋은 후보의 가산점이지 필수 조건이 아니다. 사찰 주변에 인위적인 원형 숲이나 민둥 후광을 만들지 않는다.
- 지형 적응과 가람 구성은 다른 문제다. 이 작업은 터·진입로·식생 여백을 맡고, 여러 전각·석등·석탑·당간지주·부도의 구성은 #12가 맡는다.
- 현재의 한 동짜리 빈 경내는 최종 목표가 아니다. 다만 #5와 #12를 한 PR에 섞지 않아 배치 회귀와 건축 회귀를 따로 검증한다.

## 2. 조사 결론

유네스코 평가와 공식 산사 자료는 한국 사찰 입지를 골짜기 바닥, 사면, 계류변으로 나눈다. 통도사는 영축산 남쪽 기슭의 비교적 평탄한 터에 있고, 마곡사는 계류가 공간을 조직한다. 부석사의 높은 석축 사면은 중요한 사례지만 모든 사찰의 기본형은 아니다. 흥전리 사지 연구도 넓고 평탄한 중심 대지와 주변 지형의 제한적 개변을 보여준다.

따라서 생성 규칙은 다음 순서를 따른다.

1. 실제 회전 경내가 들어가는 낮은 낙차의 터를 우선한다.
2. 도로나 성문으로 이어지는 접근을 확보한다.
3. 물·도로·기존 필지·성곽·월드 가장자리를 침범하지 않는다.
4. 산의 위요감과 배경 능선은 동률 후보의 보너스로만 쓴다.
5. 완경사가 불가피할 때만 낮은 다단 석축을 사용한다.

근거:

- [UNESCO/ICOMOS Sansa evaluation](https://whc.unesco.org/document/168725)
- [산사 세계유산 가치와 입지 유형](https://www.koreansansa.net/eng/sansa/sansa_06.do)
- [통도사 자연환경](https://www.koreansansa.net/eng/sansa/sansa_020502.do)
- [마곡사](https://www.koreansansa.net/eng/sansa/sansa_020401.do)
- [부석사](https://www.koreansansa.net/eng/sansa/sansa_020701.do)
- [KCI 흥전리 사지 입지 연구](https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART002911705)

## 3. 현재 구현 계약

### 순수 계획

`src/village/temple-plan.js`가 다음을 단독 소유한다.

- 규모 연속체에 따른 현재 경내 footprint `22..33m`. 작은 hamlet은 큰 불전이 터를 압도하거나 높은 축대를 만들지 않도록 compact footprint를 쓴다.
- 회전 footprint의 5×5 지형 낙차와 최고점.
- world/terrain/road/stream/core parcel/city wall 충돌 검사.
- 평탄성, 접근 거리, 가장자리, 전면 장벽, 지형 위요감의 결정론 점수.
- 남측 정문에서 실제 도로나 성문까지 이어지는 샘플 경로.
- 필지·시전·논이 나중에 침범하지 못하도록 경내와 경로 예약 polygon 생성.

사찰 계획은 도로 직후, 필지·시전·논보다 먼저 실행한다. `includeTemple=false`일 때 전용 seed 경로도 실행하지 않아 기존 base plan 골든을 보존한다. 도로 접근성은 공유 uniform-grid 인덱스를 사용해 후보×전체 도로 전수 순회를 피한다.

### 지형과 렌더

- `buildTempleFeaturePad`는 실제 footprint 최고점에 경내를 놓는다.
- 낙차가 클 때만 전면을 2–3개의 좁은 apron으로 나눈다. 모든 top/skirt는 두 aggregate buffer를 공유한다.
- 접근로는 지형에 밀착한 폭 2.5m ribbon 하나와 필요한 계단 buffer 하나를 사용한다.
- forest/vegetation/terrain/picking은 모두 같은 footprint·path 데이터를 소비한다.
- 식생은 회전 경내와 경로만 비우며 장식용 원형 clearing이나 강제 grove를 만들지 않는다.
- 기존 `{x,z,frontDir,seed}`는 유지하고 `compoundSize`, `baseY`, `path`, `placement`만 추가한다.

## 4. 구현 결과

대표 시드의 순수 plan 결과:

| 규모 | 경내 | 위치 `(x/R,z/R)` | footprint 낙차 | 접근 | 비고 |
| --- | ---: | --- | ---: | --- | --- |
| hamlet | 22.2m | `(0.35,0.25)` | 0.969m | road 6.3m | 작은 사찰 |
| village | 33m | `(0.33,-0.25)` | 1.390m | road 19.6m | 평지 가장자리 |
| town | 33m | `(0.16,-0.32)` | 0.786m | road 39.2m | 평탄 대지 |
| capital | 33m | `(0.19,-0.39)` | 0.132m | road 90.1m | 궁과 분리 |
| hanyang | 33m | `(0.18,-0.35)` | 0.062m | road 85.9m | 성 안쪽 |

5규모×7시드 35개 스윕에서는 모두 road/gate 접근을 찾았고 최대 footprint 낙차는 3.270m였다. 3m를 넘는 작은 hamlet은 한 층 높이보다 낮은 두 단으로 나눈다. 사찰 후보 탐색이 큰 도시 계획에 유의미한 추가 지연을 만들지 않도록 road spatial index로 바꿨다.

시각 확인 결과:

- village `calls=801`, page/console error 0.
- 단일 거대 옹벽, 능선 정상 배치, 원형 민둥 clearing이 보이지 않는다.
- village/town/capital/hanyang 부감과 village/hanyang 근접에서 경내 접지와 진입로 연속성을 확인했다.
- 남은 미감 결함은 빈 사각 경내와 한 동짜리 구성이다. 이는 터 배치 문제가 아니라 #12의 명시적 후속 범위다.
- `npm run check:full` 통과: 빠른 계약, 실제 앱, 파티클, Worker/fallback, audio, DoF, Hanyang LOD/wave, production build.

Worker scene/proxy 기준선은 sync·실제 module Worker·`?worker=0` fallback에서 일치한다.

| 규모 | scene hash | proxy hash |
| --- | --- | --- |
| village | `fc5fa092:65f023a6:74f070e0:e0a311aa` | `13d7982c` |
| town | `e11717e2:0f726104:9aaec996:482a5872` | `79a79d96` |
| capital | `dc95e8ce:b69b7600:4a2d1bd4:33ec0d34` | `ef7ece38` |
| hanyang | `bdc75dc0:1785c5ce:0ad1e25f:c4ce1554` | `a5aaf2dc` |

## 5. 영구 검증

`tools/check-plan-contract.mjs`는 temple ON에서 다음을 검사한다.

- 경내 22..33m, 낙차 9m 이하, baseY가 실제 5×5 최고점을 덮는지.
- world/terrain/road/stream/city wall과의 관계.
- 접근로가 남측 정문에서 시작해 실제 road/gate에서 끝나는지와 샘플 간격.
- 사찰 예약과 최종 parcel/sijeon/paddy가 겹치지 않는지.
- temple OFF 5개 base hash가 그대로인지.

반복 명령:

```bash
npx esbuild src/village/temple-plan.js --bundle --format=esm --outfile=/dev/null
node tools/check-plan-contract.mjs
node tools/verify-solo.mjs
node tools/shoot-templesite.mjs --tmp
npm run check:worker
npm run check:full
```

`shoot-templesite`는 OS 임시 디렉터리를 기본 검토 경로로 쓸 수 있고, `CHEOMA_TEMPLE_OUT`으로 명시적 출력 폴더를 지정할 수 있다. headless 절대 frame time은 성능 근거로 사용하지 않는다.

## 6. 리뷰 체크리스트와 인계

- [x] 여러 규모·시드에서 평탄/완경사 터를 찾는다.
- [x] 도로 또는 성문까지 실제 경로가 있다.
- [x] 사찰 OFF base plan을 바꾸지 않는다.
- [x] 식생과 picking이 같은 footprint를 쓴다.
- [x] 부감·근접 이미지를 에이전트가 직접 열어 확인했다.
- [x] 사람 리뷰 후 커밋·PR·머지 승인.
- [ ] #12에서 복합 가람 생성기와 편집 옵션 구현.

이 터 계약은 #5의 승인된 배치 기반이다. #12는 이를 렌더 단계에서 몰래 키우지 말고, 필요한 footprint를 순수 계획 단계에 먼저 요청해야 한다.
