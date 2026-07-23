# 키보드 건물 탐색 계약

> - **상태**: 구현 계약 (#114)
> - **목적**: 포인터 없이도 마을 부감 → 건물 보기 → 다른 건물 이동 → 둘러보기 복귀를 수행하는 단순하고 의미 있는 경로를 제공한다.

## 1. 제품 결정

캔버스에 `role="application"`이나 Arrow/WASD 키맵을 추가하지 않는다. 3D 장면을 다시 해석한 별도 목록도 만들지
않는다. `ContextPanel`의 공통 헤더에 네이티브 `select`와 명시적인 보기/이동 버튼을 두고, 엔진의 기존 필지
pick proxy를 유일한 후보 소스로 쓴다.

이 선택기는 마을/집 본문을 교차 페이드하는 morph owner 밖에 상주한다. 따라서 focus-in/out/hop 중 DOM이
교체되지 않고, 사용 중인 컨트롤의 포커스도 보존된다. 휠·핀치·포인터의 기존 카메라 의미론은 바꾸지 않는다.

## 2. 데이터 경계

`app/src/engine/engine.js`는 다음 JSON-only API를 제공한다.

```js
engine.village.navigationTargets()
// [{ id: 'p0', type: 'head-house' }, { id: 'p7', type: 'giwa' }, ...]
```

- 후보는 `VillageHandle.getPickProxies()`에서만 만든다. plan이나 렌더 트리를 UI에서 다시 순회하지 않는다.
- `id`는 `getPickProxy(id)`, `focus(id)`, `switchTo(id)`가 이미 공유하는 stable parcel ID다.
- `type`은 `head-house | government | palace | temple | giwa | choga` 중 하나다.
- `mesh`, `Box3`, `Vector3`, 카메라 pose, plan, 편집 spec은 반환하지 않는다.
- 기존 proxy의 안전 focus framing과 occlusion 판정을 그대로 쓰므로 키보드 활성화도 pointer 활성화와 같은
  가시성·차폐 계약을 탄다.

공유 매핑은 Three/Svelte 의존성이 없는 `app/src/lib/building-navigation.js`를 쓴다.

```js
import { buildingNavigationTargetFromProxy } from '../lib/building-navigation.js';

navigationTargets: () => (
  village.handle?.getPickProxies()
    .map(buildingNavigationTargetFromProxy)
    .filter(Boolean) ?? []
)
```

UI는 전달 순서를 보존하고 같은 유형 안에서만 1부터 시작하는 표시 번호를 붙인다. 중복 ID, 알 수 없는 유형,
공백으로 둘러싸이거나 128자를 넘는 ID는 fail-closed한다.

## 3. ContextPanel 통합 훅

`ContextPanel.svelte`의 비공유 구현은 다음 props를 소비한다.

```svelte
<ContextPanel
  navigationTargets={buildingTargets}
  navigationSelectedId={settledBuildingId}
  navigationBusy={villageZooming || waving || veil}
  onNavigateTarget={navigateBuilding}
/>
```

App 통합 규칙은 다음과 같다.

1. 마을 진입과 wave 완료 때 `engine.village.navigationTargets()`를 다시 읽는다. 선택 필지의 종류를
   바꾸거나 다시 지은 뒤에도 같은 순서를 보존한 최신 의미 라벨을 읽는다.
2. `settledBuildingId`는 `villageSelect` 완료에서 새 ID가 되고 `villageReturnDone` 완료에서 `null`이 된다.
   hop 시작에 미리 바꾸지 않아 live region이 도착하지 않은 건물을 현재 선택으로 읽지 않게 한다.
3. `navigateBuilding(id)`는 aerial이면 `engine.village.focus(id)`, focus면 `engine.village.switchTo(id)`만 호출한다.
   새 카메라 경로나 선택 상태기를 만들지 않는다.
4. 전환·wave 중 액션은 native `disabled`가 아니라 `aria-disabled`와 click guard를 쓴다. 포커스는 버튼에 남고
   selector에서 다음 목적지를 미리 고를 수 있다.
5. References가 열리면 기존 `app-surface[inert]`가 선택기를 함께 격리한다. cinematic 중에는 기존
   `ContextPanel open=false`가 적용된다. 별도 전역 key listener를 추가하지 않는다.

필요한 i18n 키는 `nav_building`, `nav_view`, `nav_move`, `nav_current`, `nav_moving`,
`nav_current_status`, `nav_explore_status`, `nav_empty_status`, `nav_count_suffix`다.

## 4. 접근성 상태

- native `select`가 후보 탐색을 소유하며 선택 변경만으로 카메라를 움직이지 않는다.
- 보기/이동 버튼은 최소 44px 터치 타깃과 명시적인 `:focus-visible` 윤곽을 가진다.
- `role="status"`, `aria-live="polite"`, `aria-atomic="true"`인 짧은 상태 문구가 장면의 후보 수 또는
  안착한 현재 건물을 알린다. draft option 변경은 select 자체가 읽으므로 live region에서 반복하지 않는다.
- 빈 마을은 선택기를 렌더하지 않으며 캔버스에 대체 role을 부여하지 않는다.

## 5. reduced motion과 검증

`prefers-reduced-motion: reduce`는 개별 선택기에서 camera API를 우회하지 않는다. 공통 camera tween 경계가
focus-in/out/hop을 정확히 한 번 렌더된 프레임 뒤 완료하도록 duration을 정규화한다. 완료 콜백을 동기 호출하면
`villageReturn` → `villageReturnDone`, `villageSelectStart` → `villageSelect` 순서가 깨질 수 있으므로 금지한다.

최종 통합은 기존 `check:app` 한 부팅에 다음을 합친다.

- native option 변경 뒤 키보드 `Tab`/`Enter`로 aerial → focus → hop, `Escape`로 복귀
- busy 버튼의 포커스 보존과 중복 전환 차단
- References modal 동안 선택기 inert 및 복귀 포커스
- focus-visible과 live status
- reduced-motion에서 한 rendered frame 이후의 동일 이벤트 순서
- mobile에서 새 자동 동작이나 canvas gesture 변화가 없음

순수 후보/상태 계약은 `node tools/check-building-navigation.mjs`로 독립 검증한다.
엔진 해제 뒤 `navigationTargets()`는 다른 query API와 같이 새 빈 배열을 반환한다.
자동화에서는 macOS Chrome의 프로세스 밖 native select popup에 합성 Arrow 키를 보내지 않는다. Playwright
`selectOption()`으로 브라우저의 실제 `change` 경계를 확정한 뒤 카메라 액션과 복귀를 실제 키 입력으로
검사한다. 제품에 별도 Arrow 키맵을 추가하거나 native select 동작을 재구현하지 않는다.
