# PlantCare

A botanical field guide for your real plants. Local-first plant care app for iOS + Android, in the **Conservatory** design language — warm, editorial, paper-feel.

## Stack

- **Mobile:** Expo SDK 55 + Expo Router 5 (React Native 0.85)
- **Backend:** Hono on Cloudflare Workers (LLM proxy only — no user data stored server-side)
- **Storage:** SQLite on-device (`expo-sqlite`)
- **LLM:** OpenRouter (free tier with paid escalation)
- **Weather:** Open-Meteo (called directly from the device — no API key)

## Monorepo

| Path | Role |
|------|------|
| `apps/mobile` | Expo app (iOS + Android, portrait-only) |
| `apps/backend` | Hono + Cloudflare Workers — 4 LLM proxy endpoints (V1) |
| `packages/api-types` | Shared TypeScript request/response shapes |
| `packages/theme` | Conservatory design tokens (light + dark) |

## Documentation

- [`DESIGN.md`](./DESIGN.md) — Conservatory design system: colors, typography, status icons, droplet ledger, accessibility baseline
- [`WORKBACK.md`](./WORKBACK.md) — Execution plan: 14 epics, 109 tickets, status board
- [`CLAUDE.md`](./CLAUDE.md) — AI agent project rules
- [`plans/`](./plans/) — Architecture + design plans
- [`designs/`](./designs/) — Approved mockups (light + dark, 5 screens each)

## Quick start

Requires Bun ≥ 1.3, Node ≥ 20, EAS CLI, Wrangler CLI.

```sh
bun install

# Mobile (Expo dev server)
bun run mobile:ios       # or :android

# Backend (local Worker)
bun run backend:dev
```

## CI / Code Review

Every PR targeting `main` gets two automated adversarial review passes plus the
standard test CI. All three are advisory — the TL approves the merge.

| Reviewer | Trigger | Setup |
|----------|---------|-------|
| Test CI (typecheck + jest + vitest) | every push + PR | none — runs out of the box |
| Codex (`codex review`) | PR `opened`, `synchronize`, `reopened` | add `OPENAI_API_KEY` to repo secrets |
| CodeRabbit | PR `opened`, `synchronize`, `reopened` | install the [CodeRabbit GitHub App](https://github.com/marketplace/coderabbit-ai) on this repo |

### Enable Codex

Settings → Secrets and variables → Actions → **New repository secret**:

- Name: `OPENAI_API_KEY`
- Value: an OpenAI API key with access to the model Codex CLI uses

The workflow (`.github/workflows/codex-review.yml`) fails loudly with a clear
error message if the secret is missing, so it's easy to spot. It posts a single
PR comment that edits in place on subsequent pushes (look for the
`<!-- codex-review-marker -->` HTML comment).

### Enable CodeRabbit

Install the [CodeRabbit GitHub App](https://github.com/marketplace/coderabbit-ai)
and grant it access to `Anandsatch/PlantCare`. Configuration lives in
[`.coderabbit.yaml`](./.coderabbit.yaml) — `chill` profile, path-specific
guidance for mobile/backend/theme/tests, and lockfiles + design assets ignored.

## Status

V1 in development. See [`WORKBACK.md`](./WORKBACK.md) for the live status board.
