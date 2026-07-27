# 바이럴 클립 스테이지 (`?clip=`)

> - **상태**: 계약 (2026-07, #253–#261)
> - **범위**: OS 화면 녹화용 **고정 부팅 경로**. 인앱 Record 버튼 없음.
> - **관련**: [`clip-beat-sheet.md`](clip-beat-sheet.md), [`clip-release-package.md`](clip-release-package.md), [`look-grammar.md`](look-grammar.md)

## 한 줄

공유 가능한 순간의 seed·시간·카메라 경로를 `?clip=` 하나로 고정한다. 생성 *과정*과 플래그십 룩이 미디어다.

## 스테이지

| id | 훅 | boot | 권장 URL |
| --- | --- | --- | --- |
| `assemble` | 종가 부재 조립 (고원) | hero 자동 진입 | `?clip=assemble` |
| `yard` | 마당 근경 DoF·생활 | village → 주거 focus | `?clip=yard` |
| `aerial` | 배산임수 부감 | village 부감 | `?clip=aerial` |
| `night` | 달·창호 | village 부감 · night | `?clip=night` |
| `ink` | 수묵 산수 | village 부감 · ink | `?clip=ink` |

공통 고정: **seed=7 · vseed=7 · village 규모 · clear 날씨**.  
assemble/yard/aerial 는 **sunset**; night 는 **night**; ink 는 **day + mode=ink** (본편 PBR과 섞지 않음).

## 제품 경로

- Pure 계약: `src/share/clip-stage.js` · façade `src/api/clip-stage.js`
- URL: `app/src/lib/url.js` — canonical scene snapshot 이 있으면 snapshot 우선
- 부팅: `App.svelte` `scheduleClipStageBoot` — autoEnter 시 hero/ focus 자동
- 첫 진입 카메라: `architectural-reveal.js` **2-beat** (orbit 전 구간 + FOV/dolly 지연 푸시인, #254)

## 녹화 메모

1. 위 URL 로드 → (assemble) 타이틀 후 자동 진입 또는 한 번 클릭
2. OS 녹화 (⌘⇧5 등)
3. 빈 터 유휴를 늘리지 말 것
4. 스테이지마다 **별 테이크** — 한 테이크에 assemble+ink+night 혼합 금지

## 게이트

- `npm run check:clip-stage`
- `npm run check:cinematic` (2-beat 리빌 포함)
