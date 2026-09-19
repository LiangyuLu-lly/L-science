# L-science UI design system

## 0. Research Log

- **Product:** Windows local-first AI research cockpit (Electron renderer). Not a marketing site.
- **Layer A:** redesign-skill — elevate the existing dark UI; do not replace the information architecture.
- **Layer B:** Linear-like operational density (chrome, lists, panels), not Linear marketing purple.
- **Dials:** VARIANCE 4, MOTION 3, DENSITY 7.
- **Typography:** Chinese/Latin mixed academic copy. CJK stack already in `styles.css`; keep Latin-first then YaHei/PingFang.
- **Forbidden:** AI purple gradients, Inter, flattening WCAG contrast, emoji-as-icons.
- **Skipped lanes:** lazyweb / imagen — network design-research not required to extract tokens already in code.

## 1. Tokens

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

Do not change `--border-control` or text colors; accessibility tests pin them.

## 2. Typography

- Chrome: `--fs-ui: 13px`
- Body: `--fs-body: 14px` / line-height 1.6
- Titles: `--fs-title: 16px` / weight 600
- Font stack: Segoe UI → system-ui → Microsoft YaHei UI → PingFang SC → Noto Sans CJK SC
- `code` / `.msg__body`: `overflow-wrap: anywhere`

## 3. Elevation

Panels and header sit on `--bg-raised` with `1px solid var(--border)` and `--shadow-raised`. Overlay backdrop uses `--bg-overlay`; the inner stack stays `--bg-raised`.

## 4. Primitives

- `.btn` / `input` / `select` / `textarea`: `--radius-control`, control border variable remap (already).
- `.panel`: raised surface, 16px padding.
- `.overlay`: dimmed full-viewport; `.overlay__stack` is the card.

## 5. Motion

120ms `opacity` / `transform` only. Existing `@media (prefers-reduced-motion: reduce)` wins.

## 6. Accessibility

Skip-link, `:focus-visible`, `forced-colors`, 3:1 control borders, Chinese `aria-label`s stay. Contrast tests in `tests/accessibility.test.ts` are the contract.

## 7. Accepted debt

- No icon font / Lucide this round (Electron + existing CSS).
- No Inter.
- Window chrome is Electron’s; we only style the renderer.
- Dense BEM class names remain; tokens change, class names do not.
