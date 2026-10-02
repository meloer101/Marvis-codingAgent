# Design

Visual system for the `hc web` console. Strategic context lives in [PRODUCT.md](PRODUCT.md); this file answers "how it looks". Source of truth in code: `packages/web/src/index.css` (tokens), `packages/web/src/lib/theme.ts` (theme switching).

## Mood

"A bookbinder's workshop at dusk" — oiled wood, brass tools, violet twilight. 工匠感、迅捷、飞跃: a surface built for hours of reading, with the warmth carried by typography and one brass accent, never by a cream background.

## Color

Strategy: **Restrained+** — tinted neutrals in the violet hue family (285°), one violet primary (seed hue 280°), one brass accent. Light and dark are tuned independently, not mechanically inverted. All values OKLCH.

### Light

| Role | Value | Notes |
| --- | --- | --- |
| `background` | `oklch(0.982 0.004 285)` | near-white, whisper of violet — never cream |
| `foreground` | `oklch(0.235 0.02 285)` | violet ink, ~14:1 |
| `card` / `popover` | `oklch(0.996 0.002 285)` | elevation via near-white + border + `shadow-xs` |
| `primary` | `oklch(0.51 0.16 280)` | the brand violet; white text on fills |
| `muted-foreground` | `oklch(0.475 0.022 285)` | ≥4.5:1 — no washed-out gray |
| `brass` | `oklch(0.55 0.1 78)` | warm accent, text-safe on light bg |
| `brass-subtle` | `oklch(0.945 0.03 85)` | tint for pending/attention surfaces |
| `destructive` | `oklch(0.55 0.19 25)` | |
| `success` | `oklch(0.56 0.12 155)` | |
| `border` | `oklch(0.9 0.009 285)` | |

### Dark

| Role | Value | Notes |
| --- | --- | --- |
| `background` | `oklch(0.178 0.012 285)` | violet-twilight near-black (environmental tint, deliberate) |
| `foreground` | `oklch(0.925 0.009 285)` | ~14:1 |
| `card` / `popover` | `oklch(0.212 / 0.218 0.014 285)` | |
| `primary` | `oklch(0.485 0.14 280)` | deep enough for white text (≥4.5:1) |
| `muted-foreground` | `oklch(0.685 0.02 285)` | ≥4.5:1 |
| `brass` | `oklch(0.78 0.11 84)` | brighter for dark surfaces |
| `border` | `oklch(0.92 0.01 285 / 11%)` | alpha borders on dark |

### Semantic mapping

- **Violet (`primary`)**: identity, running state, links, plan review, focus rings, send/approve actions.
- **Brass**: waiting-on-you states — permission asks, pending dots, reconnecting banner, thinking marker, list markers, blockquote rule, the `·` in the wordmark.
- **Success / destructive**: tool results and diff add/del only.
- Text on saturated fills is always white/near-white (Helmholtz-Kohlrausch); dark text only on pale or neutral fills.

## Typography

Self-hosted via Fontsource (same-origin; the server CSP is `font-src 'self'`):

| Role | Face | Used for |
| --- | --- | --- |
| `--font-serif` | **Spectral** | assistant prose (`.md`), the wordmark, empty states, thinking body — the reading surface |
| `--font-sans` | **Hanken Grotesk Variable** | UI chrome: buttons, sidebar, labels, headers |
| `--font-mono` | **JetBrains Mono Variable** | code, paths, commands, usage numbers, kbd, tool names |

Rules: assistant prose is 15px/1.75 serif capped at 68ch; UI labels stay sans; CJK falls back to system fonts (PingFang SC / Noto). Code highlighting: Shiki `rose-pine-dawn` / `rose-pine-moon`, switched by `.dark` via CSS variables.

## Theming

- Class-based: `html.dark` toggles `@custom-variant dark`. `color-scheme` set per theme.
- `public/theme.js` applies the persisted theme before first paint (external file — CSP forbids inline scripts). `lib/theme.ts` owns state: `system | light | dark`, persisted as `hc.theme` via platform storage, OS changes tracked while in `system`.
- UI: one footer button in the sidebar cycles system → light → dark.
- Theme switches glide (180ms ease-out on background/border/color); all motion has `prefers-reduced-motion` fallbacks.

## Components

- **Sidebar**: serif wordmark `hc·web` (brass dot), card-style New session button with `⇧⌘O` hint, a search field (a small `⌘K` chip at its end opens the command palette), then one group per project — mono uppercase project name (11px, muted) with a fold chevron, and "+" / ⋯ that appear on hover. Session rows 13px, indented under their project; pinned ones carry a small pin at the left, archived ones are muted and behind an "Archived (n)" toggle. The row's end shows the most urgent state: brass dot (waiting for you), violet spinner (running), violet dot (unread), else a mono relative time; on hover it gives way to ⋯. Rename happens in place in a violet-ringed field. "Add project" sits below the groups; footer = theme toggle + notification bell + connection dot.
- **Menus**: popover surface, rounded-lg, 13px items with 14px muted icons, accent highlight; destructive items (Delete…) in the destructive colour, set apart by a separator.
- **Dialogs** (add project, delete session, remove project): centred popover card over a soft `foreground/25` overlay with a 2px blur, serif title, muted description. Reserved for decisions that deserve a pause — never for permission asks, which stay in the dock. The add-project preview is a `muted/40` panel; MCP servers are listed in mono with a brass plug icon, trust warnings in brass.
- **Session header**: project chip (folder icon + name) / session title (13px medium; click turns it into a violet-ringed field to rename) · the spend at the far right (mono ↑in ↓out and cost), opening the usage popover. A new session's draft header has a project dropdown and "New session".
- **Composer footer**: ghost controls (h-7, 12px medium, muted until hovered): the mode chip (icon + label; tinted violet for acceptEdits / plan / auto, destructive for YOLO, plain for ask / read only), the model (violet dot + mono short name), the effort (gauge icon + level). Each opens a popover menu above it: a mono uppercase heading, radio rows with a violet check, each mode with a one-line muted hint, each model with its mono ref, price at the right in 10px mono, and a muted line of facts (window · reliable span · reasoning) — or, for a model that can't run, a brass warning in its place. Before the send button, the context ring (16px, violet → brass ≥80% → destructive ≥92%, dashed before the first measurement) and its percent open the usage popover: context used of window, a thin bar, the breakdown by bucket, then the session's tokens and cost, all mono tabular. While a run is going Stop (secondary) sits beside a Queue button (list-end icon) that appears once something is typed.
- **Queued messages**: a dashed `muted/30` panel docked above the composer — mono uppercase "Queued · sent when this turn ends", then one row per message (corner-arrow icon, two lines max) with edit and remove icons that brighten on hover.
- **Attachments**: mono 11px chips (file icon, truncated path, × to detach) above the composer's text, and under the text of a sent message. The `@` menu lists the file name in mono with its folder after it, muted and truncated from the left.
- **Command palette** (⌘K): a popover card at 14vh, max-w-xl, over a soft overlay; a search field with an `esc` hint, then rows (14px muted icon, 13px label, mono 10px hint — shortcut, `/command` or project · time) under mono uppercase group headings (New, This session, Sessions, App) until a query flattens them.
- **Tool cards**: rounded-lg card, mono tool name, status icon in token colors (primary spinner / success check / destructive X), hover tint on the header row, body on `muted/40`.
- **Command output**: mono 11px on the card's `muted/40` body, following the tail while the command runs (max-h-60), read from the top once it ends (max-h-80). Terminal colours map to eight `--ansi-*` hues tuned per theme (bright variants share the hue); backgrounds at 22% of the hue. The header ends with a destructive `exit N` / `timed out` chip for a failure and the duration in 10px muted mono.
- **Exploration line**: a run of lookups folds into one quiet 12px muted line — chevron, search icon (violet spinner while one runs), "Read 3 files, searched for 2 patterns", then the running call in mono or "· 1 failed" in destructive — brightening on hover; it opens to the cards indented behind a left rule, as Session details does.
- **Copy / retry**: a 14px muted copy icon (check in success once copied) under a finished turn and at a message's top-right, shown on hover or focus. After a failed or stopped run, a secondary "Retry" button (rotate icon) with a muted one-line hint follows the error notice.
- **Side panel**: a `min(460px, 42vw)` column right of the session behind a left border; an h-12 top bar lining up with the session header holds the tabs (12px medium, icon + label, accent fill when selected) and a close ×. The header's panel button (panel-right icon) shows accent while it's open.
- **Changes list**: a muted 12px bar — branch icon, mono branch name, `↑2 ↓1`, "3 files changed", refresh — then one row per file: chevron, a mono bold change letter (M brass, A/U success, D destructive, R violet, ! destructive), the mono file name with its folder muted after it, and `+3 −1` at the end. A row opens to its patch on `muted/20`, hunk headers on a faint violet band, no height cap — the panel scrolls.
- **Task dock**: a card-surface line above the pending dock — violet list-check icon, "Tasks" (12px medium), mono `2/5`, the task in hand in muted text, a chevron — that opens to the list (violet dot in progress, success check done and struck through, muted circle pending). Gone once every task is done.
- **Pending dock** (no modals): brass border + tint for permission asks, violet for plan review; kbd hints (`y`/`a`/`n`).
- **Composer**: card surface, focus = violet border + ring + shadow lift; the text above, the footer controls below.
- **Diffs**: mono 11px; added / removed lines on `success` / `destructive` at 10% bg, with the `+` / `−` in that colour and the text in ink — Shiki colours once the grammar loads. The words that changed within a replaced line sit on the same hue at 25%. File line numbers, muted at 70%, in one column per side that has them (a new file has only the "after" one). Past 400 lines, a quiet full-width "Show all N lines" row.
- **Banners**: brass tint for connection, destructive tint for errors.

## Layout

App shell: 256px sidebar + main column; transcript and composer centered at `max-w-3xl`. Radius scale anchored at `--radius: 0.625rem`. Thin themed scrollbars. Selection tinted violet.

## Motion

Intentional and minimal: committed transcript rows rise 240ms expo-out (`animate-rise`), pending dock rises in, theme transition glide, existing spin/pulse for running states. No layout-property animation; reduced-motion disables all of it.

## Anti-patterns (per PRODUCT.md)

No cream/beige backgrounds, no gradient text, no neon terminal green, no side-stripe accent borders, no glassmorphism, no decorative eyebrows. Warmth comes from Spectral, brass, and ink levels — not from the surface color.
