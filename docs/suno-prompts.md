# Suno AI BGM 프롬프트 세트

데모의 시간대·장면 프리셋과 1:1로 매핑되는 BGM 트랙 설계. 스타일 프롬프트는 영어가 인식이 잘 되므로 영어로 작성, 각 트랙에 용도 설명을 붙임.

## 공통 지침

- **반드시 Instrumental 모드로 생성** (보컬이 들어가면 앰비언트로 못 씀). 프롬프트에도 `instrumental, no vocals` 명시.
- 각 트랙 2~3회 생성해서 **루프 포인트 잡기 좋은 것**(시작·끝이 조용한 것)을 고를 것.
- 웹 데모용이므로 다이내믹이 과하지 않은 것 우선 — 갑자기 커지는 구간이 있으면 배경음으로 피로함.
- **라이선스 주의**: 상업적 사용·공개 배포 권리는 Suno 유료 플랜(Pro/Premier)에서 생성한 트랙에만 부여됨. 데모가 공개 배포+트윗 영상에 들어가므로 유료 플랜 계정으로 생성 권장.
- 파일은 mp3 128kbps 정도로 변환해 용량 관리 (트랙당 2~3MB 목표).

## 트랙 목록

### 1. Main Theme — 기본 낮 장면 (한낮 프리셋)
> Serene Korean traditional ambient, meditative gayageum plucks and soft daegeum bamboo flute melody, sparse and spacious arrangement, gentle stream-like flow, mountain temple atmosphere, slow tempo 60bpm, warm and peaceful, instrumental, no vocals, minimal percussion

- 용도: 데모 진입 시 기본 BGM. 가야금 + 대금 조합이 "조선"을 즉시 각인.
- 길이: 2~3분, 루프.

### 2. Dawn Mist — 안개 낀 새벽 프리셋
> Ethereal Korean zen ambient, solo daegeum bamboo flute with long breathy sustained notes, vast reverb, morning mist over mountain ridges, extremely sparse, drone underneath, contemplative and mysterious, slow free rhythm, instrumental, no vocals

- 용도: 새벽 프리셋. 새소리 환경음과 겹치므로 멜로디 밀도가 거의 없어야 함.

### 3. Golden Hour — 노을 프리셋
> Warm Korean traditional fusion ambient, geomungo zither deep tones with soft haegeum string melody, nostalgic and glowing, sunset over hanok village, gentle swells, tempo 70bpm, cinematic but restrained, instrumental, no vocals

- 용도: 노을 프리셋. 해금의 애수가 오리엔탈 판타지 감성의 정점 — 트윗 클립용 1순위 후보.

### 4. Moonlit Night — 밤(등불) 프리셋
> Quiet Korean night ambient, soft geomungo plucks and distant temple bell hits, deep silence between notes, moonlight stillness, subtle drone, crickets-friendly sparse texture, very slow, meditative, instrumental, no vocals

- 용도: 밤 프리셋. 풀벌레·풍경 소리가 주인공이 되도록 음 사이 여백이 큰 트랙.

### 5. Village Walk — 도시/마을 탐색 모드 (v4)
> Light Korean folk ambient, playful piri and gayageum interplay over soft janggu drum pulse, walking pace 85bpm, lively village market morning, warm and rustic, folk melody fragments, instrumental, no vocals

- 용도: 1인칭 마을 탐색. 유일하게 리듬이 있는 트랙 — 걷는 속도감.

### 6. Genesis — 트윗 클립/조립 애니메이션 전용 (10~20초 훅)
> Cinematic Korean traditional crescendo, gayageum arpeggio building layer by layer, daegeum flute soaring entrance, janggu drum roll swell into a majestic open chord, awe and wonder, builds from silence to full bloom in 15 seconds, instrumental, no vocals

- 용도: 건물이 부재별로 조립되는 애니메이션 클립 전용. "조용히 시작 → 15초에 만개" 구조를 명시했으니, 생성 결과 중 빌드업 타이밍이 맞는 것을 고르고 클립 편집 시 조립 완료 순간과 화음 만개를 싱크.

## 생성 후 전달 방법

받은 파일은 `assets/audio/` 에 넣어주면 됨 (예: `main-theme.mp3`, `dawn.mp3`, `sunset.mp3`, `night.mp3`, `village.mp3`, `genesis.mp3`). 시간대 프리셋과 연동해서 크로스페이드 전환을 구현할 예정.

## 수령 현황 (2026-07-16 — 6/6 완료)

| 파일 | Suno 원제 |
|---|---|
| main-theme.mp3 | Temple Stream |
| dawn.mp3 | Mist Over Seorak |
| sunset.mp3 | Hanok Ember Drift |
| night.mp3 | 달그림자 절 |
| village.mp3 | Market Song |
| genesis.mp3 | Moon Gate Bloom |

총 약 23.7MB — 배포 전 128kbps 재인코딩으로 트랙당 2~3MB 목표 (음질 확인 후).
