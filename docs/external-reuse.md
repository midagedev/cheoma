# 외부 프로젝트 재사용

> - **상태**: 현재 계약
> - **목적**: Svelte 앱이나 내부 모듈 없이 공개 `src/api/`만으로 cheoma 생성기를 소비하는 최소 경계와 자원 소유권을 설명한다.

## 가장 작은 실행 예제

[`examples/api-building/`](../examples/api-building/)은 `src/api/building.js`만 직접 import해 기와집 한 채를
고정 카메라, 두 광원, 지면 위에 렌더한다. village runtime, environment, post, Svelte를 직접 구성하거나
인스턴스화하지 않으므로 건물 생성기의 외부 통합과 해제를 가장 짧은 실행 경로로 확인할 수 있다.

현재 `src/api/building.js`는 parcel·hanok·palace API도 함께 재노출하고 palette가 일부 환경 helper를 참조하므로,
native ESM은 그 재노출 dependency도 해석한다. 이 예제의 “최소”는 byte-minimal module graph가 아니라 외부 소비자
코드와 실행 scene의 최소 경계를 뜻한다. 시전과 계절 마당 생활상은 아래의 독립 façade를 사용하며, package export map 분리는 아직
이 문서의 범위가 아니다.

ES module은 `file://`에서 열지 말고 저장소 루트를 정적 HTTP 서버로 제공한다. 먼저 루트 Playwright와 앱의
고정 Three를 설치한다. 자동 smoke는 CDN 요청을 로컬 설치본으로 대체하므로 실행 시 네트워크가 필요 없다.

```bash
npm install
(cd app && npm install)
```

수동으로 볼 때는 한 터미널에서 서버를 유지하고 브라우저로 URL을 연다. import map의 CDN을 사용하므로 이 경로는
네트워크가 필요하다.

```bash
python3 -m http.server 4173 --bind 127.0.0.1
# http://127.0.0.1:4173/examples/api-building/
```

자동 검증은 공용 browser lock을 포함한 표준 명령을 사용한다.

```bash
npm run check:api-reuse
```

외부 코드가 import하는 cheoma 모듈은 좁은 façade 하나다.

```js
import * as THREE from 'three';
import {
  PRESETS,
  buildBuilding,
  disposeBuilding,
} from './cheoma/src/api/building.js';

const building = buildBuilding({ ...PRESETS.giwa });
scene.add(building);

// buildBuilding이 반환한 원본 root를 scene에서 먼저 분리한다.
scene.remove(building);
disposeBuilding(building);
```

필요한 기능만 담은 `src/api/building.js` 대신 전체 `src/api/index.js`를 사용하면 village, environment,
audio 등 browser runtime 전체 dependency graph가 따라온다. 단독 건물 소비자는 좁은 진입점을 사용한다.

## 시전 계획과 렌더러

시전행랑은 순수 계획과 Three 렌더러를 별도 진입점으로 제공한다. 배치·footprint·2칸 façade 데이터만
필요한 worker나 서버 도구는 `src/api/sijeon-plan.js`를 사용한다. 이 모듈은 DOM과 Three를 import하지
않으며 전역 `Math.random`을 소비하지 않는다.

```js
import {
  planSijeon,
  planSijeonFacade,
} from './cheoma/src/api/sijeon-plan.js';

const shops = planSijeon(roadsResult, site);
const facade = planSijeonFacade(shops[0]);
```

실제 geometry가 필요하면 `src/api/sijeon.js`를 사용한다. `buildSijeon()`은 `{ frame, opening, bench,
storage, roof }` 다섯 `THREE.Material`과 `heightAt(x, z)`를 빌리며 새 material이나 texture를 만들지
않는다. 반환 root는 점포 수와 무관하게 역할별로 병합된 geometry를 소유한다.

```js
import {
  buildSijeon,
  disposeSijeon,
} from './cheoma/src/api/sijeon.js';

const row = buildSijeon(shops, {
  materials: { frame, opening, bench, storage, roof },
  heightAt: (x, z) => terrainHeightAt(x, z),
});
scene.add(row);

scene.remove(row);
disposeSijeon(row); // true
disposeSijeon(row); // false

// 빌린 다섯 material은 여전히 유효하다. 마지막 사용자가 끝난 뒤 호출자가 해제한다.
```

`buildSijeon`은 이 borrowed-material 공개 계약만 뜻한다. 제품 마을 조립기가 자체 색과 적설 역할을
붙이는 내부 어댑터는 `buildVillageSijeon`이라는 별도 이름을 사용하므로 외부 renderer 호출과 인자·소유권이
뒤섞이지 않는다. `src/api/index.js`와 `src/api/village.js`도 같은 구분을 유지한다.

## 계절 마당 생활상 계획과 렌더러

worker나 서버에서 드문 농가와 봄 볍씨 준비·가을 타작·겨울 땔감의 직렬화 가능한 슬롯만 계획할 때는
Three 없는 `src/api/yard-life-plan.js`를 사용한다. 같은 입력은 전역 `Math.random`을 소비하지 않고 같은
JSON record를 만든다. 세 잠재 계절 슬롯은 실제 지붕·대문 접근·일조·기존 마당 hard object를 피하도록
미리 예약되므로 renderer가 계절에 따라 좌표를 다시 고르지 않는다.

```js
import {
  planYardLife,
  validateYardLifeRecords,
} from './cheoma/src/api/yard-life-plan.js';

const records = planYardLife(villagePlan.parcels, {
  seed: villagePlan.seed,
  heightAt: (x, z) => terrainHeightAt(x, z),
});
validateYardLifeRecords(records);
```

계획 필지에 유한한 `baseY`가 있으면 그것이 평탄 성토 마당의 권위 있는 높이다. 위 `heightAt`은 `baseY`가
없는 외부 필지 데이터의 fallback이며, 제품처럼 경사지 필지를 평탄화한 scene에서 raw terrain 높이로
마당 소품을 다시 내리면 안 된다.

실제 geometry는 `src/api/yard-life.js`의 borrowed-material renderer가 맡는다. `record.world.y`가 권위 있는
높이이고 `heightAt`은 그 값이 없는 외부 record의 fallback일 뿐이다. renderer는 호출자가 빌려준 여섯 역할
material을 한 번 파생 복제해 vertex color와 안정된 screen-door 전환을 구성하고, 계절·날씨·거리·wave
가중치를 곱해도 새 material·program·texture를 만들지 않는다.

```js
import {
  buildYardLife,
  disposeYardLife,
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_PRESENTATION_SEASONS,
  YARD_LIFE_WEATHER,
} from './cheoma/src/api/yard-life.js';

const yardLife = buildYardLife(records, {
  materials: { wood, onggi, straw, stone, chaff, fiber },
  heightAt: (x, z) => terrainHeightAt(x, z),
  season: 'autumn',
});
scene.add(yardLife.group);

yardLife.setWeather('clear', { immediate: true });
yardLife.updateLod(camera, sharedDetailState, weightAt);
yardLife.update(dt);

scene.remove(yardLife.group);
disposeYardLife(yardLife); // true
disposeYardLife(yardLife); // false

// 빌린 여섯 source material은 여전히 유효하며 마지막 borrower 뒤 호출자가 해제한다.
```

`YARD_LIFE_SEASONS`는 실제 record가 존재하는 봄·가을·겨울을,
`YARD_LIFE_PRESENTATION_SEASONS`는 빈 여름 상태까지 포함한 renderer 제어값을 뜻한다.
날씨와 재료 입력의 허용값은 각각 `YARD_LIFE_WEATHER`, `YARD_LIFE_MATERIAL_ROLES`를 사용한다.
외부 저장소나 worker 경계를 건너온 record는 geometry를 할당하기 전에 Three 없는
`validateYardLifeRecords(records, heightAt)`로 동일한 schema를 검사할 수 있다.

`rebuild(nextRecords)`는 byte-identical record면 `false`를 반환하고 live geometry를 유지한다. 실제 내용이
바뀌면 같은 파생 material을 재사용해 geometry만 원자적으로 교체하고, 같은 record ID의 진행 중 계절·날씨
가중치를 이어받는다. 제품 팔레트와 shared detail LOD를 연결하고 여섯 source material까지 소유하는 내부
어댑터는 `createVillageYardLife`라는 별도 이름을 쓰며 공개 borrowed-material renderer와 소유권을 섞지 않는다.

## Three는 한 인스턴스만 사용한다

코어와 외부 scene이 서로 다른 Three를 쓰면 `instanceof`, prototype patch, addon geometry가 조용히
어긋난다. 브라우저 import map은 `three`와 transitive `three/addons/`를 **같은 0.185.1 배포본**으로
보내야 한다.

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"
  }
}
</script>
```

번들러를 쓰면 `three@0.185.1` 하나를 설치하고 bare `three`와 `three/addons/`를 그 설치본으로 alias하며
`dedupe: ['three']`를 적용한다. 현재 제품의 실행 가능한 설정은
[`app/vite.config.js`](../app/vite.config.js)다. 향후 패키지로 배포할 때도 Three를 번들에 복제하지 않고
peer dependency로 두는 것이 이 계약과 맞다.

## 소유권과 해제 순서

| 자원 | 소유자 | 해제 |
| --- | --- | --- |
| `buildBuilding()` 원본 root의 geometry·파생 material/texture | 건물 | scene 분리 후 `disposeBuilding(root)` |
| `P.mats`로 주입한 palette | 호출자 | 마지막 borrower가 끝난 뒤 호출자가 해제 |
| `buildSijeon()` 반환 root의 병합 geometry | 시전 renderer | scene 분리 후 `disposeSijeon(root)` |
| `buildSijeon()`에 주입한 다섯 material | 호출자 | 마지막 borrower가 끝난 뒤 호출자가 해제 |
| `buildYardLife()` handle의 병합 geometry·파생 전환 material | 마당 생활상 renderer | scene 분리 후 `disposeYardLife(handle)` |
| `buildYardLife()`에 주입한 여섯 source material | 호출자 | 마지막 borrower가 끝난 뒤 호출자가 해제 |
| 외부 scene, camera, renderer, light, ground | 외부 통합 | 각 통합의 teardown에서 별도 해제 |
| 모듈 수명 공유 prop 자원 | cheoma 모듈 | 개별 건물 dispose 대상 아님 |

`disposeBuilding()`은 등록된 원본 root의 첫 해제에서만 `true`를 반환한다. 두 번째 호출은 `false`이며
공유 palette를 끊지 않는다. wrapper group이나 임의의 child 대신 반드시 `buildBuilding()`이 돌려준
root를 전달한다.

예제의 `mountBuildingExample(container)`는 다음 수명을 그대로 실행한다.

```js
const mounted = mountBuildingExample(container);
mounted.rebuild(); // 이전 root를 scene에서 분리하고 해제한 뒤 새 root를 렌더
mounted.dispose(); // 건물 + 예제가 소유한 지면·renderer·canvas·listener 해제
mounted.dispose(); // false, 아무 자원도 다시 만들지 않음
```

## 실행 계약

`npm run check:api-reuse`는 browser lock을 한 번만 잡고 다음 세 계약을 순서대로 실행한다.

- `tools/check-api-reuse-example.mjs`: 전체 앱이나 Vite 없이 정적 건물 예제와 단일 Three identity·수명을 검사한다.
- `tools/shoot-sijeon.mjs street-day`: 공개 시전 API만으로 borrowed-material renderer·눈/림/wave·dispose를 검사한다.
- `tools/shoot-sijeon-app.mjs`: `shot=1` 없이 실제 Vite 한양 제품 카메라·view shift·post·부감 림 정책에서 데스크톱·모바일 시전 픽셀 기여를 검사한다.

계절 생활상은 `npm run check:yard-life:browser`가 같은 방식으로 browser lock을 한 번만 잡고 두 경로를
순서대로 실행한다.

- `tools/shoot-yard-life.mjs`: 공개 계획·borrowed-material renderer의 물리 geometry, 전환 보존, 동일 record
  rebuild 생략, shared LOD의 O(1) 부감 sleep, wave, dispose와 자원 plateau를 검사한다.
- `tools/shoot-yard-life-app.mjs`: 실제 제품 카메라의 봄·가을·겨울 layer OFF/ON 픽셀 기여와 부감 0 draw,
  program/geometry/texture plateau를 검사한다.

첫 번째 정적 예제의 세부 계약은 다음과 같다.

- `THREE.REVISION === '185'`와 root/mesh `instanceof`로 단일 Three identity를 확인한다.
- 유한한 실제 bounds, draw call, triangle 제출을 확인한다.
- 공유 `P.mats` borrower가 호출자 material/texture를 해제하지 않는지 확인한다.
- 반복 rebuild 뒤 geometry/texture 수가 plateau인지 확인한다.
- 이중 dispose, 종료 후 rebuild 거부, resize listener·canvas·debug hook 정리를 확인한다.

`tools/check-architecture.mjs`는 예제가 `src/api/building.js` 외의 저장소 구현이나 다른 npm package를
import하지 못하게 하고 import map의 두 Three 경로가 같은 고정 버전인지 browser 시작 전에 검사한다.
