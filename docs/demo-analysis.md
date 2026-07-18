# 인기 건물 생성 데모 분석 (바이럴 공식 역설계)

조사일: 2026-07-16. 목적: @threejs 리트윗을 받는 데모들의 공통 패턴을 역설계해 asiahouse에 적용.

## 1. 사례별 정리

### 사례 A — Procedural Hong Kong Building Generator ★직접적 선례
- 제작자/URL: achrefelouafi — https://github.com/achrefelouafi/BuildingGeneratorThreeJS (소스 공개, ★289). 원본은 Udayjeet Singh의 Blender 지오메트리 노드 셋업 (https://sketchfab.com/3d-models/procedural-hong-kong-building-528a732e84c44fd49c4726f341014a23).
- 검증: 저장소 살아있음. **라이브 데모 URL 없음** — `npm run dev`로만 실행. (이것이 최대 약점이자 우리가 뛰어넘을 지점.)
- 생성 방식: Blender 592노드 지오메트리 노드를 TS 배치 알고리즘으로 역설계 이식. 시드 해싱 + 그리드 배치. 약 190개 부품(벽·창문·에어컨·빨래줄·상점·옥상 소품)을 인스턴스드 애셋 키트(GLB + manifest JSON)로 구성.
- UX: lil-gui **18개 파라미터 실시간 슬라이더** — 층수, 풋프린트, 에어컨/빨래줄 확률, 창문 타입, 시드, low-poly 토글.
- 기술: TypeScript, InstancedMesh, GLB 애셋 키트.
- 화제성: 커뮤니티 관심은 있으나 @threejs 리트윗 기록 없음.

### 사례 B — Hex Map Toy (WFC) ★비주얼·UX의 모범
- 제작자/URL: Felix Turner — 라이브: https://felixturner.github.io/hex-map-wfc/ , 아티클: https://felixturner.github.io/hex-map-wfc/article/ , 소스: https://github.com/felixturner/hex-map-wfc
- 생성 방식: Wave Function Collapse, 19개 육각 그리드(~4,100셀), 3단계 충돌 복구.
- UX: 헥스 클릭 확장, "Build All", 50개+ 파라미터 GUI.
- 비주얼: **틸트-시프트 DOF + AO + 비네팅 + 필름 그레인의 미니어처/디오라마 미학.** 애니메이션 물(Bad North 참고).
- 기술: three.js r183, **WebGPU + TSL**, **BatchedMesh** (38개 메시 → 드로우콜 몇 번, 60fps).

### 사례 C — Procedural 3D Kitchen Designer
- Nikolai Stakheiko — Codrops 아티클(2025-07): https://tympanus.net/codrops/2025/07/29/exploring-the-process-of-building-a-procedural-3d-kitchen-designer-with-three-js/
- Figma식 펜 도구로 2D 평면도 드로잉 → 3D 토글. 표준 폭 자동 분할 규칙 기반.
- 2024-11 X 공유 → "압도적으로 긍정적" 반응. 실용성이 반응을 이끈 사례.

### 사례 D — Procedural Dungeon Generator (2026) ★"생성 과정 연출"의 모범
- Majid Manzarpour — https://github.com/majidmanzarpour/threejs-procedural-dungeon (MIT)
- 결정론적 시드 + Delaunay/MST, 5개 테마. **시드 입력/주사위 랜덤**, **파이프라인이 단계별로 켜지며 방이 하나씩 지어지는 연출** ("watch it build itself, room by room"). 커스텀 bloom + 틸트-시프트.
- 핵심: "생성 과정을 보여주는 것" 자체가 GIF/영상 콘텐츠가 된다.

### 사례 E — mrdoob "city" (100줄 절차적 도시, 역사적 원형)
- 파생: https://github.com/jeromeetienne/threex.proceduralcity
- 큐브 2만 개 랜덤 생성 → 단일 지오메트리 병합. "단순한 규칙 + 대량 반복 + 단일 드로우콜"이라는 원형 미학.

### 사례 F — PolyTrack (Kodub) — 브라우저 3D 바이럴 롱런 표본
- https://polytrack.art/ , https://kodub.itch.io/polytrack
- low-poly 레이싱, **브라우저 즉시 플레이**, 레벨 에디터로 제작·공유 루프. "접근 장벽 0 + 사용자 생성/공유 루프"가 장기 바이럴을 만든다.

### 사례 G — 2025 Vibe Coding Game Jam (AI 제작 트렌드의 결정판)
- https://jam.pieter.com/ — 코드 80%+ AI 작성, 웹에서 로그인 없이 무료 플레이가 규칙, three.js가 사실상 표준.
- 1,000개+ 출품. 심사위원: **mrdoob + Andrej Karpathy + Tim Soret + levelsio**. "vibe coding"은 2025 Collins 올해의 단어.
- 시사점: "made with Claude / vibe coded" 프레이밍은 2025~26년 가장 강한 바이럴 순풍이며, mrdoob 본인이 AI 제작 데모에 우호적.

### 배경 트렌드 (Utsubo "What's New in Three.js 2026")
- https://www.utsubo.com/blog/threejs-2026-what-changed
- **WebGPU 프로덕션 레디** (2025-09 Safari 26으로 전 브라우저 커버, WebGL2 자동 폴백), TSL 채택 확산.

## 2. 공통 패턴 (증폭되는 데모의 조건)

1. **접근 장벽 제로** — 링크 클릭 → 빌드/설치/로그인 없이 즉시 실행. (사례 A의 "npm run dev만 가능"이 치명적 약점인 이유)
2. **"생성되는 순간"이 미디어가 된다** — 슬라이더/시드로 실시간 재구성되거나 단계별로 지어지는 장면이 곧 루프 GIF.
3. **시드 주사위 + 슬라이더** — "다시 굴리면 다른 결과"가 재공유를 유발.
4. **강한 아트 디렉션** — 틸트-시프트 디오라마, 절제된 팔레트, bloom·AO·그레인. "기술 데모"가 아니라 "예쁜 장난감"으로 보일 것.
5. **신선한 기술 훅** — WFC, WebGPU/TSL, "N줄로 만든 X" 같은 화제성 각도.
6. **오픈소스 + #threejs 태그** — 공식 계정 레이더에 걸릴 확률을 높임.
7. **AI 제작 서사의 순풍** — "vibe coded / made with Claude".

**미디어 형식**: 5~20초 무한 루프 GIF/영상. 첫 1~2초에 완성된 예쁜 결과 → 이후 생성/변주 과정.

## 3. asiahouse 적용 시사점

1. **사례 A를 벤치마크하되 약점 보완**: "규칙 → 배치 알고리즘 + 인스턴스드 부재 + 슬라이더 + 시드 + 스타일 토글" 구성을 참고하고, A가 놓친 **라이브 배포(단일 링크, 빌드 없음)를 반드시 제공**.
2. **파라메트릭 축**: 정면 칸수(間), 지붕 형식(맞배/우진각/팔작), 처마 곡률·서까래 밀도, 공포 단수, 층수, 단청 유무, 시드 주사위 + **국가 프리셋(한/중/일)** — "하나의 생성기 = 세 문화" 서사.
3. **"조립되는 순간"을 핵심 연출로**: 기단 → 기둥 → 공포 → 서까래 → 기와가 단계별로 쌓이는 애니메이션, 슬라이더 드래그로 지붕 곡선이 실시간으로 휘는 장면 = 완벽한 공유용 GIF. 공포·기와는 InstancedMesh/BatchedMesh.
4. **아트 디렉션**: 틸트-시프트 미니어처 + 자동 카메라 오빗 + 부드러운 AO/bloom. 단청 팔레트 또는 먹·기와 저채도 톤. WebGPU/TSL 기술 훅도 사용 가능(WebGL2 폴백 필수).
5. **배포·홍보**: (a) 단일 링크 배포(GitHub Pages/Vercel), (b) 소스 오픈 + #threejs, (c) 5~20초 루프 영상(첫 프레임 = 완성된 팔작지붕, 이후 시드 변주·3국 전환), (d) "made with Claude" 병기, (e) three.js 포럼 Showcase 동시 게시.

**핵심 한 줄**: 성공 공식은 "빌드 없이 열리는 링크 + 시드로 무한 변주되는 예쁜 디오라마 + 조립되는 순간의 루프 영상 + 오픈소스 + AI 제작 서사"이며, 동아시아 목조건축의 규칙성은 이 공식에 이상적으로 들어맞는다.
