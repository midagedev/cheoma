# 절차적 표면 재질

> - **상태**: 현재 계약 + 리서치
> - **기준일**: 2026-07-26
> - **현재 채택 범위**: 다져진 흙길 albedo + bump 한 종류, 그리고 **표면 albedo 위계 실측 기록**(아래 마지막 절)

## 목적

표면의 정보량을 늘리되 사진 타일, 비결정적 생성, 재질 수 증가, 비동기 로딩 pop을 도입하지 않는다. 첫 파일럿은 가까운 화면에서 지나치게 평평했던 흙길만 다룬다. 초가 이엉·석재·목재처럼 이미 자체 절차 텍스처가 있는 표면이나 FAR 주택 mass에는 확장하지 않는다.

## 시각 근거와 번역

Wikimedia Commons의 Bernard Gagnon 촬영 낙안읍성 사진 `Naganeupseong Village 06`과 `08`은 CC0이며, 흙마당과 통행면이 한 색의 완전한 평면이 아니라 낮은 대비의 눌림·입도 차이를 갖는다는 비교 근거로 사용했다. 사진의 얼룩, 발자국, 수레 자국을 복제하거나 픽셀을 샘플링하지 않았다. 특정 방향의 강한 자국은 짧은 타일에서 즉시 반복되므로 오히려 제외하고, 따뜻한 중성 변조와 방향성 없는 여러 공간 주파수만 구현했다.

- [Naganeupseong Village 06 — Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Naganeupseong_Village_06.jpg)
- [Naganeupseong Village 08 — Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Naganeupseong_Village_08.jpg)
- 저자: Bernard Gagnon, 2022-10-01, own work, CC0 1.0.

사용자에게 보이는 같은 출처·라이선스·적용 범위는 [`credits.md`](credits.md)의 35번 항목이 단일 원본이며 실제 Reference UI가 이를 파싱한다.

## 구조 계약

`src/surfaces/packed-earth.js`는 Three.js, DOM, Canvas, `Math.random`이 없는 순수 생성기다. public `createPackedEarthTile({ seed, size })` 호출은 동일 크기의 RGBA8 albedo/height 배열을 매번 새로 반환하므로 외부 변경이 다음 생성 결과로 새지 않는다. production roads만 기본 256² bytes를 외부에 노출하지 않는 module-local source로 한 번 생성해 CPU 재계산을 줄인다. 이 source로부터 만드는 GPU texture는 마을마다 별도 소유·해제한다. 주기적 lattice noise를 토러스에서 평가해 상하·좌우 wrap의 값과 기울기가 자연스럽게 이어진다.

`src/surfaces/packed-earth-textures.js`만 Three.js를 안다. 각 소비자는 source 배열까지 복사한 두 `DataTexture`를 새로 소유하고 자신의 Object3D 수명과 함께 해제한다. 따라서 scene에서 접근한 `texture.image.data`를 소비자가 바꿔도 module-local source나 다른 마을로 전파되지 않는다. 설정은 다음과 같다.

- albedo: `SRGBColorSpace`; height: `NoColorSpace`.
- `RepeatWrapping`, linear magnification, trilinear mipmap minification, mipmap 생성, anisotropy 4.
- 외부 파일 요청과 늦은 `TextureLoader` 교체가 없으므로 첫 프레임 texture pop이 없다.

순수 소비자는 `src/api/surface-material-plan.js`, Three/browser 소비자는 `src/api/surface-materials.js`를 사용한다. 내부 모듈은 이 public façade를 역참조하지 않는다. 색공간 선택은 three.js의 [Color management manual](https://threejs.org/manual/en/color-management.html)을 따른다.

## 도로 적용 계약

도로는 기존 vertex color를 권위 있는 색과 경사면 mute로 유지한다. albedo는 거의 흰색인 따뜻한 변조라 그 색을 곱해 없애지 않으며, bump는 0.08의 낮은 요철만 만든다. UV는 각 리본의 길이가 아니라 회전된 월드 XZ 좌표를 16m 주기로 사용한다. 따라서 strip, join, 도로 등급, 교차로에서 좌표가 끊기지 않고 남북·동서 길에 같은 띠가 정렬되는 현상도 줄어든다.

빈 도로는 geometry/material/texture를 할당하지 않는다. 도로가 있으면 이전과 똑같이 Mesh 1, Material 1이며 position/index/삼각형은 바뀌지 않는다. 추가 예산은 다음뿐이다.

- GPU texture +2(albedo RGBA8, height RGBA8; mip 포함 약 0.67MiB).
- shader program family 최대 +1.
- draw call +0, triangle +0, material +0.

glTF에는 표준 base-color에 대응하는 DataTexture albedo가 임베드된다. glTF 2.0 표준 재질에 bump map 슬롯이 없으므로 height는 런타임 표현으로만 남고 별도 우회 확장을 만들지 않는다. 내보내기는 실패하지 않아야 하며 실제 JSON의 image/texture 존재를 브라우저에서 검사한다.

## 표현 경계

- FULL/MID의 실제 도로 표면만 이 재질을 본다. 주택 FAR mass와 impostor 정책은 바뀌지 않는다.
- 눈은 지형·지붕·식생의 기존 적설 shader를 유지한다. 반복 통행으로 다져진 도로는 `snowSurface=false`인 명시적 비축적면으로 남겨 흙길이 주변 설면 속 동선으로 읽히며, map+bump+vertexColor 전용 적설 program 두 개를 만들지 않는다. 비·계절은 기존 environment patch를 그대로 쓴다.
- 넓고 평평한 도로는 지형·물·논처럼 Fresnel rim 대상에서 제외한다. bump를 실루엣으로 오인해 금빛 면이 되는 것을 막되 실제 태양의 표준 PBR 조명은 유지한다.
- 수묵은 기존 raw beauty를 입력으로 받으므로 흙길 명암이 자연스럽게 잉크 합성에 들어가며 pass 순서나 색공간을 바꾸지 않는다.
- baked highlight, AO, 광원 방향, 사진 고유 흔적을 source에 넣지 않는다. 실제 조명·안개·후처리가 계속 명암을 소유한다.

## 검증과 채택 기준

`npm run check:surface`는 기본 source hash, seed 결정론, 전역 난수 미사용, 호출자 변경 격리, 저대비 명도 범위, wrap seam, DataTexture 설정, production 도로 world UV, 빈 경로 무할당, 정확히 한 번의 dispose를 검사한다.

`npm run check:surface:browser`는 고정 카메라 OFF/ON을 OS 임시 폴더에 촬영한다. 같은 geometry에서 draw call·triangle·material 변화 0, texture +2, program family +1 이하, mean luminance 3% 이내, half-tile 상관, 작은 카메라 이동의 shimmer, 반복 생성 texture plateau, DataTexture albedo GLB 임베드를 검사한다. 시각 채택은 수치 통과만으로 끝내지 않고 두 PNG를 직접 열어 다음을 확인한다.

1. 근경 흙길이 단색 판보다 풍부하지만 얼룩 또는 수평 띠로 주의를 빼앗지 않는다.
2. 중·원경에서 mipmap으로 조용히 사라지고 모아레나 반짝임이 없다.
3. 교차로와 리본 경계에 texture seam이 없다.
4. 기존 경사면 초록 mute와 도로 등급 색 차이가 보존된다.

현재 파일럿은 첫 7.5m 축정렬 캡처에서 반복 띠가 보여 기각했고, 16m·27° 회전 월드 좌표로 수정한 재촬영본을 채택했다. ImageGen은 쓰지 않았다. 요구하는 것은 재사용 가능한 결정론 데이터와 정확한 물리 스케일이지, 생성 이미지의 고유한 미감이나 해상도가 아니기 때문이다.

## 표면 albedo 위계 (2026-07-26 실측)

수묵 트랙이 근접 프레임에서 "지붕이 벽보다 밝게 읽힌다"를 관찰하고 그 원인을 albedo로 가정했다가, 실측으로 **가정이 틀렸음을 확인**했다. 그 실측을 여기 남긴다. 이 절의 목적은 값을 기록하는 것이 아니라 **같은 오진이 반복되는 것을 막는 것**이다.

### 측정 방법

각 재질의 base color를 sRGB 상대휘도 `0.299R + 0.587G + 0.114B`로 환산했다(0~1 정규화). 텍스처를 base color로 쓰는 면은 텍스처 자체의 평균을 구했다 — 기와 지붕면은 `tileSurfaceMaterial`이 `color: 0xffffff`에 `makeTileTexture()`를 곱하므로, 캔버스 선형 그라디언트를 구간별로 적분하고 64px 주기의 어두운 홈 seam(면적 9.4%, 50% 블렌드)과 옅은 하이라이트(면적 4.7%, 7% 블렌드)를 반영했다. 조명·톤매핑·후처리는 포함하지 않은 **순수 재질 반사율**이다.

| 표면 | 소스 | 휘도 |
| --- | --- | --- |
| 여름 수관 | `src/env/seasons.js` `0x2a4020` | **0.21** |
| 기와 마루 `tileRidge` (`tileDark`) | `0x3f4249` | 0.26 |
| 기와 평면재 `tileFlat` | `0x4a4d53` | 0.30 |
| **기와 지붕면** | `tileSurfaceMaterial` = `0xffffff` × `makeTileTexture()` | **0.34–0.35** |
| 기와 볼록열 `tileConvex` | `0x6a6d73` | 0.43 |
| 담장 흙벽 `mud` | `0x9a7a54` | 0.50 |
| 백골 목재 `giwaWood` | `0x9a8a6f` | 0.55 |
| 초가 기단석 | `0xaa9878` | 0.60 |
| 기단석 (기와·절) | `0xa79f8f` | 0.63 |
| 지면 `ground` | `0xb5a893` | 0.67 |
| 초가 심벽 | `0xc9ad84` (+emissive) | 0.69 |
| 궁 회벽 `plaster` | `0xd9d2c4` | 0.83 |
| 반가 흰 회벽 | `0xe0dccb` (+emissive `0x2e2a22`) | 0.86 |

### 판정 1 — 기와를 더 낮추지 않는다

**위계는 이미 정확하고 고증에 맞다.** 기와(0.35)는 건물에서 가장 어두운 면이며 회벽(0.86)의 약 2.5분의 1로, 「동궐도」계열 기록화의 검은 기와 위계와 일치한다. 따라서 "동양화의 검은 기와"를 근거로 기와 albedo를 더 낮추자는 제안은 **이미 충족된 요구를 두 번 적용하려는 것**이며, 실행하면 다음 네 가지를 동시에 깨뜨린다.

1. **역광면이 순흑으로 무너진다** — `project-status.md`의 "crushed-black silhouette 금지"·"바운스가 그림자 측을 들어올린다" 결정 위반.
2. **Fresnel 림이 카툰 외곽선이 된다** — 검은 덩어리 위의 딱딱한 밝은 테두리로 읽혀 `look-grammar.md` §2-3의 채도 규율(대기와 무관하게 튀는 악센트 금지)을 위반한다.
3. **`patchSnow` 흰틴트가 적설이 아니라 페인트로 읽힌다** — 지붕 흰틴트는 base와의 대비로 성립하므로 base를 낮추면 대비가 과해진다.
4. **야간 창불이 지붕 질량 대비 과대해진다** — `userData.hanjiGlow` 창호 발광은 지붕 톤을 기준으로 균형이 잡혀 있고, 처마 등롱 < 창불 위계도 함께 흔들린다.

### 판정 2 — "지면이 건물보다 어둡다"는 규칙을 기와에 적용하지 않는다

안정 결정 "지면 albedo는 건물보다 어둡게 유지한다"는 **벽에 대해 성립한다**(회벽 0.86 > 지면 0.67). 그러나 **기와(0.35)는 지면(0.67)보다 의도적으로 어둡고, 그게 옳다** — 구운 기와의 실제 반사율이 마당 흙보다 낮다. 그 규칙을 기와에 기계적으로 적용해 지붕을 밝히려는 시도는 막아야 한다.

### 판정 3 — 수묵에서 지붕이 밝게 읽히는 원인은 albedo가 아니라 조도다

지붕은 상방을 향한 큰 면으로 하늘 반구 전체와 직사광을 거의 정입사로 받고, 벽은 수직면이라 저각 태양에 스침 입사이며 깊은 처마 아래 자기 그늘에 든다. albedo 2.5배 열세를 조도가 뒤집는다. 수묵 pass의 농담 입력 정규화가 그 차이를 한 번 더 벌린다.

**회화는 태양이 없어 화원이 재질 정체성으로 톤을 배정하지만, 수묵 pass는 조도 결과만 본다.** 재질 기준 톤 배정을 하려면 per-object role 채널을 노멀 pass로 실어보내야 하고 그것은 프로그램 축 +1이므로(`look-audit-2026-07.md` R8 미해결) 현재는 채택하지 않는다. 즉 이것은 **스크린 스페이스 수묵 pass의 알려진 한계**이며 팔레트 결함이 아니다. [`ink-landscape.md`](ink-landscape.md)의 미학 원칙 8은 이 한계와 충돌하지 않도록 "단계 수"가 아니라 "씬 휘도가 그 단계를 점유하는지"로 서술되어 있다.

### 부수 결론 — 부감 담장선 가독은 톤이 아니라 가림 문제다

담장(0.50)·기단(0.63) 대 여름 수관(0.21)은 이미 2.4~3배 톤 대비를 갖는다. 따라서 부감에서 담장·고샅 구획이 안 읽히는 것은 톤 부족이 아니라 **수관이 덮는 면적** 문제다. 레버는 담장 톤 강화가 아니라 마을 인접 수관의 밀도·높이 감쇠이며, 숲 밀도 총량은 유지해야 한다(민둥산 금지 결정). 해당 팔레트·밀도는 `forest-crunch.js`가 소유하므로 worker/sync 해시 재기준이 따라온다.

**#20 구현**: `villageCanopyAtten`(`src/village/forest-canopy-atten.js`, consumed by
`forest-crunch.js`)이 분지 반경·구조물 클리어런스로 높이(≤40%)·폭(≤16%)을 감쇠하고,
`mtnChance`/`infillChance`는 같은 목표 그루수를 외곽·빈터로 재배치한다. 순수 계약
`npm run check:forest-canopy`. 운무 절단 쪽은 `buildEdgeMistRing`의 표고 제곱 pool +
`yCap≈0.40 Hmax`와 능선 2단 뱅크 튜닝(`computeRidgeMistAnchors`)이 함께 담당한다.

## 기와 telephoto alias 완화 (#150 item I) — 제품 한계

망원 포커스(약 10°/7°)에서 기와 면이 서브픽셀로 줄어들 때 기왓골 텍스처 홈·과한
`instanceColor` 암단·낮은 roughness sparkle 이 겹치면 검은 선 뭉침으로 읽힌다. 새 재질군·
LOD 대체 mesh·스크린스페이스 필터 없이 기존 tile 경로만 재튜닝한다.

### 채택 레버 (구현)

| 레버 | 위치 | 내용 |
| --- | --- | --- |
| `tileDark` 분리 | `material-colors.js` | 마루 톤을 평면(`tile` Y≈0.30)보다 분명히 어둡게(Y≈0.26, 분리 ≈0.04). 과거 `tile`/`tileDark` 거의 동일 → 마루 위계 없음. 순흑 직전까지 내리지 않음. |
| 텍스처 홈 대비 | `palette.js#makeTileTexture` | 홈을 `rgba(48,50,56,0.32)` 로 완화(구 `rgba(30,31,36,0.5)`). 근경 골 가독은 bump + 수키와 기하가 담당. |
| roughness 밴드 | `TILE_LOOK` | ~0.985 matte (`roughnessMin` 0.97–0.995). 낮은 roughness 스펙큘러가 역광·망원에서 골을 금 점선으로 읽히게 한다. |
| bump 기본값 | `TILE_LOOK.bumpSurface` / `bumpSugiwa` / `bumpMatbae` | 0.32 / 0.22 / 0.45. `roof-skeleton`·`palette`·`tileroof`·`roof.js` 공유. |
| 좁은 지붕 `instanceColor` | `variants.js#GIWA_ROOF` | 채널 끝 ≈[0.90,1.03], jitter 0.025. 초가 이엉 스프레드는 유지. wealth→톤 단조는 유지. |

순수 계약: `npm run check:tile-look` (휘도·분리·roughness·bump 상수 배선·GIWA_ROOF 밴드).
기하 등간격은 `npm run check:giwa-tile-course`.

### 역광 금 점선 (PBR 골 + 림 스택)

제품 sunset에서 기와 골·배경 집에 금 점선이 잦다. 시각 A/B로 원인이 둘로 갈린다:

| 원인 | 증거 | 레버 |
| --- | --- | --- |
| **PBR 스펙큘러 on 골 기하** | `post=0` / 림 OFF 에도 점선 유지 | `TILE_LOOK` roughness↑, bump↓ (위 표) |
| **재질 Fresnel 림** | 타일 field·고주파 실·DoF 밖 이웃 | 아래 림 스택 |

림 스택 (`src/env/rim.js`, 게이트 `npm run check:rim`):

1. **`RIM_FRESNEL_AA`** — `fwidth` 로 고주파 그레이징 감쇠 (MSAA는 셰이딩 앨리어스를 못 막음)
2. **`RIM_TILE_SURFACE_MUL = 0`** — `tileSurface`/`sugiwa`/`tileRidge`… field 림 끔. 처마 킥은 `eaveBand`·목재
3. **`RIM_DOF_GATE`** — DoF 축방향 focus 대비 디포커스 거리에서 이웃 림 감쇠 (`amount=0`이면 비활성)

근경 골 가독은 기하 수키와가 담당한다. 수키와 튜브 반경 자체는 이 계약 밖.

### 제품 한계 (이 항목이 하지 않는 것)

1. **MSAA/해상도 한계를 제거하지 않는다.** 컴포저 경로 기하 AA(`check:aa`)와 DPR 캡은 별 축이다.
   기와 골 피치(0.34m)가 망원 1px 아래로 내려가면 어떤 albedo 튜닝도 완전 소실을 보장하지 않는다.
2. **albedo 위계를 뒤집지 않는다.** 판정 1 — 기와를 더 낮추지 않는다. 검은 선을 "더 검게" 가려
   없애려는 시도는 역광 crushed-black·림 카툰화·적설 대비 붕괴를 부른다.
3. **새 재질군·program family·draw call 을 추가하지 않는다.** FAR impostor 는 같은
   `giwaRoofAverage`/`tileDark` 토큰을 곱틴트한다. 텍스처 mip 정책을 지붕 전용으로 분기하지 않는다.
4. **근경 기왓골 디테일을 텍스처 대비로 복원하지 않는다.** 홈을 부드럽게 한 뒤 근경에서 골이
   약해 보이면 기하 수키와·bumpScale 쪽을 본다. 텍스처 순흑 홈 회귀는 금지.
5. **초가·궁 양성바름·처마 단면(`eaveBand`)은 이 계약 밖.** 초가 이엉 스프레드는 부감 다양성
   신호로 유지한다.
