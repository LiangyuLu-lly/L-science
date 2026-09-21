# L-science UI design system

The implementation contract for the renderer. Every layout, color, spacing, and motion
decision below is binding: if the code disagrees with this file, the code is wrong — or this
file is updated in the same commit.

## 0. Research Log

Lanes actually run for this revision (2026-09):

- **Embedded references (Layer A):** `redesign-skill` — this is existing UI being improved,
  audit-first, not a greenfield restyle.
- **Brand references (Layer B):** Linear-like operational density for chrome/lists/panels.
  Not Linear's marketing palette.
- **Lazyweb / real-product screens:** `research-ui/` — live captures of Zotero 7/10,
  Obsidian, JupyterLab 4.6, RStudio 2026.09, Readwise Reader, Elicit, Semantic Scholar,
  Connected Papers. Patterns harvested as layout grammar, never pixel copies.
- **Skipped:** imagen concept drafts — network image generation adds no information beyond the
  live product captures above.

Product context: a Windows local-first AI research workbench, not a marketing site. The user
is a researcher in a long working session, not a visitor to be converted.

**Dials:** VARIANCE 3, MOTION 2, DENSITY 7. Reading fatigue beats visual flourish.

**Forbidden:** AI purple gradients, Inter, emoji-as-icons, animated decoration, flattening
WCAG contrast, free-form dock layouts.

## 0.1 Research synthesis — the eight rules

Each rule names the product it is stolen from and the failure it prevents.

| # | Rule | Stolen from | Prevents |
|---|---|---|---|
| R1 | **Three shells in one window.** Library, reading, and writing have different chrome. | Zotero (library tab / reader tab / note tab) | One chrome fighting three jobs |
| R2 | **The library is three columns**: collections-ish filters \| item list \| selection pane. | Zotero, Connected Papers | Paper metadata buried in the left nav |
| R3 | **The selection pane is vertical sections + an icon sidenav with a sticky header.** | Zotero 7/8 item pane | Horizontal tabs inside a narrow pane |
| R4 | **Reading is a tab with quieter chrome** — no permanent bottom composer while reading. | Zotero reader, Readwise long-form | Assistant floor covering the document |
| R5 | **Claims bind in situ**: a claim cell opens its source span beside it, not on another route. | Elicit cell→quote, Zotero annotation→page | A claims page that cannot reach its evidence |
| R6 | **Writing chrome recedes.** Wide measure, chrome fades while typing. | Notion 2026, Obsidian readable line length | Dense app chrome around the manuscript |
| R7 | **The assistant is a dock you open, not a floor you live on.** | JupyterLab down-area, Readwise Chat tab | A composer permanently occupying every view |
| R8 | **Two densities, and chrome theme ≠ content theme.** | Zotero Compact/Comfortable; RStudio UI vs editor theme | One dark gray for lists, PDFs, and prose |

Empty states put the **action** in the empty pane (Zotero's DOI field, JupyterLab Launcher).
Onboarding is a **sample artifact**, not a tour.

Explicitly rejected: JupyterLab's free-form docking. RStudio forbids arbitrary pane placement
for good reason — a beginner loses the window. L-science uses **fixed shells with optional
splits**.

## 1. Tokens

Unchanged from the previous revision. Accessibility tests pin `--border-control` and the text
colors; do not move them.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#111318` | page |
| `--bg-raised` | `#181b22` | cards, header, overlay panel |
| `--border` | `#262b36` | decorative only |
| `--border-control` | `#666e7e` | controls; ≥3:1 vs both backgrounds (20.5.3) |
| `--fg` | `#e6e8ee` | body ≥4.5:1 |
| `--fg-dim` | `#9aa2b1` | secondary ≥4.5:1 |
| `--accent` | `#6aa9ff` | focus, current nav, links |
| `--bg-overlay` | `rgba(8, 10, 14, 0.55)` | first-run dim |
| `--shadow-raised` | `0 8px 24px rgba(0, 0, 0, 0.35)` | elevation |
| `--radius-control` | `6px` | buttons, inputs, panels |
| `--space-1`…`--space-4` | `4px 8px 16px 24px` | rhythm |
| `--focus-ring` | `2px solid var(--accent)` | `:focus-visible` |

**New in this revision** (R8: chrome theme ≠ content theme):

| Token | Value | Role |
|---|---|---|
| `--measure-reading` | `72ch` | manuscript + reflowed reading max measure |
| `--measure-pane` | `none` | list/pane columns stay full-width; only prose is measured |
| `--content-bg` | `#f7f7f5` | paper-body surface in the reading shell (light on purpose) |
| `--content-fg` | `#1c1f26` | text on `--content-bg`, ≥7:1 |
| `--chrome-fade-ms` | `120ms` | writing-focus chrome fade; `prefers-reduced-motion` disables |

Reading/writing content surfaces are deliberately light while the chrome stays dark: figures
and page images must never be inverted, and long prose on dark fatigues faster. This is the
Zotero/RStudio split, and it is a decision, not an oversight.

## 2. Typography

- Chrome: `--fs-ui: 13px`
- Body: `--fs-body: 14px` / line-height 1.6
- Titles: `--fs-title: 16px` / weight 600
- Manuscript editor + reflowed reading: 15px / line-height 1.75, `--measure-reading`
- Font stack: Segoe UI → system-ui → Microsoft YaHei UI → PingFang SC → Noto Sans CJK SC
  (Latin first so Han falls through; see the comment in `styles.css`)
- `code` / `.msg__body` / DOI strings: `overflow-wrap: anywhere` — a clipped DOI is a lost DOI

## 3. Shells (R1, R2, R4, R6, R7)

Five shells, one window. The shell is a property of the **view**, not a user preference.

| Shell | Views | Chrome |
|---|---|---|
| **文献 (library)** | `refs` | three columns: filters \| list \| selection pane |
| **断言 (ledger)** | `claims` | table/grid + right evidence pane (splits open in place, R5) |
| **手稿 (writing)** | `manuscripts` | narrow nav, wide measure, one primary action (编译) |
| **阅读 (reader)** | a paper opened from library/claims | tab-like header, no composer floor, panels hideable |
| **工作室 (studio)** | artifacts…settings | current dense operational layout is correct here |

Rules:

- The assistant is **not** a floor. It exists as a `down` area opened by the 助手 nav item
  (`aria-expanded`), and it remembers its height per shell. It is closed by default on
  阅读 and 手稿; it may be open by default on 文献 only if the user opened it last session.
- The composer is the assistant's input, so it lives **inside** the down area, never as a
  permanent `.app__dock` on paper views.
- Open-in-place beats route changes: selecting a paper, a claim, or a compile run must not
  navigate away from the list that produced it (R2/R5).

## 4. Primitives

- `.btn` / `input` / `select` / `textarea`: `--radius-control`, control border remap (already).
- `.panel`: raised surface, 16px padding.
- `.overlay`: dimmed full-viewport; `.overlay__stack` is the card.
- **`.lib`** (new): the library three-column grid. `grid-template-columns: 200px minmax(280px, 1fr) minmax(320px, 1.4fr)`; collapses to list+pane under 900px, single column under 640px.
- **`.pane`** (new): selection pane. Sticky header (`position: sticky; top: 0`), collapsible
  vertical `<section>`s with an icon rail. Never horizontal tabs.
- **`.ledger`** (new): claims grid. Row = claim, columns = status/evidence/actions; a row's
  evidence opens in the pane to its right. No modal.
- **`.reading`** (new): content surface on `--content-bg`, `max-inline-size: --measure-reading`,
  centered, `[`/`]`-equivalent buttons to hide panes.
- **`.downarea`** (new): the assistant dock. `aria-expanded` on its toggle; Escape closes;
  focus returns to the toggle.
- **Empty panes**: a verb-first primary action rendered *inside* the empty pane
  (`.empty-action`), plus one line of why. Never a mascot, never a dead hint.

## 5. Motion

120ms `opacity` / `transform` / `filter` only — never layout properties. Chrome fade in the
writing shell uses `--chrome-fade-ms` and is disabled entirely under
`@media (prefers-reduced-motion: reduce)`. No motion on non-interactive elements; every
transition maps to a state change the user caused.

## 6. Accessibility

- Skip-link, `:focus-visible`, `forced-colors`, 3:1 control borders, Chinese `aria-label`s stay.
  `tests/accessibility.test.ts` is the contract.
- Every new shell must remain keyboard reachable: pane sections are real `<button aria-expanded>`,
  the down area is `aria-expanded` + Escape, the ledger rows are focusable with a visible ring.
- Color is never the only carrier: retracted/manuscript status/unresolved counts all have text.
- Labels are Chinese, plain language. No jargon ("API", "CLI") in novice-facing copy.

## 7. Accepted debt

- No icon font / Lucide this round (Electron + existing CSS). The pane icon rail uses text
  glyphs with `aria-hidden` + the section title as the accessible name.
- No Inter.
- Window chrome is Electron's; we only style the renderer.
- Dense BEM class names remain; tokens and structure change, class names do not (keeps diffs
  reviewable and tests greppable).
- The reader shell has no PDF canvas yet — `ref.fetchFulltext` fetches text. The `.reading`
  surface is built so a page canvas can replace the body later without a shell change.
- No free-form docking (rejected by design, see §0.1).

## 8. Information architecture

- Home view is **文献** (`refs`), not chat.
- Primary nav: 文献 → 断言 → 手稿.
- **助手** toggles the down area (it is not a route).
- 工作室: 制品、技能、记忆、连接器、路由、用量、工具、设置.
- Not in the UI, and the README says so: compute targets/jobs (assistant tools), env CRUD
  (doctor + one-click only), dual-model parallel send (won't do).

Scroll: header fixed; the shell body owns overflow (`min-block-size: 0`). Only prose surfaces
scroll horizontally never; they wrap.
