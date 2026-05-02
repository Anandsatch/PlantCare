# Changelog

All notable changes to PlantCare will be documented in this file.

## [0.1.1.0] - 2026-05-02

E1-001 — first of four LLM proxy endpoints. The backend can now identify a plant from a photo: mobile POSTs an image, backend asks a free vision model first, escalates to a paid model only when the free model can't answer confidently. Not yet wired to mobile (E2/E5 will consume it).

### Added
- `POST /api/identify` on the Cloudflare Worker. Accepts multipart/form-data (image + `X-Device-Id` header), validates MIME by both header and magic bytes, returns `ApiResult<IdentifyResponse>` with species + confidence + alternatives + which model answered.
- Tiered LLM router: free Llama 3.2 11B Vision (OpenRouter free tier) first, escalates to Claude 3.5 Sonnet on JSON parse failure or confidence below 70.
- `safeJsonParse` — string-literal-aware parser that recovers JSON from ` ```json ` fences, leading prose, and trailing commas without damaging string content.
- Caller-abort propagation: a disconnected client cancels the upstream OpenRouter call instead of burning the full free + paid timeout budget.
- 45 backend tests across router boundaries, parser edge cases, route validation, and OpenRouter abort behavior.
- `IdentifySource` discriminator (`free` / `paid_escalated` / `free_failed`) so the mobile A-3 result screen can render "I'm not sure" UX correctly when the backend returns a degraded fallback.

### Changed
- WORKBACK.md Epic E1 restructured: 10 tickets collapsed to 5. The four LLM proxy endpoints (identify / diagnose / consult / review) are now all in E1, sharing one router built once. KV-backed rate limit, escalation budget, `/api/budget`, Layer-1 classifier, and Layer-5 image gate moved to a Post-MVP deferred section per V1 scope lock (rate limit + budget tracked client-side in SQLite for V1).

## [0.1.0.0] - 2026-05-02

E0 Foundation & Tooling — first shippable scaffold of the V1 build. After this version, you can `git clone && bun install && bun run mobile:ios` and see a Conservatory-styled empty Plants list on a real iPhone or Simulator within ~10 minutes.

### Added
- Bun-workspace monorepo with `apps/mobile`, `apps/backend`, `packages/api-types`, `packages/theme`.
- Expo SDK 55 + Expo Router 5 mobile app aligned to the SDK manifest.
- Hono on Cloudflare Workers backend skeleton with vitest + `@cloudflare/vitest-pool-workers`.
- EAS development build profiles for iOS Simulator and Android device.
- CI on GitHub Actions: typecheck + jest (mobile) + vitest (backend) on every push and PR.
- Conservatory design tokens in `packages/theme` — light + Midnight dark palettes ported from `DESIGN.md`.
- Fraunces + Inter font loading via `@expo-google-fonts/*`, gated until both load to prevent system-font flash. Falls through to system fonts on load error so offline cold-start doesn't hang.
- Maestro smoke flow `.maestro/smoke-empty-plants.yaml` asserting the empty Plants list renders on launch.
- Project rules in `CLAUDE.md`, execution plan in `WORKBACK.md`, design system docs in `DESIGN.md`, master architecture plan + test plan in `plans/`, approved mockups (light + dark) in `designs/`.

### Changed
- Code review runs locally (`/codex review` + Claude adversarial via `/gstack-ship`) rather than in CI — no `OPENAI_API_KEY` repo secret needed.
