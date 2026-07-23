# 외부 프로젝트 재사용

> - **상태**: 현재 계약
> - **목적**: Svelte 앱이나 내부 모듈 없이 공개 `src/api/`만으로 cheoma 생성기를 소비하는 최소 경계와 자원 소유권을 설명한다.

## 가장 작은 실행 예제

[`examples/api-building/`](../examples/api-building/)은 `src/api/building.js`만 직접 import해 기와집 한 채를
고정 카메라, 두 광원, 지면 위에 렌더한다. village runtime, environment, post, Svelte를 직접 구성하거나
인스턴스화하지 않으므로 건물 생성기의 외부 통합과 해제를 가장 짧은 실행 경로로 확인할 수 있다.

현재 `src/api/building.js`는 parcel·hanok·palace API도 함께 재노출하고 palette가 일부 환경 helper를 참조하므로,
native ESM은 그 재노출 dependency도 해석한다. 이 예제의 “최소”는 byte-minimal module graph가 아니라 외부 소비자
코드와 실행 scene의 최소 경계를 뜻한다. 새 façade와 package export 분리는 이 작업 범위가 아니다.

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

`tools/check-api-reuse-example.mjs`는 전체 앱이나 Vite를 부팅하지 않고 정적 페이지 하나만 연다.

- `THREE.REVISION === '185'`와 root/mesh `instanceof`로 단일 Three identity를 확인한다.
- 유한한 실제 bounds, draw call, triangle 제출을 확인한다.
- 공유 `P.mats` borrower가 호출자 material/texture를 해제하지 않는지 확인한다.
- 반복 rebuild 뒤 geometry/texture 수가 plateau인지 확인한다.
- 이중 dispose, 종료 후 rebuild 거부, resize listener·canvas·debug hook 정리를 확인한다.

`tools/check-architecture.mjs`는 예제가 `src/api/building.js` 외의 저장소 구현이나 다른 npm package를
import하지 못하게 하고 import map의 두 Three 경로가 같은 고정 버전인지 browser 시작 전에 검사한다.
