# HANDOFF — 2026-07-26 (post PR wave #167–#178)

세션 인계 기록. **계약 문서가 아니다** — 계약과 충돌하면 계약이 우선한다.
읽는 순서: `CLAUDE.md` → 이 문서 → `docs/README.md` → `docs/project-status.md`.

`main` 베이스 ≈ 최신 `origin/main` (이 라운드 PR #167–#177 머지, ink fbm 후속 머지 중일 수 있음).
`npm run check` **67/67 PASS** (forest-canopy 게이트 추가 후).

---

## 1. 이 라운드에서 머지된 것

| PR | 내용 |
| --- | --- |
| #165–#166 | 농촌 필지·마당 확대 (LOT/structure 분리) + worker 골든 |
| #167 | `tools/_tmp-probe-*` 잔여물 삭제 |
| #168 | 장독 항아리 피치/슬랩 오버플 |
| #169 | 히어로 조립 중 nightlight owner suppress (부유 한지) |
| #170 | 마을 모드 위치성 SFX 앵커 (stream/chime getters) |
| #171 | 기와 후속 4건 (피치·UV·세계 slope·회첨 eave) |
| #172–#173 | 몸채 배제 재도입 + plan 골든 |
| #174 | 클립 비트 시트 문서 |
| #175 | 농촌 기와 L/H → ~2.55 (giwa depth boost) |
| #176 | 운무 절단 + 부감 캐노피 atten |
| #177 | DoF 물리 CoC + 틸트시프트 + MSAA |

## 2. 진행 중 / 후속

- **R8 프로그램 다이어트** — 인벤토리 완료. PR1 후보: LOD screen-door를 rim 재질에 상시 패치해 plain×lod 가족 분기 제거 (`check-rim-facing` 계약 갱신 필요).
- **낙엽 투광 post ON** — `uLeafTransmit` 재판정 (선택).
- **capital 호수 밀도** — 제품 판단 (한양 목표 104 vs 실측 ~36–57).
- **회첨골 기와** — #171 정렬만; 골 타일 미구현.
- DoF 시각 판정: sunset A/B (`shoot:dof` / `shoot:door-dof`) 사람/비전 권장.

## 3. 작업 방식

서브에이전트 worktree 병렬 → 리드가 PR·머지. 서브에이전트는 git commit/push 금지(리드가 수행).
