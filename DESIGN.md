# Design

Visual system for the `marvis web` console — **v3 "Hierarchy"** on the v2 **Graphite** tokens. Strategic context lives in [PRODUCT.md](PRODUCT.md); this file answers "how it looks". The reference frames are in the Figma file *Learning Project*, page "v3 · Hierarchy" (Session / Usage / Settings, light and dark, the collapsed states, a motion demo and the "v3 · Direction" rules). Source of truth in code: `packages/web/src/index.css` (tokens, motion), `packages/web/src/lib/theme.ts` (theme switching), `packages/web/src/components/Regions.tsx` (regions and their toggles).

## Principles

What removes the "AI look" is a clear order of importance, not decoration.

1. **Decide the order before styling.** Each screen names one thing the eye lands on first — the approval, the total cost, the section being edited — then what supports it, then what can recede.
2. **Zones by fill, not by frame.** Navigation and work share one white sheet, split by a single hairline. Auxiliary zones (the side panel) sit on grey. Inside a zone, groups are blocks of fill with no outline.
3. **White on grey, grey on white.** On a grey zone, white marks what can be acted on or is selected: cards, fields, the chosen tab. On white, grey does the same job: the selected row, buttons, tool blocks, table heads.
4. **Outlines only where fill cannot work:** the composer (the one field on white that must be found), checkboxes, and error states. Search (`subtle`) is a lighter grey than selection (`muted`), so the two never read alike.
5. **One tinted block per screen.** Amber is reserved for what is waiting on the user — one, never more.
6. **Weight, and one size step.** Titles 14 semibold; section titles and key figures 20; the hero number 36. Names are medium. Meta stays tertiary grey.
7. **Each toggle stays in its corner.** The sidebar's toggle sits top-left, the side panel's top-right — on the region while it is open, in the main header once it is closed.
8. **Motion marks a change of state, nothing else.**

## Color

Near-neutral greys, one blue for what is live or linked, ink for the primary action, amber only for what waits on the user. Light and dark are tuned separately.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `background` | `#ffffff` | `#0f0f11` | the sheet; cards on grey |
| `foreground` | `#111114` | `#ededf0` | ink |
| `muted-foreground` | `#5c5c66` | `#a3a3ad` | secondary text, icons |
| `faint` | `#8a8a93` | `#71717a` | meta: times, counts, hints, placeholders |
| `subtle` | `#f7f7f8` | `#161619` | search, tool blocks, table heads, settings blocks |
| `muted` (= `accent`, `secondary`) | `#efeff1` | `#202024` | selection, buttons on white, the side panel |
| `ink` / `on-ink` | `#111114` / `#fff` | `#ededf0` / `#0f0f11` | the one primary action in a group |
| `primary` | `#2b59e8` | `#5b83ff` | running, unread, links, focus, the chart |
| `warning` / `warning-subtle` / `warning-dot` | `#a15c07` / `#fdf6e7` / `#e8a317` | `#e0a93b` / `#2a2112` / `#e0a93b` | what waits on the user |
| `success` | `#18794e` | `#3fb27f` | done, additions |
| `destructive` | `#d1242f` | `#f2555a` | errors, deletions |
| `diff-add` / `diff-del` | `#e9f6ee` / `#fcebec` | `#12261b` / `#2d1517` | diff line fills |
| `border` / `border-strong` | `#e3e3e6` / `#cfcfd4` | `#2a2a2f` / `#3a3a41` | hairlines / the composer, checkboxes |
| `chart-1` / `chart-2` | `#2b59e8` / `#0f8a8a` | `#5b83ff` / `#2bb3b3` | model calls (or a lone series) / tool calls |

- Text on ink is `on-ink`; on blue fills, white (light) or near-black (dark).
- Change letters: M amber, A/U success, D destructive, R blue.
- Terminal output uses eight `--ansi-*` hues tuned per theme. Code is highlighted with Shiki `github-light-default` / `github-dark-default`, switched by `.dark` through CSS variables.

## Typography

IBM Plex, self-hosted via Fontsource (the server CSP is `font-src 'self'`); CJK falls back to PingFang SC / Noto.

| Style | Face | Used for |
| --- | --- | --- |
| Display 36/1.1 semibold, −2% | Plex Sans | the hero figure (Usage) |
| Title 20/26 semibold | Plex Sans | section titles, key figures |
| Heading 14/1.4 semibold | Plex Sans | page and block titles, the session title, the approval question |
| Body 14/1.57 | Plex Sans | messages and replies |
| UI 13/1.4 (strong: medium) | Plex Sans | rows, tabs, buttons |
| Small 12/1.4 | Plex Sans | controls, hints |
| Label 11/1.4 medium, +2% | Plex Sans | group names, table heads, stat labels |
| Caption 11/1.4 | Plex Sans | notes under figures, status |
| Mono 12/1.55 (strong: medium) | Plex Mono | code, commands, paths, tool names, diffs |
| Mono small 11/1.45 | Plex Mono | times, counts, durations, kbd hints |

No serif, no uppercase eyebrows.

## Logo

The mark ("Stride") is an M whose left stem is short and right stem tall, so it also reads as a check. It is one colour, solid: ink on light, `#ededf0` in dark, white on ink. Amber and blue stay out of it — both have jobs in the product. Beside the wordmark (Plex Sans Medium, −2%), the mark is cap height, a stem's width away.

- App icon: `packages/desktop/build/icon.svg` — the macOS 1024 grid, an ink 824 tile with continuous corners, the mark 340 tall in white. `pnpm release:desktop` turns it into the .icns.
- Favicon: `packages/web/public/favicon.svg` (32, stems on whole pixels at 32 and 16), `favicon.ico` (16 + 32) and `apple-touch-icon.png` (180, full bleed).
- Source: Figma "Learning Project", page Logo — the directions considered and the spec.

## Layout and regions

- **Shell:** sidebar (248px, white, a hairline on its right) + main (white) + side panel (`min(440px, 42vw)`, `muted` grey, no border). Radius: 4px for controls (`rounded-md`), 6px for blocks (`rounded-lg`).
- **Headers** are 44px with no rule under them — the sheet goes on.
- **Session column:** 660px of content (`max-w-[700px]` with 20px gutters), centred in the main area, transcript `pt-8`, 20px between turns, 12px within one.
- **Toggles:** `PanelLeftClose` on the sidebar's top-left; once closed, `PanelLeftOpen` and an icon-only New session (26px `muted` square) take the main header's corner, with an amber dot on the toggle while a session waits. `PanelRightClose` at the panel's top-right; once closed, `PanelRightOpen` at the main header's right, after the terminal toggle.
- **Split view** divides the main area into two panes behind a hairline; the unfocused pane's header sits on `subtle`.

## Components

- **Sidebar:** brand row (toggle, **Marvis**, a `muted` "+ New" button); a `subtle` search field with a ⌘K hint that opens the palette; project groups under a 13px medium ink label (+ and ⋯ on hover; a chevron when folded), the heading over its sessions; session rows 28px, 12px secondary, the focused one `muted` fill + medium ink, hover `subtle`. A row's end shows the most urgent state: amber dot (waiting), blue spinner (running), blue dot (unread), else a mono faint time; ⋯ on hover. "Add project" faint below. Footer: theme, notifications, Usage, Settings as 14px icons (the page shown gets a `muted` fill), then "● Connected".
- **Session header:** project (faint) / title (14 semibold, click to rename) / branch (git-branch icon, mono 11 faint) · spend (mono 11 faint, opens the usage popover) · terminal and panel toggles.
- **User message:** a `muted` block, 14/1.57, edit / fork / copy at its top-right on hover.
- **Turn:** an exploration line ("Read 2 files, searched for 1 pattern", 12 faint, chevron), text at 14/1.57, tool blocks; under the last reply a copy icon and "Regenerate" (12 faint).
- **Tool block:** `subtle` fill, no outline; a 32px header — status icon (success check, blue spinner, destructive X), the tool name in mono medium, its summary in mono secondary, meta (duration, `+1 −1`) in mono 11; the body on the same fill. A short command output shows open; a long one waits. An error adds a destructive outline. "Open file" floats in the block's corner on hover.
- **Diffs:** mono 12; added and removed lines on `diff-add` / `diff-del`, the sign in success / destructive, line numbers faint in 32px columns.
- **Approval (the amber block):** `warning-subtle`, 6px radius, no outline; a pulsing 6px dot and the question ("Run this command?", "Write this file?", "Make this edit?"), why it asks at the right in 12 faint; what will run on a white block (`$ npm test …`); then Allow once (ink), Always allow … (white), Deny (bare), each with its key in mono faint; "Add a note" at the end opens a white field whose note rides along with a deny. Plan review uses the same block.
- **Composer:** white, a `border-strong` outline, 6px radius; 14/1.57 placeholder in faint; controls at 12 secondary with 13px icons — where it works (Local / Worktree), mode, the model (mono 11), effort, add image; at the right the context meter (28×3 bar + mono %) and the send button (28px ink square, 35% while empty). Stop and Queue are `muted` squares.
- **Side panel:** text tabs (13; the chosen one white with medium ink and, for Changes, a mono count); content as white cards on the grey: the Changes list, the file tree, tasks, trace runs, processes.
- **Changes:** the branch row (mono secondary, `↑2` faint, an All / This session switch whose chosen half is white with a hairline shadow); file rows 34px in a white card — checkbox (outlined; ink with a check or a bar), the letter, the folder faint and the name medium, `+n −n`; discard and open on hover. Commit box: a white message field, "Commit 1 staged ⌘↵" (ink), Push ↑2 and Pull request (white).
- **Usage page:** filters (a `muted` segmented range with the chosen one white, a `muted` project chip); a `subtle` summary block — the cost at 36, four stats at 20 with 11px labels and faint notes; Cost per day — `chart-1` columns up to 24px, three hairline gridlines, mono faint ticks, the hovered column ink with an ink tooltip; tables with a `subtle` head row and no rules between rows, numbers mono secondary, cost mono medium, an unknown cost a faint dash.
- **Settings page:** a 176px section list (the shown one `muted`), then the section's title at 20 and a 13px secondary paragraph; blocks on `subtle` (title 14 semibold · note, the file in mono faint); rules as white mono rows (× on hover); "+ Add a rule" faint, outlined in destructive with the server's reason under it when a rule is refused.
- **Menus, popovers, the palette and dialogs** float: white (`popover`), a hairline border and a shadow; 13px items, highlighted on `muted`; dialog titles 14 semibold.
- **Banners:** connection on `warning-subtle`, errors on a destructive tint.

## Motion

Only state changes move, all on `cubic-bezier(0.16, 1, 0.3, 1)`; `prefers-reduced-motion` turns every one off.

- A new row rises 8px and fades in over 240ms (`animate-rise`); rows that arrive together follow 140ms apart (`--rise-delay`).
- The approval block rises 12px over 280ms (`animate-rise-lg`) and its dot pulses twice (`animate-pulse-twice`).
- A region opens over 320ms easing out and closes over 200ms easing in; the main area reflows with it (`SlideRegion`). What was open at load is simply there.
- A running spinner turns once a second. Theme switches glide (180ms on colours).

## Anti-patterns (per PRODUCT.md)

No outlines around every group, no cards inside cards on the same fill, no more than one amber block, no tinted page behind the main sheet, no gradients or glass, no uppercase mono eyebrows, no decorative icons.
