---
title: "Design System & Visual Identity"
lastUpdated: 2026-08-18
---

# OmniRoute — Design System & Visual Identity

> **Status:** reference — canonical description of the dashboard's design tokens, motion
> language, material system, and component conventions. The fork's visual identity is
> **burgundy + rose-gold ("Concept C")** layered with an **Apple fluid-interface** motion
> and material system (fork-only — see AGENTS.md; never port the brand surface to upstream).

---

## 1. Principles

- **Single source of truth = `src/app/globals.css`.** Tokens live in `:root`/`.dark` and are
  exposed to Tailwind v4 utilities via `@theme inline`. No `tailwind.config.*` (CSS-first).
- **Tokens, never literals.** Components consume semantic tokens (`bg-surface`,
  `text-primary`, `border-border`), never raw `#hex`. Intentional exceptions: always-dark
  console terminal, ReactFlow SVG strokes.
- **Restyle primitives in place, don't fork new ones.** 138 files render `<Button>`, 164
  render `<Card>` — changing the primitive re-skins the whole dashboard with zero call-site
  churn. A new component is only written when the scenario is genuinely unique.
- **Apple fluid interface:** feedback on pointer-down (not release), critically-damped
  springs as the default easing, glass materials reserved for floating chrome (restrained
  hierarchy), `prefers-reduced-motion/transparency/contrast` respected globally.
- **Tailwind utilities over custom classes inside composable primitives** where consumers
  override via `className` — `cn()` (tailwind-merge) can only dedupe utilities it knows;
  a custom CSS class would silently beat a consumer's utility override.

## 2. Palette (Concept C — burgundy + rose-gold)

Verified values from `src/app/globals.css`:

| Concept                      | Token                                 | Value                                                           |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| primary (light)              | `--color-primary`                     | `#7f1d1d`                                                       |
| primary hover                | `--color-primary-hover`               | `#991b1b`                                                       |
| brand gradient               | `--grad-brand`                        | `linear-gradient(135deg, #7f1d1d, #991b1b)` (`globals.css:113`) |
| rose-gold accent             | `--color-rose-gold` / `--color-ivory` | `#e0bfb8` / `#f5ebe0` (selective use)                           |
| success / warning / error    | `--color-success/warning/error`       | `#22c55e` / `#f59e0b` / `#ef4444`                               |
| light bg / surface / sidebar | `--color-bg/surface/sidebar`          | `#f9f9fb` / `#ffffff` / `#f5f5fa`                               |
| dark bg / surface / sidebar  | same tokens, `.dark` ("ClawHub deep") | `#0b0e14` / `#161b22` / `#10141e`                               |
| traffic lights               | `--color-traffic-red/yellow/green`    | `#FF5F56` / `#FFBD2E` / `#27C93F`                               |

- **Dark mode** = `.dark` class on `<html>` (`@custom-variant dark`), toggled by the Zustand
  store `src/store/themeStore.ts` (default `system`; FOUC-prevention inline script in the
  root layout reads the persisted store before hydration).
- **Runtime accent override:** `COLOR_THEMES` presets (default `brand` `#7f1d1d`, plus
  coral/blue/red/green/violet/orange/cyan + custom hex) write `--color-primary` inline on
  `<html>`. Consumers referencing `var(--color-primary)` inherit the override for free.
- **Radius scale:** `--radius: 14px` → `rounded-card` (surfaces), `--radius-control: 9px`
  → `rounded-control` (controls). Custom names so Tailwind's reserved `rounded-sm/md/lg`
  stay untouched.

## 3. Fonts

- **Geist + Geist Mono**, self-hosted via `next/font/local` (`public/fonts/`), CSS variables
  `--font-sans` / `--font-mono` injected on `<body>` (`src/app/layout.tsx`).
- **Do NOT redeclare `--font-sans`/`--font-mono` in `@theme inline`** — the utility would
  resolve to the `:root` system stack while `body` keeps Geist (the silent
  "font loads but isn't applied" bug; see AGENTS.md "Font cascade"). Guarded by
  `tests/unit/design-grid-background.test.ts`.

## 4. Apple fluid-interface layer (fork-only, `globals.css` §APPLE FLUID INTERFACE)

### 4.1 Motion tokens

| Token                     | Value                              | Use                                         |
| ------------------------- | ---------------------------------- | ------------------------------------------- |
| `--ease-spring-critical`  | `cubic-bezier(0.22, 1, 0.36, 1)`   | default: ambient UI, press feedback         |
| `--ease-spring-soft`      | `cubic-bezier(0.34, 1.4, 0.64, 1)` | momentum interactions (thumb settle, modal) |
| `--dur-quick/normal/slow` | `180/320/480ms`                    | feedback / ambient / large surfaces         |

Conventions: press feedback on `:active` (`scale(0.97)`, ~80ms), GPU-cheap properties only
(`transform`/`opacity`), no animation library — all motion is pure CSS. Arbitrary-value
form inside components: `ease-[var(--ease-spring-critical)]`,
`transition-[transform,box-shadow,border-color]`.

### 4.2 Glass materials (restrained hierarchy)

| Weight | Class      | Blur | Floating layer                     |
| ------ | ---------- | ---- | ---------------------------------- |
| light  | `.glass-1` | 12px | chips, segmented track, icon tiles |
| medium | `.glass-2` | 20px | toolbars, dropdowns, sheets        |
| heavy  | `.glass-3` | 32px | modals, command palette            |

Glass is for **floating chrome only** — cards and tables stay solid surfaces (`bg-surface`).
Never stack light glass on light glass. All three weights collapse to opaque
`--color-bg` under `prefers-reduced-transparency` and `prefers-contrast: more`.

### 4.3 Type scale

`.apple-display/-headline/-body/-caption/-eyebrow/-mono-num` — negative tracking on large
text (`-0.022em` display), ~0 body, tabular numerals for metrics (`.apple-metric` family).

### 4.4 Interaction + entrance classes

`.apple-pressable`, `.apple-card` (interactive card: hover lift + pointer spotlight +
press), `.apple-card-spotlight` (spotlight-only, pairs with utility-styled `Card`),
`.apple-btn` + `.apple-btn-primary/secondary/tertiary`, `.apple-modal-in` /
`.apple-scrim-in` (modal materialization + scrim cross-fade), `.spring-in` (staggered
entrance `spring-in-1..6`), `.apple-segmented` (segmented control), `.apple-toolbar`
(sticky glass bar), `.apple-status-dot(--pulse)`.

## 5. Primitives (`src/shared/components/`)

All composable primitives keep their public API stable; restyling happens **in place** so
call sites never churn.

| Primitive                                                   | Notes                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                    | Spring press on `:active`; `primary` = `.apple-btn-primary` (brand gradient material, single source with the AppleButton alias); `shape: "control" \| "pill"`; `icon` accepts a Material Symbols name **or** any ReactNode; `forwardRef`. 138 consumer files.                                      |
| `Card`                                                      | Material as Tailwind utilities (so `className` overrides keep working through tailwind-merge); `hover` prop adds lift + spotlight (`.apple-card-spotlight`); spring transitions. Sub-components `Card.Section/Row/ListItem`. 164 consumer files.                                                   |
| `ConceptCard`                                               | Shared explainer card (icon + title + description + collapsible details). Two toggle placements: `collapse="body"` (header chevron) and `collapse="details"` (inline toggle); optional `persistKey` (localStorage). Replaced the five per-page copies (memory/batch/files/quota-share/translator). |
| `Input` / `Select` / `Textarea`                             | Accent focus treatment (`focus:border-accent/60 focus:ring-2 focus:ring-accent/20`), property-specific transitions.                                                                                                                                                                                |
| `Toggle`                                                    | Spring thumb (`--ease-spring-soft`) + press stretch (`group-active:scale-x-110`).                                                                                                                                                                                                                  |
| `Modal`                                                     | `glass-3` panel + `.apple-modal-in` entrance + `.apple-scrim-in` scrim; traffic-light header; focus trap.                                                                                                                                                                                          |
| `CommandPalette`                                            | `glass-3` panel + spring entrance (⌘K).                                                                                                                                                                                                                                                            |
| `DataTable`                                                 | Theme-aware via `--table-*` tokens; opaque scroll surface.                                                                                                                                                                                                                                         |
| `SegmentedControl`                                          | Pure-CSS Apple segmented control (glass track + sliding spring indicator).                                                                                                                                                                                                                         |
| `Badge` / `Tooltip` / `Checkbox` / `Loading` / `EmptyState` | Token-driven; Tooltip uses dark glass + `.apple-scrim-in` fade.                                                                                                                                                                                                                                    |

**Apple-family roles (no parallel implementations):**

- `AppleButton` — **deprecated thin alias** over `Button` (`shape="pill"`); migrate call
  sites to `Button` directly. Kept so the 18 existing consumers keep working unchanged.
- `AppleCard` — opinionated interactive card (`.apple-card`, entrance springs) for
  hero/marketing surfaces; `Card` is the workhorse. Both share the same material tokens.
- `AppleSurface` — the glass-material primitive (`weight: light|medium|heavy`); genuinely
  unique, no twin.
- `AppleField` / `AppleInput` / `AppleTextarea` / `AppleSelect` — the Apple form-field
  composition system; unique, keep.
- `AppleMetric`, `AppleSectionHeader` / `AppleHero`, `AppleStatusDot` — metric/typography
  primitives; unique, keep.

Genuinely-unique explainer shapes that intentionally did **not** merge into `ConceptCard`:
`SkillsConceptCard` (comparison table), `SearchConceptCard` (concept grid),
`CliConceptCard` (type switcher).

## 6. Shell chrome

- **Header** — floating glass toolbar: `bg-bg/75 backdrop-blur-xl backdrop-saturate-150`
  with a soft hairline (`border-black/[0.04]`); content scrolls beneath it.
- **Sidebar** — macOS translucent sidebar: `bg-sidebar/80 backdrop-blur-2xl`; width
  collapse animates with the critical spring (`transition-[width]`); mobile drawer slides
  with the same spring.
- **SettingsShell** (`settings/components/SettingsShell.tsx`) — pill tab strip wrapping all
  11 settings pages; the tab list is **derived from `SIDEBAR_SECTIONS`**
  (`src/shared/constants/sidebarVisibility/`), so labels/order/icons can never drift from
  the sidebar.
- Grid wallpaper (graph-paper, 32px) stays global via `body::before`; transparent shells
  let it show through (guarded by `tests/unit/design-grid-background.test.ts`).

## 7. Performance conventions

- No animation library — all motion is CSS (springs as easings).
- Heavy libs (recharts, monaco, xyflow) are code-split via `next/dynamic`
  (`next.config.mjs` additionally isolates vendor chunks).
- Removed as unused (2026-08): `lucide-react`, `next-themes`, `mermaid` (docs diagrams use
  the global `mmdc` CLI). The dependency allowlist (`config/quality/dependency-allowlist.json`)
  blocks their return.
- Known follow-ups (deliberate, not regressions): `RequestLoggerV2` row memoization
  (extract a memoized row component; `groupedLogs` currently rebuilds row objects each
  poll), and Material Symbols font subsetting (365 consumer files).

## 8. Reuse map — check before writing a new component

1. Card-ish surface → `Card` (or `AppleCard` for interactive hero surfaces).
2. Button → `Button` (`shape="pill"` covers the old AppleButton cases).
3. Explainer/"how it works" card → `ConceptCard`.
4. Glass layer → `AppleSurface` / `.glass-1|2|3`.
5. Section header / hero text → `AppleSectionHeader`; metric → `AppleMetric`.
6. Settings pages → wrap in `SettingsShell`.
7. Only if none fits **and** the scenario is unique: write a dedicated component.

Deferred consolidation (documented migration path): the twelve cli-code `*ToolCard.tsx`
components (~6.3k lines) share a props contract (`tool, isExpanded, onToggle, baseUrl,
apiKeys…`) and should converge on a shared shell + per-tool body slots, one card per PR.

## 9. Reference index

| Area                       | Path                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Tokens, materials, motion  | `src/app/globals.css` (`:root`, `.dark`, `@theme inline`, APPLE layer)                            |
| Theme store                | `src/store/themeStore.ts` (`COLOR_THEMES`, `applyTheme`)                                          |
| Primitives                 | `src/shared/components/` (barrel: `index.tsx`)                                                    |
| Shell                      | `Header.tsx`, `Sidebar.tsx`, `layouts/DashboardLayout.tsx`                                        |
| Settings shell             | `settings/components/SettingsShell.tsx`                                                           |
| Sidebar nav single source  | `src/shared/constants/sidebarVisibility/`                                                         |
| `cn` util (tailwind-merge) | `src/shared/utils/cn.ts`                                                                          |
| Guard tests                | `tests/unit/design-grid-background.test.ts`, `tests/unit/risk-notice-modal-button-import.test.ts` |
