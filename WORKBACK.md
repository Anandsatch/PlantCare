# PlantCare V1 — Workback Plan

Generated 2026-05-01. Source plan: `~/All_Projects/Projects/PlantCare/plans/as_macmini-Anandsatch-plant-care-app-design-20260429-193756.md`

This is the execution plan that turns the design + eng review into hand-off-able work. Every ticket has dependencies, a workflow, and explicit review/QA gates.

---

## Team composition (assumed)

| Role | Headcount | Responsibility |
|------|-----------|----------------|
| **TL** | 1 | Tech lead / PM (Anand). Owns plan, reviews PRs, makes scope calls, runs evals. |
| **BE** | 1-2 | Backend engineers (Hono / Cloudflare Workers, LLM router, evals). Played by CC+Codex agents in worktrees. |
| **FE** | 2 | Mobile engineers (Expo / RN, components, screens). Played by CC+Codex agents in worktrees, can run truly parallel on independent screens. |
| **QA** | 1 | QA / SDET. Played by `/qa` and `/qa-only` skill invocations + Maestro on real device. |
| **DR** | 1 | Design reviewer. Played by `/design-review` skill on every screen-touching PR. |

**With AI agents:** all role slots are AI-driven; TL coordinates. With humans: same shape, slower wall time but identical dependency graph.

---

## Phases

| Phase | Focus | Duration (team) | Duration (solo+AI) |
|-------|-------|-----------------|---------------------|
| **P0** Foundation | Repo, EAS, CI, theme, primitives | 3 days | 1 weekend |
| **P1** Core Loop | Backend identify + Plants list + Plant detail + simple rules + mark watered | 10 days | 1 weekend |
| **P2** Rescue Moment | Camera capture + diagnose + add plant + photo compression + offline queue | 10 days | 1 weekend |
| **P3** Watering++ | Location permission + Open-Meteo + indoor flag + override | 4 days | ½ weekend |
| **P4** Polish | Notes/consult + weekly review + dark mode + a11y + budget meter | 8 days | 1 weekend |
| **P5** Distribution | EAS prod build + TestFlight + Internal Android + privacy data sheet | 2 days | ½ weekend |
| **TOTAL** | | **37 days** | **5 weekends (~30 hr active TL time)** |

---

## ASCII Gantt — team mode (full-time engineers)

Days 1-37 across rows. ▓ = active work. ░ = parallelizable but waiting on dep. Lanes labeled.

```
                          Day  01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37
                                |  P0  |              P1                 |             P2                  |    P3   |        P4        |P5|
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Lane TL (PM)                    ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓
Lane A (Backend BE)             ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓
Lane B (Mobile foundation FE1)  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane C1 (Plants list FE1)       ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane C2 (Plant detail FE2)      ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane D (Camera+diagnose FE2)    ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane E (Sync queue FE1)         ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane F (Watering++ BE+FE2)      ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░  ░  ░
Lane G (Notes+consult FE1)      ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░
Lane H (Weekly review FE2)      ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ░  ░  ░  ░  ░  ░  ░  ░
Lane I (Dark mode FE1)          ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ░  ░  ░  ░  ░  ░
Lane J (A11y + budget meter FE) ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓ ░  ░  ░  ░
Lane K (QA + Maestro)           ░  ░  ░  ░  ░  ░  ░  ▓▓ ░  ░  ░  ░  ░  ▓▓ ░  ░  ░  ░  ░  ░  ▓▓ ░  ░  ░  ░  ░  ▓▓ ░  ░  ░  ▓▓ ░  ░  ▓▓ ▓▓ ▓▓ ░
Lane L (Distribution)           ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ░  ▓▓ ▓▓
```

**Critical path:** P0 → Backend identify (E1-001..004) → Plants list + Plant detail (Lane C) → Camera + diagnose (Lane D) → Watering++ (Lane F) → Notes/Weekly/Dark/A11y (G/H/I/J in parallel) → Distribution. Anything that blocks the critical path is a P0.

**Parallelization wins:** Lane B (foundation) is solo, but Lane C1 ‖ C2 is real parallelism (2 different screens, 2 different agents). Lane G ‖ H ‖ I in P4 is 3-way parallel. Lane A is mostly independent of mobile until late.

---

## ASCII Gantt — solo + AI mode (5 weekends)

Compressed view for the actual likely scenario.

```
              W1S    W1U    W2S    W2U    W3S    W3U    W4S    W4U    W5S    W5U
P0 setup      ▓▓▓
P1 backend    ▓▓▓    ▓▓▓
P1 mobile foundation  ▓▓▓
P1 plants list+detail        ▓▓▓
P2 camera+diagnose                   ▓▓▓    ▓▓▓
P2 add plant                                ▓▓▓
P2 sync queue                                      ▓▓▓
P3 watering++                                             ▓▓▓
P4 notes/weekly                                                  ▓▓▓
P4 dark mode + a11y + budget meter                                      ▓▓▓
P5 distribution + dogfood                                                       ▓▓▓
```

W=weekend, S=Saturday, U=Sunday. ~6 hours per half-day = 60 hours of focused TL time across 5 weekends.

---

## Per-ticket workflow (mandatory for every ticket)

```
                     ┌─────────────────────┐
                     │  1. Pick up ticket  │  (assign to agent or self)
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │  2. Code in worktree│  (Agent / human writes implementation)
                     │     /feature-dev    │
                     │  + WIP commits      │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ 3. Adversarial      │  /codex review
                     │    review (LLM)     │  + /coderabbit:review (CR cloud)
                     │                     │  + Claude subagent challenge
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ 4. Design review    │  /design-review
                     │    (UI tickets only)│  (visual diff vs approved mockup)
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ 5. QA               │  /qa or /qa-only
                     │  (test plan input)  │  + Maestro for E2E tickets
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ 6. Lead approval    │  TL reads diff + review report
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ 7. Ship             │  /ship → merge → deploy
                     │                     │  (or /land-and-deploy on greenfield)
                     └─────────────────────┘
```

**Gates that block ship:**
- Adversarial review with P1 finding unresolved
- QA with critical regression test failing
- Design review with "AI slop detected" or "diverges from approved mockup"

**Auto-passes (no block):**
- Cross-model agreement (Claude + Codex both approve)
- All Maestro flows green
- Coverage > 80% on `hooks/`, `sync/`, `api/`, `apps/backend/`

---

## Skill invocation cheat sheet

| Phase / Action | Skill | When |
|----------------|-------|------|
| Start a ticket | `/feature-dev:feature-dev` | Multi-step implementation |
| Spawn parallel work | `Agent` tool with `isolation: "worktree"` | True parallel lanes (C1‖C2, G‖H‖I) |
| Review own diff | `/gstack-review` | Pre-PR self-review |
| Adversarial review | `/codex review` + `/coderabbit:review` + Claude subagent | EVERY ticket pre-merge |
| Design diff vs mockup | `/gstack-design-review` | UI tickets only |
| Visual QA at 3 viewports | `gstack browse` (light) + Maestro | E2E tickets |
| Test execution | `/gstack-qa` or `/gstack-qa-only` | EVERY ticket; consume the test plan artifact |
| LLM eval suite | `vitest run evals/` | Backend prompt tickets |
| Ship | `/gstack-ship` or `/gstack-land-and-deploy` | After all gates pass |
| Schedule a recurring check | `/loop` or `/schedule` | Watch dogfood KPIs after launch |
| Save context between sessions | `/gstack-context-save` | Long-running ticket spans sessions |

---

## EPICS

### Epic E0 — Foundation & Tooling

**Goal:** Everything an engineer needs before a single feature ships.
**Phase:** P0
**Duration (team):** 3 days
**Owner:** TL + 1 FE
**Blocks:** all other epics

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E0-001** | Init monorepo (`apps/backend`, `apps/mobile`, `packages/api-types`, `packages/theme`) | FE1 | M | — | `/feature-dev` | `/codex review` → TL approval |
| **E0-002** | Set up EAS dev build (iOS + Android), install on device | TL+FE1 | M | E0-001 | manual + EAS docs | manual smoke test on device |
| **E0-003** | CI scaffold (jest+jest-expo, vitest+vitest-pool-workers, GitHub Actions) | FE1 | M | E0-001 | `/feature-dev` | `/codex review` |
| **E0-004** | `packages/theme/colors.ts` with light + dark Conservatory tokens | FE1 | S | E0-001 | manual port from DESIGN.md | TL review (token values vs DESIGN.md) |
| **E0-005** | Font loading: `expo-google-fonts/fraunces` + `inter`, gate first render on `useFonts()` | FE1 | S | E0-002, E0-004 | `/feature-dev` | `/codex review` |
| **E0-006** | Maestro setup + first smoke flow ("app launches, shows empty Plants list") | QA1 | M | E0-002 | `/feature-dev` + maestro docs | TL approval |
| **E0-007** | Set up `/codex review` + `/coderabbit:review` integration in CI | TL | S | E0-003 | manual | TL self-verification |

**Definition of done (epic):** A new engineer can `git clone && bun install && bun ios` and see a blank Conservatory-styled Expo screen on a real iPhone within 10 minutes. CI runs jest, vitest, and a Maestro smoke flow on every PR.

---

### Epic E1 — Backend MVP (4 LLM proxy endpoints + eval suite)

**Goal:** All four LLM proxy endpoints (`/api/identify`, `/api/diagnose`, `/api/consult`, `/api/review`) working end-to-end on a single tiered router (free → paid escalation), plus eval suites.
**Phase:** P1
**Duration (team):** 5 days
**Owner:** BE1
**Blocks:** E5 (Camera+diagnose), E6 (Watering++), E8 (Add note + consult), E9 (Weekly review)

**Restructured 2026-05-02:** original 10-ticket plan collapsed into 5. The router pattern (free → paid on parse-fail or low-confidence, no-op escalation gate seam) is built once in E1-001 and reused per-endpoint as thin response-schema + system-prompt wrappers in 002/003/004. Pulling diagnose/consult/review forward into E1 lets E5/E8/E9 mobile screens consume real endpoints instead of stubs.

**V1 scope locks (do NOT add):** KV rate limit, KV escalation budget, `/api/budget` endpoint, Layer-1 text classifier, Layer-5 image-is-plant gate. Rate limit + budget tracked client-side in SQLite per V1 lock; layered safety lives in later epics if needed.

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E1-001** | `/api/identify` + tiered LLM router foundation (OpenRouter wrapper, safeJsonParse, escalation seam, route handler with multipart + X-Device-Id) | BE1 | L | E0-001 | `/feature-dev` | `/codex review` + Claude subagent challenge |
| **E1-002** | `/api/diagnose` — vision endpoint reusing router; new system prompt → `{disease_slug, confidence, fix_steps[], severity}`; thin parseDiagnose | BE1 | M | E1-001 | `/feature-dev` | `/codex review` |
| **E1-003** | `/api/consult` — text-only endpoint (note + plant context → revised watering rec); same router shape, different message construction | BE1 | M | E1-001 | `/feature-dev` | `/codex review` + adversarial (prompt injection in user note) |
| **E1-004** | `/api/review` — text-only endpoint (last-7-days data → narrative); structured response schema | BE1 | M | E1-001 | `/feature-dev` | `/codex review` |
| **E1-005** | LLM eval harness (vitest snapshot, ±10 confidence band; fixtures for identify + diagnose + consult + review) | BE1 + TL | L | E1-002, E1-003, E1-004 | `/feature-dev` + TL provides fixtures | TL approves baseline |

**Definition of done (epic):** `curl POST /api/{identify,diagnose,consult,review}` against the deployed Worker returns the typed `ApiResult<T>` JSON for each endpoint. Eval suite passes with confidence within ±10 of baseline on all four. Free → paid escalation triggers correctly on JSON parse fail and confidence < 70 across endpoints.

**Post-MVP (deferred from original E1, do not pull back without explicit scope change):**
- KV-backed escalation budget (3/device/day) and rate limit (50/device/day)
- `/api/budget` endpoint for the budget meter
- Layer-1 text classifier (off-topic rejection at the edge)
- Layer-5 image-is-plant gate (cat-rejection before diagnose)
- Workers Analytics Engine telemetry
- Staging/production env split in `wrangler.toml` (owned by E13)

---

### Epic E2 — Mobile foundation (theme + primitives + DB + hooks)

**Goal:** All the building blocks any screen needs.
**Phase:** P1
**Duration (team):** 5 days (mostly parallel with E1)
**Owner:** FE1
**Blocks:** E3 (Plants list), E4 (Plant detail), E5 (Camera/diagnose)

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E2-001** | `useTheme()` hook returning light/dark tokens via `useColorScheme()` | FE1 | S | E0-004 | `/feature-dev` | `/codex review` |
| **E2-002** | SQLite schema + migrations (all 6 tables incl. `is_indoor`, `override_interval_days`) | FE1 | L | E0-001 | `/feature-dev` | `/codex review` + adversarial (FK + index strategy) |
| **E2-003** | `usePlants()` CRUD hook | FE1 | M | E2-002 | `/feature-dev` | `/codex review` |
| **E2-004** | `useReduceMotion()` hook | FE1 | S | E0-001 | `/feature-dev` | `/codex review` |
| **E2-005** | API client (discriminated union; `{ ok, kind, data, message?, retry_after? }`) | FE1 | M | E0-001 | `/feature-dev` | `/codex review` + cross-model on error-kind enumeration |
| **E2-006** | `<Droplet>`, `<LeafIcon>`, `<HandOnSoilIcon>` primitives (light + dark variants) | FE1 | M | E2-001 | `/feature-dev` | `/design-review` (vs A-1 mockup) + `/codex review` |
| **E2-007** | `<StatusChip type='water'\|'skip'\|'soil' />` | FE1 | S | E2-006 | `/feature-dev` | `/design-review` |
| **E2-008** | `<EditorialButton variant='outline'\|'filled' />` | FE1 | S | E2-001 | `/feature-dev` | `/design-review` |
| **E2-009** | `<FAB>` with tap + long-press handler | FE1 | S | E2-001 | `/feature-dev` | `/design-review` |
| **E2-010** | `<HeroPhoto>` with rounded corners + accessibilityLabel | FE1 | S | E2-001 | `/feature-dev` | `/design-review` |
| **E2-011** | `<EditorialBottomSheet>` with focus trap + swipe-to-close | FE1 | M | E2-001 | `/feature-dev` | `/codex review` (a11y) + `/design-review` |
| **E2-012** | `<ToastBanner type='warn'\|'info'\|'pending'>` | FE1 | S | E2-001 | `/feature-dev` | `/design-review` |
| **E2-013** | Component test suite (jest+RTL) for all primitives | FE1 + QA1 | M | E2-006..012 | `/feature-dev` + `/qa-only` | TL approval (coverage > 90% on primitives) |

**Definition of done (epic):** Storybook-style Component Garden screen renders every primitive in light + dark mode with sample props. All primitives have component tests. Theme switches via system setting in <100ms.

---

### Epic E3 — Plants List (A-1)

**Goal:** Home screen with empty state + populated state + status chips + FAB.
**Phase:** P1
**Duration (team):** 3 days
**Owner:** FE1
**Blocks:** Maestro Day-1 onboarding flow

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E3-001** | `<PlantCard>` composite (photo + name + nickname + last-watered + chip) | FE1 | M | E2-007, E2-010 | `/feature-dev` | `/design-review` (vs A-1) + `/codex review` |
| **E3-002** | `<EmptyGardenWelcome>` (Day 1 zero-plant card with CTA → camera capture) | FE1 | M | E2-001 | `/feature-dev` | `/design-review` (vs Pass 2 spec) + `/codex review` |
| **E3-003** | `<PlantsListScreen>` with `useWateringEngine()` driving status chips | FE1 | M | E3-001, E3-002, E2-009 | `/feature-dev` | `/design-review` + `/codex review` |
| **E3-004** | FAB long-press popover ("Add a plant" / "Quick diagnose") | FE1 | S | E3-003, E2-009 | `/feature-dev` | `/codex review` |
| **E3-005** | Tests: 0 plants → Welcome card; 1+ → list rows; FAB tap → camera; long-press → popover | QA1 | M | E3-003, E3-004 | `/qa-only` + jest | adversarial review |

**Definition of done (epic):** Open the app on Day 1 → see Welcome card. Add a plant → list shows 1 row with correct chip. Long-press FAB → popover with both options. All states have screen-reader labels.

---

### Epic E4 — Plant Detail (A-2) + Watering Engine v1

**Goal:** The detail screen + the deterministic rules engine (simple version, no weather).
**Phase:** P1
**Duration (team):** 4 days
**Owner:** FE2 + BE1 (rules engine consult)
**Blocks:** E6 (Watering++ adds weather on top)

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E4-001** | `useWateringEngine()` v1 — species + last-watered + check-soil bias only (no weather yet) | FE2 | M | E2-002 | `/feature-dev` | `/codex review` + adversarial (timezone math!) |
| **E4-002** | **CRITICAL** Timezone regression test (DST forward, DST backward, IDL flight) | QA1 + FE2 | M | E4-001 | `/qa-only` + jest | TL approval (mandatory) |
| **E4-003** | `<WateringLedger>` 7-day droplet row (filled / outline / today marker) | FE2 | M | E2-006 | `/feature-dev` | `/design-review` (vs A-2 v4) |
| **E4-004** | `<PhotoTimeline>` 4-thumbnail row with date labels | FE2 | S | E2-010 | `/feature-dev` | `/design-review` |
| **E4-005** | `<PlantDetailScreen>` (hero photo + Fraunces headline + chip + ledger + 3 buttons + timeline) | FE2 | L | E4-001, E4-003, E4-004 | `/feature-dev` | `/design-review` (vs A-2) + `/codex review` |
| **E4-006** | "Mark watered" mutation (writes `watering_events` row, ledger updates) | FE2 | S | E4-005 | `/feature-dev` | `/codex review` |
| **E4-007** | "Add note" button is HIDDEN until E8 ships (do not render dead UI) | FE2 | S | E4-005 | inline | TL inline review |
| **E4-008** | Tests: empty ledger, full ledger, today marker, mark-watered persists, status chip flips | QA1 | M | E4-006 | `/qa-only` + jest | adversarial review |

**Definition of done (epic):** Tap a plant card → detail screen with hero photo and ledger. Tap Mark watered → ledger droplet for today fills, status chip flips to SKIP. Just-added plant shows 7 outline droplets + hint. Timezone regression test passes.

---

### Epic E5 — Camera Capture + Diagnose Result + Add Plant (the rescue moment)

**Goal:** The hero feature. Capture → identify or diagnose → save.
**Phase:** P2
**Duration (team):** 8 days
**Owner:** FE2 + BE1 (diagnose endpoint)
**Blocks:** E7 (offline queue applies to diagnose)

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E5-001** | `/api/diagnose` endpoint w/ same router pattern as identify | BE1 | L | E1-004, E1-009 | `/feature-dev` | `/codex review` + LLM eval |
| **E5-002** | LLM eval suite for diagnose (10 fixture sick-leaf images + 2 healthy + 1 cat reject) | BE1 + TL | M | E5-001 | `/feature-dev` + TL provides fixtures | TL approves baseline |
| **E5-003** | `<CameraPermissionPrePrompt>` (Conservatory cream pre-prompt before iOS dialog) | FE2 | M | E2-001 | `/feature-dev` | `/design-review` |
| **E5-004** | `<CameraView mode='identify'\|'diagnose' onCapture />` (`expo-camera` wrapper, mode toggle pill, shutter) | FE2 | L | E5-003 | `/feature-dev` | `/design-review` (vs A-5) + `/codex review` |
| **E5-005** | Photo compression helper (`expo-image-manipulator`, 1024px max @ 0.7, save to `documentDirectory`) | FE2 | S | E0-001 | `/feature-dev` | `/codex review` |
| **E5-006** | `useDiagnoseRequest()` hook (online → API; offline → enqueue placeholder for E7) | FE2 | M | E2-005, E5-001 | `/feature-dev` | `/codex review` |
| **E5-007** | `<DiagnoseLoadingState>` with 3-bucket pulsing copy (0-8s / 8-20s / 20s+) + reduce-motion compliant | FE2 | M | E2-004 | `/feature-dev` | `/design-review` (vs A-3 spec) |
| **E5-008** | `<CameraResultScreen>` (A-3) — success path | FE2 | L | E5-004, E5-006, E5-007 | `/feature-dev` | `/design-review` (vs A-3) |
| **E5-009** | A-3 error variants — low-confidence + timeout + Layer-1 reject (uses discriminated union) | FE2 | M | E5-008 | `/feature-dev` | `/design-review` (vs Pass 2 spec) |
| **E5-010** | `<AddPlantScreen>` (A-4) — happy path, 0% match → manual species picker | FE2 | M | E2-001, E5-006 | `/feature-dev` | `/design-review` (vs A-4) |
| **E5-011** | Wire FAB tap → A-5 identify mode; long-press "Quick diagnose" → A-5 diagnose mode (transient, not saved) | FE2 | M | E3-004, E5-004 | `/feature-dev` | `/codex review` |
| **E5-012** | Tests: capture mocked, diagnose success/timeout/reject/low-confidence variants render correctly | QA1 | M | E5-009 | `/qa-only` + jest | adversarial review |
| **E5-013** | Maestro E2E: rescue moment (detail → diagnose → save) + add plant + quick diagnose | QA1 | L | E5-008, E5-010, E5-011 | maestro | TL approval |

**Definition of done (epic):** All 3 hero E2E flows pass on real iPhone + Android. Diagnose loading copy switches at the time buckets. Permission denied recovers via Settings deep link. Photos compressed before upload.

---

### Epic E6 — Watering Rules ++ (location, indoor flag, override, weather)

**Goal:** Full watering rules engine with weather + location + manual override (codex tension #2 resolution).
**Phase:** P3
**Duration (team):** 4 days
**Owner:** BE1 + FE2

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E6-001** | Open-Meteo wrapper with KV cache (1-hour TTL, lat/lon key) on backend | BE1 | M | E1-001 | `/feature-dev` | `/codex review` |
| **E6-002** | `/api/weather` endpoint returning current + 2-day forecast for a lat/lon | BE1 | M | E6-001 | `/feature-dev` | `/codex review` |
| **E6-003** | Location permission pre-prompt + ZIP fallback (geocoding via Open-Meteo) | FE2 | M | E2-001 | `/feature-dev` + `expo-location` docs | `/design-review` + `/codex review` |
| **E6-004** | Migration: alter `plants` to add `is_indoor INTEGER` and `override_interval_days INTEGER` | FE2 | S | E2-002 | `/feature-dev` | `/codex review` |
| **E6-005** | `useWateringEngine()` v2 — adds weather modifier when `is_indoor=false` and override is null | FE2 | M | E4-001, E6-002, E6-004 | `/feature-dev` | adversarial (rule combinations) |
| **E6-006** | "Edit details" sheet on plant detail (toggle is_indoor, set custom interval) | FE2 | M | E2-011 | `/feature-dev` | `/design-review` |
| **E6-007** | Tests: rules with weather, rules with override, rules with is_indoor, location denied → ZIP path | QA1 | M | E6-005, E6-006 | `/qa-only` + jest | adversarial review |

**Definition of done (epic):** Outdoor plants in a rainy 2-day forecast move from "water today" to "skip" without the user touching anything. Indoor plants ignore weather. Custom-interval plants ignore rules entirely.

---

### Epic E7 — Sync Queue (offline mode)

**Goal:** Local-first; LLM-dependent actions queue and drain on reconnect.
**Phase:** P2 (after E5)
**Duration (team):** 3 days
**Owner:** FE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E7-001** | `sync_queue` table CRUD + status transitions | FE1 | M | E2-002 | `/feature-dev` | `/codex review` |
| **E7-002** | `SyncDrainer` with backoff (1m/5m/30m/2h/8h) + 7-day TTL sweeper | FE1 | L | E7-001 | `/feature-dev` | adversarial (concurrency) + `/codex review` |
| **E7-003** | NetInfo + AppState listeners trigger drainer on foreground+online | FE1 | S | E7-002 | `/feature-dev` | `/codex review` |
| **E7-004** | Wire diagnose / consult / identify to enqueue when offline + return `kind: 'queued'` | FE1 | M | E7-002, E5-006 | `/feature-dev` | `/codex review` |
| **E7-005** | `<ToastBanner type='pending'>` "{N} item(s) syncing" surface | FE1 | S | E2-012, E7-002 | `/feature-dev` | `/design-review` |
| **E7-006** | "Tap to retry" on failed/expired rows (re-queues with attempt_count=0) | FE1 | S | E7-002 | `/feature-dev` | `/codex review` |
| **E7-007** | Tests: state transitions, backoff schedule, TTL sweeper, retry button | QA1 | M | E7-006 | `/qa-only` + jest | adversarial review |
| **E7-008** | Maestro E2E: airplane mode → diagnose → reconnect → drain → result lands | QA1 | M | E7-004 | maestro | TL approval |

**Definition of done (epic):** With airplane mode on, every LLM action queues locally and shows a tan banner. Reconnect drains the queue in FIFO. Items 8 days old auto-expire. Retry button re-queues failed items with attempt_count=0.

---

### Epic E8 — Add Note + LLM Consult

**Goal:** A-2's "Add note" flow with chip suggestions + LLM-revised watering rec.
**Phase:** P4
**Duration (team):** 3 days
**Owner:** FE1 + BE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E8-001** | `/api/consult` endpoint (text + plant context → revised watering rec) | BE1 | M | E1-002, E1-008 | `/feature-dev` | `/codex review` + LLM eval |
| **E8-002** | LLM eval for consult (5 fixture text prompts incl. 1 off-topic reject) | BE1 + TL | S | E8-001 | `/feature-dev` | TL approves baseline |
| **E8-003** | `<AddNoteSheet>` using `<EditorialBottomSheet>` w/ 4 chip suggestions + free-text + inline LLM response | FE1 | L | E2-011, E8-001 | `/feature-dev` | `/design-review` |
| **E8-004** | Wire A-2 "Add note" button → opens sheet (un-hide from E4-007) | FE1 | S | E8-003, E4-007 | `/feature-dev` | `/codex review` |
| **E8-005** | Persist note + LLM response to `notes` table; update photo timeline with note entry | FE1 | M | E8-004 | `/feature-dev` | `/codex review` |
| **E8-006** | Tests: chip suggestion pre-fills, save & ask returns LLM rec, off-topic note routes through Layer-1 reject | QA1 | M | E8-005 | `/qa-only` + jest | adversarial review |

**Definition of done (epic):** Tap "Add note" on Steve's detail → bottom sheet → tap "Just repotted" → tap Save & ask → revised watering rec appears inline. Note persists. Off-topic notes show Layer-1 reject UI.

---

### Epic E9 — Weekly Review (A-6 + Sunday Letter)

**Goal:** The Sunday digest as the 5-year-relationship ritual.
**Phase:** P4
**Duration (team):** 2 days
**Owner:** FE2 + BE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E9-001** | `/api/review` endpoint (last-7-days data → narrative) | BE1 | M | E1-002 | `/feature-dev` | `/codex review` + LLM eval |
| **E9-002** | LLM eval for review (1 fixture week → assert response shape) | BE1 + TL | S | E9-001 | `/feature-dev` | TL approves baseline |
| **E9-003** | `<SundayLetterCard>` (appears on A-1 only on Sundays or 7+ days since last review) | FE2 | M | E2-001 | `/feature-dev` | `/design-review` (Pass 7 spec) |
| **E9-004** | `<WeeklyReviewScreen>` (A-6) — hero illustration + Fraunces narrative + per-plant ledgers | FE2 | L | E2-001, E4-003, E9-001 | `/feature-dev` | `/design-review` (Pass 7 spec) |
| **E9-005** | Tests: SundayLetterCard appears only on Sundays, dismiss persists until next Sunday, A-6 renders for empty week | QA1 | M | E9-004 | `/qa-only` + jest | adversarial review |
| **E9-006** | Maestro E2E: device-time set to Sunday → letter card visible → tap → A-6 → Got it dismisses | QA1 | M | E9-004 | maestro | TL approval |

**Definition of done (epic):** Sunday morning open the app → letter card at top → tap → A-6 with narrative + per-plant breakdown → dismiss → doesn't reappear until next Sunday.

---

### Epic E10 — Dark Mode (Midnight Conservatory)

**Goal:** Full dark-mode pass across all 6 screens with the same visual quality as light.
**Phase:** P4
**Duration (team):** 2 days
**Owner:** FE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E10-001** | Verify all primitives render correctly in dark via Component Garden screen | FE1 | S | E2-013 | `/design-review` | `/design-review` (vs D-* mockups) |
| **E10-002** | Verify all 6 screens render correctly in dark (toggle system theme on device) | FE1 | M | E5-013, E9-006 | manual + `/design-review` | `/design-review` (vs D-* mockups) |
| **E10-003** | Fix any contrast/legibility issues found in E10-002 | FE1 | M | E10-002 | `/feature-dev` | `/design-review` |
| **E10-004** | Maestro E2E: toggle dark mode mid-flow → no layout shift, no broken contrast | QA1 | S | E10-003 | maestro | TL approval |

**Definition of done (epic):** Side-by-side light + dark on every screen looks like the approved mockups (`A-*.png` and `D-*.png`). No raw `system-ui` text. No washed-out chips.

---

### Epic E11 — A11y + Budget Meter + 429 UX

**Goal:** Accessibility floor + the OpenRouter budget surfacing (codex tension #1 resolution).
**Phase:** P4
**Duration (team):** 2 days
**Owner:** FE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E11-001** | A11y audit pass: every interactive element has `accessibilityLabel` + role | FE1 | M | E2-013, E5-013, E9-006 | `/feature-dev` + RN a11y inspector | `/codex review` |
| **E11-002** | Touch target audit: every interactive ≥44×44 px (use `hitSlop` where visually smaller) | FE1 | S | E11-001 | manual audit | `/codex review` |
| **E11-003** | Dynamic type support: scale Fraunces + Inter via `PixelRatio.getFontScale()`; verify no layout breaks at 310% | FE1 | M | E2-013 | `/feature-dev` | `/codex review` + manual at 310% scale |
| **E11-004** | Reduce-motion compliance audit: pulses → static, transitions → instant | FE1 | S | E2-004, E5-007 | manual + `/codex review` | TL approval |
| **E11-005** | Budget meter "37/50 today" small all-caps in Plants list header (calls `/api/budget`) | FE1 | M | E1-007, E3-003 | `/feature-dev` | `/design-review` + `/codex review` |
| **E11-006** | 40+ today → tan banner "Approaching daily limit"; 50+ → disable LLM CTAs with tomorrow-refresh copy | FE1 | M | E11-005 | `/feature-dev` | `/design-review` |
| **E11-007** | Tests: a11y labels present, target sizes met, dynamic type doesn't break, budget meter triggers banner | QA1 | M | E11-006 | `/qa-only` + jest | adversarial review |

**Definition of done (epic):** VoiceOver / TalkBack reads every screen meaningfully. Dynamic type at 310% doesn't break any layout. Budget meter shows actual usage; banner triggers at 40+; LLM buttons disable at 50+.

---

### Epic E12 — Maestro E2E + Final QA Pass

**Goal:** All 8 critical E2E flows green on iOS + Android.
**Phase:** P4 → P5
**Duration (team):** 2 days
**Owner:** QA1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E12-001** | Maestro flow: Day 1 onboarding (clean install → identify → first plant) | QA1 | S | E5-013 | maestro | TL approval |
| **E12-002** | Maestro flow: daily glance loop (open → tap card → mark watered → ledger updates) | QA1 | S | E4-008 | maestro | TL approval |
| **E12-003** | Maestro flow: rescue moment (detail → diagnose → save) | QA1 | S | E5-013 | maestro | TL approval |
| **E12-004** | Maestro flow: quick diagnose (FAB long-press → result → Done, no save) | QA1 | S | E5-013 | maestro | TL approval |
| **E12-005** | Maestro flow: offline diagnose recovery | QA1 | M | E7-008 | maestro | TL approval |
| **E12-006** | Maestro flow: camera permission deny + recover via Settings deep link | QA1 | M | E5-004 | maestro | TL approval |
| **E12-007** | Maestro flow: add note + consult inline response | QA1 | S | E8-006 | maestro | TL approval |
| **E12-008** | Maestro flow: Sunday weekly review | QA1 | S | E9-006 | maestro | TL approval |
| **E12-009** | Run all 8 flows on Android (divergence pass) | QA1 | M | E12-001..008 | maestro | TL approval |
| **E12-010** | Final adversarial review: spawn Codex agent against full diff + plan | TL | M | E12-009 | `/codex review` | TL approves merge readiness |

**Definition of done (epic):** All 8 flows green on iPhone + Android. Codex final review returns no P1 findings. Test plan artifact (E0-006 baseline) fully covered.

---

### Epic E13 — Distribution

**Goal:** A real, installable build of the app.
**Phase:** P5
**Duration (team):** 2 days
**Owner:** TL + FE1

| ID | Title | Owner | Est | Dependencies | Skills | Review path |
|----|-------|-------|-----|--------------|--------|-------------|
| **E13-001** | EAS production build for iOS + Android (signed) | TL | S | E12-010 | EAS docs | TL self-verify |
| **E13-002** | TestFlight upload + invite (iOS) | TL | S | E13-001 | manual | TL self-verify |
| **E13-003** | Internal distribution link (Android) | TL | S | E13-001 | manual | TL self-verify |
| **E13-004** | App Store privacy data sheet (data not collected, photos local-only) | TL | S | — | manual | TL self-verify |
| **E13-005** | First dogfood install on Anand's iPhone + dogfood loop kickoff | TL | S | E13-002 | manual | start of 2-week dogfood |

**Definition of done (epic):** Anand opens TestFlight → installs PlantCare → adds his first real plant → uses the app daily for 2 weeks per success criteria.

---

## Cross-cutting concerns

### Definition of Ready (per ticket, before pickup)

- [ ] Acceptance criteria written
- [ ] Dependencies merged or stubbed
- [ ] Mockup linked (if UI)
- [ ] Test plan section identified (which lines from the test plan artifact apply)
- [ ] Skill invocation path noted

### Definition of Done (per ticket, before merge)

- [ ] Code written + WIP commits squashed
- [ ] Tests pass locally + CI
- [ ] Adversarial review (codex + claude subagent) returns no P1
- [ ] Design review passed (UI tickets only)
- [ ] QA pass run via `/qa-only` against the test plan, no critical regressions
- [ ] TL has eyeballed the diff
- [ ] PR description references the epic + ticket ID
- [ ] Plan footer (`## GSTACK REVIEW REPORT`) shows CLEAR

### Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Free-tier OpenRouter exhausted during dogfooding | Medium | High | Budget meter (E11-005); fallback to $10 credit if it trips repeatedly |
| Free vision model can't disambiguate fiddle leaf vs rubber plant | High | Medium | LLM evals (E1-010, E5-002); paid escalation already in router |
| Timezone bug ships in `useWateringEngine` | Medium | High | E4-002 mandatory regression test |
| Camera permission denial flow regresses on iOS update | Low | High | Maestro E12-006 nightly |
| Photo compression breaks on edge cases (HEIC, panorama) | Medium | Medium | Add HEIC + panorama fixtures to E5-005 tests |
| Dark mode contrast looks bad on certain plant photos | Low | Medium | E10-002 manual visual QA on real device |
| Android divergence surfaces late | Medium | Medium | E12-009 explicit Android pass |
| Anand stops dogfooding before 2 weeks | Low | High | Notification voice (Pass 7) designed to feel like a postcard, not a reminder |

### Skill invocation index by ticket type

| Ticket type | Code phase | Adversarial review | QA | Ship |
|-------------|-----------|--------------------|----|------|
| Backend endpoint | `/feature-dev` | `/codex review` + LLM eval | `/qa-only` (eval suite) | `/ship` |
| Mobile screen | `/feature-dev` | `/codex review` + Claude subagent | `/qa-only` + Maestro | `/ship` |
| Mobile primitive | `/feature-dev` | `/codex review` | `/qa-only` (component tests) | `/ship` |
| Hook / pure function | `/feature-dev` | `/codex review` | `/qa-only` (jest unit) | `/ship` |
| Schema / migration | `/feature-dev` | `/codex review` + adversarial | `/qa-only` (migration test) | `/ship` |
| E2E test | maestro | n/a | manual real-device verification | `/ship` |
| Distribution | EAS docs | n/a | TestFlight smoke | n/a |

---

## Solo + AI mode adaptations

If running this with just CC + Codex (no team):

1. **Spawn parallel agents per lane.** Use `Agent` tool with `isolation: "worktree"` for E1 (backend) and E2 (mobile foundation) simultaneously. Then E3 ‖ E4 (different screens, different agents). Then E5 (camera + diagnose) sequential. Then E7 ‖ E8 ‖ E9 (offline + notes + weekly).
2. **TL time per epic:** ~2-4 hours of TL attention (review + decisions + dogfooding). Most "engineering" hours are AI agent hours.
3. **Adversarial review:** automatic in this setup — every PR fires `/codex review` + Claude subagent. TL reads only the consolidated summary.
4. **QA:** `/qa` runs the test plan artifact; failures surface back to the spawning agent for fix-and-retry.
5. **Total wall time:** ~5 weekends as in the solo Gantt above.

---

## Hand-off prompts (template)

When spawning an agent on a ticket, use this self-contained briefing:

```
TICKET: <E#-###> — <title>
EPIC: <epic name>
PLAN: ~/All_Projects/Projects/PlantCare/plans/as_macmini-Anandsatch-plant-care-app-design-20260429-193756.md
DESIGN.md: /Users/as_macmini/All_Projects/Projects/PlantCare/DESIGN.md
TEST PLAN: ~/All_Projects/Projects/PlantCare/plans/as_macmini-main-eng-review-test-plan-20260501-171332.md
APPROVED MOCKUPS: ~/All_Projects/Projects/PlantCare/designs/v1-screens-20260430/

ACCEPTANCE CRITERIA:
- <bullet 1>
- <bullet 2>

DEPENDENCIES (must be merged):
- <ticket id>

SKILLS:
- Code: /feature-dev
- Adversarial review: /codex review + Claude subagent
- Design review (if UI): /design-review
- QA: /qa-only with the test plan as input
- Ship: /ship after all gates pass

DO NOT:
- Skip the adversarial review
- Merge with P1 findings unresolved
- Modify other tickets' scope
```

---

## Status board (TL maintains)

Update this table per ticket as work progresses. Use it to drive standups and unblock dependencies.

| Epic | Tickets | Status | Blocker |
|------|---------|--------|---------|
| E0 Foundation | 7/7 | ✅ DONE — shipped 2026-05-02 as v0.1.0.0 (PR #1, fd18fbb) | — |
| E1 Backend MVP | 2/5 | 🟡 IN PROGRESS — E1-001 `/api/identify` shipped 2026-05-02 (v0.1.1.0); E1-002 `/api/diagnose` shipped 2026-05-03 (v0.1.2.0); router refactored to factory + parseImageUpload extracted | E1-003..005 unblocked |
| E2 Mobile foundation | 0/13 | not started | E0 |
| E3 Plants list | 0/5 | not started | E2 |
| E4 Plant detail + watering v1 | 0/8 | not started | E2 |
| E5 Camera + diagnose + add | 0/13 | not started | E1, E2 |
| E6 Watering ++ | 0/7 | not started | E1, E2, E4 (Open-Meteo called direct from device — no backend /weather endpoint) |
| E7 Sync queue | 0/8 | not started | E2, E5 |
| E8 Add note + consult | 0/6 | not started | E1, E4 |
| E9 Weekly review | 0/6 | not started | E1, E2, E4 |
| E10 Dark mode | 0/4 | not started | all UI epics |
| E11 A11y + budget meter | 0/7 | not started | all UI epics, E1 (budget meter uses local SQLite counter, not /api/budget) |
| E12 Maestro + final QA | 0/10 | not started | all feature epics |
| E13 Distribution | 0/5 | not started | E12 |
| **TOTAL** | **9/99 tickets** | **9%** | E0 done; E1-001 + E1-002 shipped; E1-003 next |

---

## Next action

E1-002 shipped 2026-05-03. Next: **E1-003** `/api/consult` — text-only endpoint (first non-vision caller of the router; will surface whether `RouterInput` should become a discriminated union). Same per-ticket workflow as E1-001 + E1-002.

---

## Post-V1 followups (captured during V1 build, defer to phase 2+)

Tracked here so they don't rot in chat history. Each item has a trigger condition — don't pull forward without it.

| ID | Item | Trigger to actually do it | Captured |
|----|------|---------------------------|----------|
| **PV1-001** | Server-side cheap-model verifier/normalizer for `/api/diagnose` output. Run a small free text model (≤8K context — diagnose JSON is tiny, no need for a big context window) as a second pass to normalize severity, validate fix_steps, and sanity-check the diagnosis against the symptoms. Today V1 handles drift via deterministic string normalization (Option C in E1-002). | Eval suite (E1-005 / E5-002) shows free-tier diagnose accuracy < 70% on fixtures, OR dogfooding surfaces "plausible but wrong" diagnoses that string fixes can't catch. Need data, not vibes. | 2026-05-03, during E1-002 design |
