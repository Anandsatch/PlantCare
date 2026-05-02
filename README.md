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

CI runs **typecheck + jest (mobile) + vitest (backend)** on every push and PR.

Adversarial code review runs **locally**, not in CI:
- `/codex review` — local invocation per ticket (uses your `codex login` ChatGPT auth, no API key needed)
- `/gstack-ship` Step 11 — automatic Claude adversarial subagent + local `codex` adversarial pass before every merge

No CI secrets needed for review. The TL approves the merge.

## Status

V1 in development. See [`WORKBACK.md`](./WORKBACK.md) for the live status board.
