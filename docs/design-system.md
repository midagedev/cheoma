# cheoma UI design system (Spectrum)

**Not a skin of the old CSS.** Rebuild product chrome as one professional simulator shell, using Adobe Spectrum Web Components where they win, and intentional native controls only where product contracts demand them.

## Product goals → chrome role

| Goal | Chrome implication |
|------|--------------------|
| Scene is the product (eave / rim / golden hour) | Floating chips stay glass and quiet; idle fade remains; chrome never competes with the frame. |
| House = touch + edit + regenerate | Inspector is a real properties column: dense rows, honest rebuild cost, sticky primary action. |
| Clip-worthy three.js demo | Environment lives in the CAD inspector column — dense segments, not a floating dial. |
| Joseon authenticity | Brand seal (처마 낙관) and paper References only; tools stay cool tool UI, not faux-hanji panels. |

## Non-negotiable contracts

1. **Layout.** Desktop/landscape = right inspector dock; stage `right: var(--inspector-w)`. Portrait = bottom sheet peek/half + view-shift. Gate: `npm run check:ui-shell`.
2. **Two-layer boundary.** Spectrum only in `app/`. Core `src/` stays free of Svelte and SWC.
3. **Stable product hooks** (update gates in the same change if a hook must move):
   - Shell: `data-make-panel`, `.actions`, `[data-breadcrumb]`, `.seal-label`, `.dial`
   - Mode: `#make-tab-village`, `#make-tab-house`, `.axistab`
   - Groups: `.advtoggle`, `[data-group]`, `[data-group-body]`, `.costbadge`
   - Actions: `.rebuild`, `.hbtn.reroll`, `[data-action=postcard|share|export]`
   - Params: `[data-key]` / `[data-vkey]` on field roots; continuous ranges keep a focusable `input[type=range][data-key]` for live-edit + browser gates
   - Nav: `[data-building-navigation]`, `.navaction`

## Optimal material map (why not “everything is SWC”)

| Zone | Role | Material | Why |
|------|------|----------|-----|
| **Theme root** | Token inheritance | `<sp-theme system="spectrum-two" color="dark" scale="medium">` | One dark Spectrum language for all tool chrome. |
| **Inspector shell** | Dock / sheet geometry | Custom layout + Spectrum surface tokens | Detents, `--inspector-w`, grip are product geometry, not Spectrum components. |
| **Mode axis** | Explore ↔ Focus | Segmented control (Spectrum tokens) with `.axistab` | Tab = camera morph; must stay 44px-touch and gate-stable. |
| **Selection header** | What the panel edits | 28px badge + name + path row atop the dock | CAD panels name their subject; `선택 없음 — 마을 속성` when nothing is focused. |
| **Share tools** | Photo / share / export | 28px icon toolbar (inline SVG + sr-only labels) | Commands, not views — never drawn as tabs. |
| **Building nav** | Keyboard reach to parcels | Native `<select>` + `.navaction` button | Grouped landmarks/houses; product keyboard + app-smoke require a real select. |
| **Continuous params** | Geometry live-edit ranges | Native `input[type=range]` + `PropertyField` value cell (52px editable field: drag-scrub, type-to-commit, unit suffix, hover ↺) | High-frequency `input`/`change`, Playwright focus/arrow, `check:parcel-rebuild` — SWC shadow range is the wrong tool. |
| **Discrete params** | Stepper / segment / checkbox | Native controls styled by `--cad-*` tokens (`.cad-seg`, `.cad-check`, `.cad-btn`) | 2026-07-29 rebuild: SWC field atoms retired (only `sp-theme` + solo-dial `sp-action-button` remain); flat 24px segments, 13px checkboxes in the value column. |
| **Primary rebuild** | Village / house reroll | 28px flat accent button, classes `.rebuild` / `.hbtn.reroll` | One sticky primary per context; full-round pills retired. |
| **Group headers** | Foldable CAD sections | 20px sticky rows, neutral 12px/600 + chevron + `N 변경` counter | Default all-open (`check:ui-shell` contract); fold state persists in localStorage, Alt-click isolates. |
| **Environment** | Time / season / weather / ink | Dense segments inside inspector (`.dial`) | Not a floating tray on village; solo scenes keep the dial. |
| **Path / status / dock** | Breadcrumb, seal, action bar | Glass chip + Spectrum-aligned type | Over WebGL; glass is intentional, not a second design system. |
| **Brand only** | 처마 stamp, References paper | Seal red + light paper surface | Oriental brand signal; never paint the inspector 한지. |

## Information architecture

```
┌ path (glass) ──────────────────────────┬ INSPECTOR CAD column (opaque Spectrum) ┐
│ Village › House                        │ [Explore | Focus]                        │
│                                        │ photo · share · export                   │
│                 SCENE                  │ building picker → Go                     │
│                                        │ ── environment (time/season/wx/ink) ──   │
│ 처마 #seed  [dock]                     │ ── scale / type (pinned) ──              │
│                                        │ all param groups OPEN (dense rows)       │
│                                        │ [ ↻ rebuild ]                            │
└────────────────────────────────────────┴──────────────────────────────────────────┘
```

### Mode map

- **Explore:** environment + scale + palace/temple + all terrain/composition/vocab rows + rebuild village.
- **Focus (residential):** environment + type + all schema groups (plan → yard…) expanded + rebuild house.
- **Special compounds:** shorter schemas from `edit-schema.js` — same chrome, different sections.

## Visual rules

- **One tool system:** dark Spectrum for inspector, dialogs, sheets. No dual “한지 panel + CAD panel.”
- **Glass only over the scene:** path, dial, action dock, status chip.
- **Brand accent:** seal red (`--cheoma-seal`) only on the 낙관; tool accent follows Spectrum accent (cool).
- **Density:** CAD-tight property rows; all groups open; primary targets ≥ 44px on coarse pointers.
- **Cost honesty:** show settle/wave badges; keep live cost in DOM for gates but visually quiet (default path).

## Code layout

```
app/src/ui/
  spectrum-register.js   # explicit SWC side-effect imports
  tokens.css             # shell geometry + glass + Spectrum surface bridge
  PropertyField.svelte   # schema field → optimal control material

app/src/styles/global.css  # brand paper + legacy alias tokens for non-tool surfaces
app/src/components/        # product logic (schema, i18n, engine) consuming ui/*
```

Components own product behaviour; they do not re-invent control chrome.

## Rebuild order (done when each step is true)

1. Foundation: packages, `sp-theme`, register, tokens, this contract. **done**
2. Inspector: ContextPanel + BottomSheet surface + PropertyField wired for every schema field. **done**
3. Status + Action bar + Breadcrumb glass chips (Spectrum type scale / action buttons where useful). **done**
4. Environment dial tray chrome (rings may stay custom). **done** (actions = `sp-action-button`; rings custom)
5. Reference / guide overlays on Spectrum tone (paper only where brand needs it). **done** (References = brand paper; SceneGuide / cine / glossary = glass + tokens)
6. Prune dead control CSS; keep shell geometry CSS required by gates. **done** (inspector grain removed; component CSS is layout-only)

## Anti-goals

- React / React Spectrum.
- Spectrum inside `src/`.
- Changing village generation or edit-schema field sets “for the redesign.”
- Breaking `check:ui-shell` / parcel browser hooks without updating those tools in the same change.
- Painting tool chrome as traditional paper to look “more Korean.”

## Verification

- Visual: desktop Explore, house Focus (all groups open), mobile peek/half, landscape rail.
- Contract: `npm run check:ui-shell`.
- Edit path: `npm run check:parcel-rebuild:browser` when param chrome changes.
- Smoke: enter village, rebuild, focus house, drag range, toggle switch, open references.
