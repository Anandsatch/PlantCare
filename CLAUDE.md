# PlantCare — Project Conventions

## Stack

- **Mobile:** Expo (React Native), iOS + Android, portrait-only
- **Backend:** Hono on Cloudflare Workers (free tier), with KV for rate limit + escalation budget
- **Storage:** Local SQLite via `expo-sqlite` (no cloud sync in V1)
- **LLM:** OpenRouter free tier with paid escalation router (free → Claude 3.5 Sonnet on confidence < 70 or JSON parse fail)
- **Weather:** Open-Meteo (no key)
- **Photos:** `expo-image-manipulator` compressed to 1024px @ 0.7 quality, stored in `FileSystem.documentDirectory`
- **Distribution V1:** EAS Development Build (NOT Expo Go); Anand's iPhone + Android device

## File layout

```
~/All_Projects/Projects/PlantCare/
├── CLAUDE.md                    This file
├── DESIGN.md                    Conservatory design system (light + dark tokens)
├── WORKBACK.md                  Execution plan: 14 epics, 109 tickets, ASCII Gantt
├── plans/                       Markdown plans
│   ├── as_macmini-Anandsatch-plant-care-app-design-20260429-193756.md  ← MASTER design+arch plan
│   └── as_macmini-main-eng-review-test-plan-20260501-171332.md         ← test plan (consumed by /qa)
├── designs/                     Mockups + comparison boards
│   ├── v1-screens-20260430/         5 light Conservatory mockups + approved.json
│   ├── v1-screens-20260430-dark/    5 Midnight Conservatory mockups
│   └── all-screens-20260430-2111/   variant scratch dir
├── apps/                        (TODO E0) backend + mobile
├── packages/                    (TODO E0) api-types + theme
└── .maestro/                    (TODO E12) E2E flows
```

The gstack tooling directory `~/.gstack/projects/Anandsatch-PlantCare/` contains symlinks back to this project's `plans/` and `designs/`, plus per-machine telemetry (`learnings.jsonl`, `timeline.jsonl`, `*-reviews.jsonl`). When gstack skills run, they write to gstack paths which resolve through the symlinks to here.

**Convention:** any new plan or design artifact ends up here, not in gstack. If a gstack skill writes to gstack first, move it to `plans/` or `designs/` and symlink back.

## Source-of-truth hierarchy

1. **`plans/as_macmini-Anandsatch-plant-care-app-design-20260429-193756.md`** — the canonical plan. Architecture, schema, router contract, queue state machine, photo compression, theme/API patterns, codex tensions resolved, GSTACK REVIEW REPORT footer. ~880 lines. Read this first.
2. **`DESIGN.md`** — design tokens (Conservatory + Midnight). Loaded by `theme/colors.ts`. Future `/design-shotgun` and `/design-review` runs auto-pick these up.
3. **`WORKBACK.md`** — the execution plan. 109 tickets with dependencies, per-ticket workflow, Gantt, skill invocation cheatsheet. Use this to assign work.
4. **`plans/as_macmini-main-eng-review-test-plan-20260501-171332.md`** — test plan artifact. Consumed by `/qa` and `/qa-only` as the primary test input.

## Per-ticket workflow (mandatory)

```
1. Pick up ticket → /feature-dev or spawn Agent in worktree
2. Code → WIP commits along the way
3. Adversarial review → /codex review + /coderabbit:review + Claude subagent challenge
4. Design review (UI tickets only) → /design-review against the approved mockup
5. QA → /qa-only with the test plan as input + Maestro for E2E tickets
6. TL approval → eyeball the diff
7. Ship → /ship → merge → deploy
```

Detail in `WORKBACK.md` § Per-ticket workflow. Gates that block ship: P1 finding from adversarial review, critical regression test failing, design review flagging "AI slop" or "diverges from mockup."

## Critical regression — MANDATORY test

`useWateringEngine` must use millisecond math, not calendar-day math, to survive DST transitions and timezone changes (international date line flights). Ticket E4-002 in WORKBACK.md is non-skippable.

## Active phase

V1 build hasn't started. Next action: kick off Epic E0 (Foundation & Tooling) — see `WORKBACK.md` § E0.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules for this project:
- Product ideas/brainstorming → invoke /office-hours
- Architecture changes → invoke /plan-eng-review
- Design system changes → invoke /design-consultation or /plan-design-review
- New visual mockups → invoke /design-shotgun
- Bugs/errors → invoke /investigate
- QA/testing → invoke /qa or /qa-only (consumes the test plan in `plans/`)
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore

## Testing

- **Mobile unit + component:** `bun test` (jest + jest-expo + @testing-library/react-native)
- **Backend unit + integration:** `bun test` in `apps/backend/` (vitest + @cloudflare/vitest-pool-workers)
- **E2E:** `maestro test .maestro/` (8 critical flows; both iOS and Android)
- **LLM evals:** `bun test evals/` in `apps/backend/` (vitest snapshot, ±10 confidence band)

Coverage target: 80% line coverage on `src/hooks/`, `src/sync/`, `src/api/`, `apps/backend/src/`.
