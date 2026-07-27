# #210 대표 원테이크 클립 — 릴리스 패키지

> - **상태**: 촬영·게시 준비 완료 (제품 코드 변경 없음). 실제 OS 녹화·트윗 게시는 **사람 전용**.
> - **범위**: 인앱 Record 버튼을 만들지 않는다. OS 화면 녹화만 쓴다 (`CLAUDE.md` 안정 결정).
> - **관련**: [`clip-beat-sheet.md`](clip-beat-sheet.md) (비트·타이밍 정본), [`look-grammar.md`](look-grammar.md), [`demo-analysis.md`](demo-analysis.md).

## 1. 한 줄 목표

**석양 역광 속에서 집이 부재 단위로 서고(~10초 조립), 처마가 주선으로 읽힌 뒤 마을이 산수처럼 열린다.**  
생성 *과정*이 미디어다 — 완성 스톡 샷만 돌리는 클립이 아니다.

## 2. Exact URL query

배포 도메인 (권장, 공유·녹화 모두 이 URL):

```text
https://cheoma.midagedev.com/?seed=7&time=sunset
```

규모·계절을 명시해 재현을 고정할 때 (village 기본값과 동일 의도):

```text
https://cheoma.midagedev.com/?seed=7&vseed=7&vscale=village&time=sunset&season=summer&weather=clear
```

로컬 검증 (dev server origin만 바꿈):

```text
http://127.0.0.1:5173/?seed=7&vseed=7&vscale=village&time=sunset&season=summer&weather=clear
```

| 파라미터 | 값 | 이유 |
| --- | --- | --- |
| `seed` / `vseed` | **7** | 게이트·측정 상시 시드. 재촬영 재현. |
| `time` | **sunset** | 플래그십 골든아워 역광. `?shot=1` 은 day 고정이라 **공유 클립에 쓰지 말 것**. |
| `vscale` | village (또는 hamlet) | 조립 가독 + 직후 부감이 과밀하지 않음. |
| `season` | summer (또는 autumn) | 채도 규율 안에서 림·수목이 분리. |
| `weather` | clear | 비·눈은 본편 조립을 가리기 쉬움. |
| 수묵 | off (기본 PBR) | 수묵은 별 클립. |

UI만 맞출 때: seed **7** · 석양 · village → 새로고침 → 로드 완료 → 녹화 시작 → Enter.

## 3. OS 녹화 단계 (macOS)

1. 위 URL을 **Chrome 또는 Safari**에서 연다. 창을 1080p 이상(권장 1920×1080 또는 전체 화면)으로 키운다.
2. 타이틀/로딩이 끝날 때까지 기다린다. 무거운 생성은 이 창에서 끝난다 — **빈 터를 길게 보여 주지 말 것**.
3. 화면 녹화 시작:
   - **Screenshot toolbar**: `⌘⇧5` → *Record Selected Portion* (캔버스 영역) 또는 *Record Entire Screen*.
   - 또는 **QuickTime Player** → File → New Screen Recording.
   - 시스템 오디오를 넣으려면 별도 루프백(BlackHole 등)이 필요할 수 있다. 무음 업로드면 무시.
4. 진입 제스처(**Enter / 히어로 클릭**) **직전 0.5초**부터 녹화.
5. 비트 시트 순서 (`clip-beat-sheet.md` §3):
   - t≈0–1.1s 베일·빈 터 (유휴 늘리지 않음)
   - t≈1.1–11.1s **조립 본편** (10s)
   - t≈11–14s 정착 홀드 (림·블룸·모트)
   - *(선택)* 브레드크럼/ESC → 부감 3–6s
6. 정지 → 앞쪽 로딩 스피너 트림. 착공 직전 빈 터는 **1초 전후만**.
7. **인앱 Record 버튼은 없다** — 감사에서 “녹화 없음”을 지적해도 만들지 않는다.

Windows 대안: Xbox Game Bar / PowerToys 등. 비트 타이밍은 동일.

### 하지 말 것 (요약)

- 인앱 클립 녹화 UI 추가
- 조립 중 휠·드래그로 카메라 뺏기
- 정오·`?shot=1` day 조명으로 본편 촬영
- 한 테이크에 편집·리롤·수묵·규모 슬라이더를 전부 넣기

## 4. 정지 프레임 증거 (자동 캡처)

제품 원테이크 **대체물이 아니다**. 게시 전 구도·시드·석양 역광이 살아 있는지 확인하는 스크래치 PNG다.

캡처 스크립트 (일회/스크래치, 게이트 아님):

```bash
CHEOMA_CLIP_OUT=scratch/clip-210 \
  node tools/run-browser-locked.mjs -- node scratch/clip-210/capture.mjs
```

| 컷 | 파일 (워크트리 상대) | 내용 |
| --- | --- | --- |
| 부감 | `scratch/clip-210/clip-seed7-village-sunset-aerial.png` | village · seed/vseed 7 · sunset 부감 |
| 처마 역광 | `scratch/clip-210/clip-seed7-village-sunset-eave-reverse.png` | 정규 기와 `p8` focus, 석양 DoF 정착 |
| 조립 중반 | `scratch/clip-210/clip-seed7-village-sunset-assembly-mid.png` | 히어로 랜딩 progress≈0.53, `__asm.seek(0.5)`, `maxScaleDev>0` |
| hamlet 부감 | `scratch/clip-210/clip-seed7-hamlet-sunset-aerial.png` | 동일 시드 hamlet 부감 (규모 비교) |
| 매니페스트 | `scratch/clip-210/manifest.json` | 쿼리·메타 로그 |

헤드리스 ANGLE/Chrome 데스크톱 GPU 캡처이므로 **절대 wall-clock ms는 근거가 아니다**. 리트윗 테스트(정지 프레임으로 처마·림·대기)만 본다.

## 5. Tweet / #threejs 초안

### 한국어

> 조선 한옥이 부재 단위로 서는 10초. 석양 역광 림 + three.js 절차적 마을.  
> cheoma — 처마 곡선을 그리는 procedural Joseon generator.  
> https://cheoma.midagedev.com/?seed=7&time=sunset  
> #threejs #webgl #procedural

### English

> Ten seconds of a Joseon hanok assembling piece by piece — golden-hour reverse-light rim, pure three.js.  
> cheoma: procedural Korean architecture & village generator.  
> https://cheoma.midagedev.com/?seed=7&time=sunset  
> #threejs #webgl #procedural

### Technical hook (one-liner, reply / alt text)

> Seeded village plan → instanced FULL/MID/FAR houses → tofu assembly ripple (`playAssembly`) under EffectComposer (Fresnel rim · energy-conserving bokeh · bloom) at sunset back-light. No in-app recorder — OS capture only.

## 6. 게시 체크리스트 (사람)

- [ ] URL이 `seed=7` + `time=sunset` (또는 UI 동등 상태)인지
- [ ] 본편 14–16s 또는 삼원 풀 20–28s, 빈 터 유휴 과다 없음
- [ ] 무음으로도 조립 리듬이 보이는지
- [ ] 정지 프레임 리트윗 테스트 (`look-grammar.md` §4)
- [ ] 트윗 본문 + 클립 첨부 + (선택) tech reply
- [ ] three.js 디스코드/포럼 교차 게시 시 동일 URL

## 7. 남긴 사람 일 (자동화 불가)

1. **실기기/실창 OS 화면 녹화** (⌘⇧5 등) — 본 문서 §3.
2. 트림·인코딩·업로드.
3. X / three.js 커뮤니티 게시 및 반응 대응.
4. 시드 7이 마음에 안 들면 고정 시드를 고른 뒤 §2 URL만 갱신.

코드 변경·인앱 녹화·게이트 추가는 **이 이슈 범위 밖**이다.
