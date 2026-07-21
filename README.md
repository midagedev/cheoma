# 처마 (cheoma)

**A procedural Joseon-era Korean village, grown from a seed — in the browser.**
조선 전통건축(궁궐·사찰·기와집·초가)과 마을을 파라메트릭으로 생성하는 three.js 앱.

**Live: [cheoma.midagedev.com](https://cheoma.midagedev.com)**

## Features

- **파라메트릭 한옥** — 칸(間) 체계·공포·팔작지붕 곡선을 파라미터로: 지붕 물매·처마 깊이·창호·단청까지 편집
- **마을 자동 구성** — 배산임수 지형 생성, 필지·담장·고샅, 다랑이 논·개울, 산사(山寺)
- **규모 연속 슬라이더** — 작은 촌락부터 성곽 도성(궁궐 다일곽·시전행랑·사대문)까지
- **궁궐 다일곽** — 행각으로 담을 공유하는 축선 스택 (경복궁 배치 고증)
- **시간·계절·날씨** — 골든아워 림 라이트, 적설·빗물 시뮬레이션, 야간 창호 불빛
- **focus 줌 연속체** — 부감↔근접 연속 줌, 필지별 편집·조립 애니메이션·앰비언스(닭·밥 짓는 연기·바람에 흔들리는 풀)
- **수묵화(먹) NPR 모드**

## Development

```bash
cd app
npm install
npm run dev     # dev server
npm run build   # → app/dist
```

Core generation modules live in `src/` (framework-agnostic ES modules); the Svelte 5 SPA in `app/` consumes them.

Repository-wide contract checks run from the root:

```bash
npm run check       # architecture + deterministic plan goldens
npm run check:pr    # affected contracts for the current branch/worktree
npm run check:app   # full app browser smoke
npm run check:worker
npm run check:all
npm run check:full  # merge gate, including optical/LOD app flows and app build
```

`check:pr` is the normal iteration entrypoint; use `npm run check:pr -- --dry-run` to inspect its fail-closed plan. Browser gates prefer a locally installed Chrome, report the actual WebGL renderer, and fall back to bundled Chromium. Set `CHEOMA_BROWSER=chromium` when the pinned Playwright backend is required.

## Documentation

- Contributor and coding-agent rules: [`AGENTS.md`](AGENTS.md)
- Document map and status: [`docs/README.md`](docs/README.md)
- Project direction and active work: [`docs/project-status.md`](docs/project-status.md)
- Architecture and reuse contract: [`docs/architecture-refactor.md`](docs/architecture-refactor.md)
- Verification guide: [`docs/verification.md`](docs/verification.md)

## License

MIT
