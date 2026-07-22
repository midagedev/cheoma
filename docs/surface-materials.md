# 절차적 표면 재질

> - **상태**: 현재 계약 + 리서치
> - **기준일**: 2026-07-22
> - **현재 채택 범위**: 다져진 흙길 albedo + bump 한 종류

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
