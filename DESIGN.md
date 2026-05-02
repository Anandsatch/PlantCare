# PlantCare Design System — Conservatory

The visual and interaction language for PlantCare V1. Approved via /office-hours (2026-04-29) and locked via /design-shotgun (2026-04-30) + /plan-design-review (2026-05-01).

Parent plan: `~/All_Projects/Projects/PlantCare/plans/as_macmini-Anandsatch-plant-care-app-design-20260429-193756.md`
Approved mockups: `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/`

## Aesthetic

**Conservatory** — warm botanical, editorial, paper-feel. Apple-grade botanical field guide. Generous whitespace, asymmetric photo placement, hairline dividers. Photo-realistic plant imagery in soft natural light.

**Anti-pattern (do not build):** purple/violet gradients, 3-column feature grids, centered-everything layouts, decorative blobs, emoji-as-decoration, `system-ui` typography, generic stock-photo placeholders.

## Color tokens

### Light mode (default, "Conservatory")

| Token | Hex | Role |
|-------|-----|------|
| `bg` | `#FAF6EE` | Background, chip surface — cream paper |
| `surface` | `#FAF6EE` | Cards, modals, sheets |
| `text` | `#2A2A2A` | Body text |
| `text-muted` | `#2A2A2A` @ 70% | Captions, last-watered lines |
| `primary` | `#1F3826` | Primary CTA fill, all hairline strokes |
| `stroke` | `#1F3826` | Hairline borders, icon strokes |
| `water` | `#A8C5D9` | Water state — dusty pale blue, never saturated |
| `sage` | `#B8C5A6` | Healthy/skip state |
| `tan` | `#C9A873` | Soil/check-soil state |

### Dark mode ("Midnight Conservatory")

| Token | Hex | Role |
|-------|-----|------|
| `bg` | `#0F1A12` | Background — deep night forest |
| `surface` | `#1F3826` | Cards, modals, sheets — forest |
| `text` | `#FAF6EE` | Body text — cream |
| `text-muted` | `#FAF6EE` @ 70% | Captions |
| `primary` | `#B8C5A6` | Primary CTA fill — sage (with deep-forest text) |
| `stroke` | `#FAF6EE` | Hairline borders — cream |
| `water` | `#A8C5D9` | Same hue (passes 6.88:1 on forest) |
| `sage` | `#B8C5A6` | Same hue (passes 6.85:1 on forest) |
| `tan` | `#C9A873` | Same hue (passes 5.57:1 on forest) |

Mode follows OS via `useColorScheme()`. No manual toggle in V1.

## Typography

- **Headlines + primary CTAs:** [Fraunces](https://fonts.google.com/specimen/Fraunces) (variable serif). Weights 400 (regular), 600 (semibold). Italic for plant nicknames in quotes.
- **Body, labels, all-caps:** [Inter](https://fonts.google.com/specimen/Inter). Weights 400 (regular), 500 (medium), 600 (semibold). Use small all-caps for status labels (`WATER TODAY`, `LAST WATERED 5 DAYS AGO`).
- **No system-ui fallback rendered.** Gate first render on `useFonts()` from `expo-google-fonts/fraunces` + `expo-google-fonts/inter`.

## Status icon system (the three-color metaphor lock)

Each status has a unique icon shape, a metaphor-correct color, and a consistent chip wrapper.

| State | Icon | Fill | Chip border | Label |
|-------|------|------|-------------|-------|
| Water today | Droplet (teardrop) | `water` | `water` hairline | `WATER TODAY` |
| Skip | Leaf (single, with vein) | `sage` | `sage` hairline | `SKIP` |
| Check soil | Hand on soil (open palm or fingertip) | `tan` | `tan` hairline | `CHECK SOIL` |

All chips: rounded-rect ~12px radius, `surface` fill, hairline border in the accent color, small all-caps Inter label, icon ~14-16px on the left of the text. Icons always have a `stroke` hairline outline (forest in light mode, cream in dark mode) — the stroke carries legibility at low contrast.

## Watering history pattern — 7-day droplet ledger

Replaces sparkline charts. Mon-Sun columns. Each day shows a droplet:
- **Filled `water` droplet** = day was watered
- **Outline-only droplet** (cream/forest fill, `stroke` hairline) = day was skipped
- Today's column has a small `stroke`-colored dot under the day label

The chart and the WATER TODAY chip share a single `<Droplet>` primitive — one icon vocabulary across both contexts. Reads as a habit ledger, not a curve.

## Surface treatment

- Generous whitespace, asymmetric photo placement.
- Soft rounded corners: ~24px on hero photos, ~12px on chips and buttons, ~16-24px on cards/sheets.
- Hairline dividers between list rows.
- Photo-realistic plant imagery in soft natural light.
- No drop shadows on cards (anti-AI-slop). Shadows only on FABs, mode toggles, and shutter button — and only soft, low-opacity.

## Accessibility baseline

- **Touch targets:** 44×44 px minimum hit area. Use `hitSlop` for visually smaller icons.
- **Screen-reader labels:** every interactive element gets `accessibilityLabel`. Plant card example: `"Monstera Mona, water today, last watered 5 days ago"`. Droplet example: `"Tuesday, watered"` / `"Wednesday, skipped"`.
- **Dynamic type:** support iOS dynamic type up to "Larger Accessibility Sizes". Scale font sizes via `useWindowDimensions` + `PixelRatio.getFontScale()`. Use percentage spacing where headline scaling could break row layouts.
- **Color contrast (WCAG 2.1):** forest on cream is 11.79:1 ✓ (text + strokes). Status fills on cream are 1.6-2.1:1 (below 3:1 graphical threshold) — **shape carries semantic meaning, not color**: each chip is identifiable by icon shape, hairline forest stroke (11.79:1), and label. WCAG 1.4.1 satisfied because color is decorative reinforcement, not the sole signal.
- **Reduce motion:** respect `AccessibilityInfo.isReduceMotionEnabled()`. With reduce-motion on, the diagnose loading pulse becomes static and transitions become instant cross-fades.

## Voice (notification + microcopy)

- **Editorial, present-tense, named.** Always use the plant's nickname.
- Daily push title: `"<Nickname>" — from your garden`
- Daily push body: `<Nickname> is thirsty today. <N> days since the last drink.`
- Sunday weekly review push: `Your Sunday letter is here` / `<N> plants checked in this week. Tap to read.`
- Diagnose loading copy: 0-8s `Looking closely…`, 8-20s `Almost there…`, 20s+ `Trying a more careful look…`
- Diagnose empty state: `Hmm, I don't see a plant here`
- Diagnose timeout: `I couldn't reach the lab`
- No `Time to water Monstera`, `Reminder:`, `Your all-in-one solution`, or other generic-app voice.

## Device scope

- **V1 phone-only.** Set Expo `app.json` `orientation: 'portrait'`. iPad and Web users see a single Conservatory-styled card "PlantCare is iPhone-only for now" with a forest CTA "Open on your phone".
- All 5 screens locked to portrait, including camera capture.

## What this design system is NOT

- Not a rounded-corner-with-drop-shadow card system
- Not a 3-column feature grid system
- Not a system-ui-default typography system
- Not a saturated brand-color system
- Not a centered-hero-with-CTA-below pattern
- Not a "clean modern UI" — it's a *cream paper editorial UI*

## Approved mockups

| # | Screen | Mockup |
|---|--------|--------|
| 1 | Plants list | `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/A-1-list.png` |
| 2 | Plant detail | `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/A-2-detail.png` |
| 3 | Camera capture | `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/A-5-capture.png` |
| 4 | Camera result (diagnose) | `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/A-3-camera.png` |
| 5 | Add plant confirmation | `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/A-4-add.png` |

Comparison board (HTML, all 5 screens in flow order): `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/conservatory-final.html`

Dark-mode mockups (Midnight Conservatory): `~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430-dark/` — generated 2026-05-01 via /plan-design-review.
