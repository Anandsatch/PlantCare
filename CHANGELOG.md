# Changelog

All notable changes to PlantCare will be documented in this file.

## [0.1.7.0] - 2026-05-04

E2-002 — SQLite schema + migrations. Second mobile-foundation ticket of Epic E2. Local SQLite via `expo-sqlite` is the V1 storage layer — no cloud sync, no ORM, raw SQL. This PR ships all six tables (`plants`, `watering_events`, `photos`, `notes`, `diagnoses`, `sync_queue`), every index from the master plan plus two cascade-companion indexes surfaced in adversarial review, a versioned migration runner using SQLite's built-in `PRAGMA user_version`, and an `openDb()` that sets `PRAGMA foreign_keys = ON` at connection time so the FK constraints actually enforce. 30 mobile tests now passing (15 new for db).

### Added
- `apps/mobile/src/db/schema.ts` — single-source-of-truth SQL string for the V1 schema. Includes the WORKBACK additions on `plants` (`is_indoor INTEGER NOT NULL DEFAULT 1` with a `CHECK (is_indoor IN (0, 1))` bool guard, `override_interval_days INTEGER` nullable for the custom-watering-schedule toggle). All cascade FKs spelled out: `watering_events`, `photos`, `notes`, `diagnoses` ON DELETE CASCADE from `plants`; `diagnoses.photo_id` ON DELETE CASCADE from `photos`; `plants.hero_photo_id` ON DELETE SET NULL from `photos`. `sync_queue` is intentionally unconstrained (`ref_table` / `ref_id` are dynamic strings — the worker dispatches by table name).
- `apps/mobile/src/db/migrations.ts` — versioned migration runner. `runMigrations(db, migrations)` reads `PRAGMA user_version`, runs every pending migration in `version` order, each inside its own transaction so a partial failure rolls back both the schema mutation and the version bump. Validates the migration list at startup (positive integers, monotonic, no duplicates) — silently corrupted upgrade graphs are the worst kind of bug.
- `apps/mobile/src/db/db.ts` — `openDb()` opens `plantcare.db` via `expo-sqlite`'s `openDatabaseAsync`, runs `PRAGMA foreign_keys = ON` (SQLite default is OFF — without this, every FK constraint in the schema is inert), then runs migrations. Memoized: subsequent calls return the same `SQLiteDatabase` instance. Cache is dropped on failure so the next call retries instead of permanently returning a rejected promise.
- `apps/mobile/src/db/index.ts` — barrel.
- `apps/mobile/src/db/__tests__/migrations.test.ts` — 16 tests (30 total in the mobile suite). Drives the migration runner against a `better-sqlite3`-backed `SqlExecutor` adapter (chosen over `node:sqlite` because CI runs on Node 20 and `node:sqlite` is Node 22.5+). Coverage: all 6 tables created, all 8 indexes created, FK declarations match the contract per `PRAGMA foreign_key_list`, FK violation rejected when `foreign_keys = ON`, plant→watering_events and photo→diagnoses cascade deletes, `is_indoor` defaults to 1 + CHECK rejects out-of-range values, `idx_plants_active` and `idx_queue_drainable` partial indexes selected by the query planner via `EXPLAIN QUERY PLAN`, `idx_plants_hero_photo` selected for the photo-cascade lookup path, hero_photo_id correctly set to NULL on photo delete, `user_version` advances to target on first run and is no-op on re-open, transactional rollback when migration up() throws (verified via `user_version` stays at 0 + dropped table), and migration validation rejects duplicate / out-of-order / non-positive versions.
- `expo-sqlite@~15.2.0` runtime dep + `better-sqlite3@^12.9.0` dev dep (test backend only — the on-device build still goes through expo-sqlite).

### Adversarial review (codex)
Two rounds of `codex exec` adversarial review caught three issues before ship:
- **P1** — first-pass test imported `node:sqlite` which would have failed on CI's Node 20 runner. Switched to `better-sqlite3` (Node 20+ compatible). Local Node 25 hides this gap; CI doesn't.
- **P2** — missing `idx_diagnoses_photo` for the `diagnoses.photo_id REFERENCES photos(id) ON DELETE CASCADE` cascade lookup. Added.
- **P2** — missing `idx_plants_hero_photo` for the `plants.hero_photo_id REFERENCES photos(id) ON DELETE SET NULL` cascade lookup. Added as a partial index (`WHERE hero_photo_id IS NOT NULL`) since the SET NULL path only ever matches non-null rows.
- **Rejected** — codex's third-pass suggestion to remove `diagnoses.plant_id` as redundant with `photo_id -> photos.plant_id` violates V1 scope locks. The master plan explicitly defines both columns: `plant_id` is nullable for the Quick Diagnose flow where a photo isn't attached to a plant yet, and photos aren't reassigned between plants in V1 (no UI for that).

### Notes
- All timestamps are unix milliseconds (`INTEGER`). The watering engine does millisecond math, not calendar-day math, to survive DST flips and the international date line (E4-002 critical regression). INTEGER handles years 1970-2262 — well beyond any V1 user retention window.
- Soft-delete on `plants` uses `archived_at` rather than DELETE, so the `ON DELETE CASCADE` on watering_events / photos / notes / diagnoses doesn't wipe history when a plant is archived. The CASCADE only fires on the (currently uncommanded) hard delete path, where wiping history is the right behavior.
- `idx_plants_active` and `idx_queue_drainable` are partial indexes — they only contain the rows the app actually queries (`archived_at IS NULL` plants, `status = 'pending'` queue entries). Smaller than full indexes, and the planner picks them automatically when the query's WHERE clause matches the index predicate. EXPLAIN QUERY PLAN tests guard against accidental full-table scans.
- expo-sqlite's `SQLiteDatabase` class is structurally compatible with the `SqlExecutor` interface defined in `migrations.ts` — no cast needed at the `db.ts` call site. Tests exploit the same shape via a thin `better-sqlite3` adapter.

## [0.1.6.0] - 2026-05-04

E2-001 — `useTheme()` hook. First mobile-foundation ticket of Epic E2. Wraps `@plantcare/theme`'s already-shipped `lightTheme` (Conservatory) and `darkTheme` (Midnight Conservatory) constants in a one-line hook driven by RN's `useColorScheme()`. No `<ThemeProvider>` and no `useMemo` — module-level frozen constants give stable identity across renders, so RN re-renders consumers automatically when the OS appearance flips. Per the master plan: no manual theme override in V1; the OS decides.

### Added
- `apps/mobile/src/hooks/useTheme.ts` — `useColorScheme() === 'dark' ? darkTheme : lightTheme`. Anything else (`null`/`undefined` during cold start, `'unspecified'` on Android with no preference, `'light'`) falls through to light, matching the iOS factory default and DESIGN.md's cream-as-canonical-surface stance.
- `apps/mobile/src/hooks/__tests__/useTheme.test.tsx` — 7 tests: light → Conservatory, dark → Midnight, null/undefined/'unspecified' → light, reference stability across same-scheme renders, reference flip on scheme change. Mock widens RN's legacy `ColorSchemeName` (which incorrectly omits null in the public types) so the cold-start branches are exercised.
- `apps/mobile/src/hooks/index.ts` barrel.

### Notes
- The mock cast (`as unknown as jest.Mock<WidenedScheme, []>`) works around `react-native`'s legacy public-types entry declaring `useColorScheme(): ColorSchemeName` without `null | undefined`. The newer `types_generated/` entry is accurate, but the package's `"types"` field still resolves the legacy version. The runtime contract — null during cold start, undefined on background-resume — is real and tested.
- DOD criterion "<100ms theme switch via system setting" is structurally satisfied: RN re-renders `useColorScheme` consumers on `Appearance` change events, and the hook does no async work. Empirical measurement waits on a live mockup screen (E2-013 Component Garden).

## [0.1.5.0] - 2026-05-04

E1-005 — LLM eval harness. With all four endpoints (identify, diagnose, consult, review) sharing the tiered router, this PR adds the regression suite that catches contract drift on the parser + router state machine without burning OpenRouter quota on every push. Two-mode design: the default mock mode drives canned LLM JSON through the real router and asserts the parsed shape; a future EVAL_REAL_API=1 mode (scaffolded as `.todo`) will hit live OpenRouter and use the same fixtures as the ±10 confidence band baseline. The mock-mode bug-catchers are the snapshot files plus a per-endpoint `expectCallArgs` that validates the OpenRouter wire shape (kind, imageDataUrl/userMessage, system-prompt fragment, apiKey).

### Added
- `apps/backend/evals/` directory with 26 fixtures: identify (10 — 6 healthy + 2 partial + 1 low-light + 1 cat reject), diagnose (10 — 7 sick + 2 healthy + 1 cat reject), consult (5 — 4 plant-related + 1 off-topic reject), review (1 mixed-week with 6 plants). Each fixture pairs canonical LLM JSON with a baseline confidence used by the ±10 band assertion in real-API mode.
- `evals/eval-runner.ts` with `mockCalls(...outcomes)` (plays canned outcomes through `vi.fn<typeof callFree>()`), `assertConfidenceBand(name, actual, baseline)` (named drift errors that survive CI-log diffs), and `expectCallArgs(spy, i, expected)` — the silent-pass guard from the adversarial review. Argument-shape assertions catch regressions in `router.toCallArgs` (wrong `kind`, missing `imageDataUrl`, wrong system prompt, missing `apiKey`) that canned-response mocks would otherwise paper over.
- `apps/backend/vitest.eval.config.ts` — separate Node-pool config so evals run in 400ms without spinning up workerd. Default `vitest.config.ts` now scopes its workers-pool include to `test/**/*.test.ts` so the two suites stay separate.
- `bun run eval` and `bun run eval:watch` scripts on `@plantcare/backend`.
- Per-endpoint paid-escalation success tests for identify and diagnose (E1-005 adversarial review): free returns garbage, paid returns a parseable response, asserts `source='paid_escalated'` plus the parser shape contract on the paid arm. Without these, the paid-side parser could regress and every other eval would still pass.
- Aggregate snapshot per endpoint: parsed shape across all fixtures in a single `__snapshots__/*.snap` file, `latency_ms` stripped so timing nondeterminism doesn't pollute the diff. Surfaces parser drift in one visible block.
- Review-eval per-plant alignment assertion (`per_plant.length === request.plants.length`) — the catch from E1-004 adversarial review, now structurally enforced. The parser permits mismatched lengths; only the eval enforces the prompt-mandated 1:1 echo.
- Review-eval narrative length contract: 100 ≤ length ≤ 400 per the test plan and system prompt.
- Diagnose-eval reject-branch `fix_steps.length === 0` assertion (E1-005 adversarial P1): a parser bug returning instructions on an unidentified plant ('unknown' slug) would have shipped silently otherwise.

### Deferred (post-V1)
- Real-API mode (`EVAL_REAL_API=1`): scaffolded as `it.todo` placeholders for each endpoint. Image fixtures land alongside this mode in a follow-up PR. Requires real OpenRouter quota during runs.
- Eval coverage of `buildUserMessage` for consult/review: covered today by `test/consult.test.ts` and `test/review.test.ts` via the full Hono route handler with fetchMock. Eval scope is parser + router state machine, not request-body composition.
- Vitest eval-pool isolation: low practical risk at the current fixture count; revisit if the suite grows past 50 fixtures.

### Notes
- The off-topic consult fixture wording — "What's the best dog food for a labrador?" — was invented per the autonomous-build prompt's leeway. The original test plan example was "a question about my dog"; flag for review if a different shape better matches your dogfooding mix.

## [0.1.4.0] - 2026-05-04

E1-004 — last of four LLM proxy endpoints. The backend can now generate a weekly garden letter: mobile POSTs the past 7 days of plant counts (per-plant watering + skips + diagnoses), backend asks the free model first, escalates to paid on parse failure or low confidence, and returns the editorial Fraunces headline + one-paragraph narrative + per-plant observations that A-6 needs. Not yet wired to mobile (E9 will consume it). All four E1 endpoints — identify, diagnose, consult, review — now share the same tiered router; E1-005 (eval harness) is next.

### Added
- `POST /api/review` on the Cloudflare Worker. Accepts JSON body `{week_summary: {plants_total, watering_events, skip_events, diagnoses}, plants: [{species_slug, nickname?, watering_count, skip_count, had_diagnosis}]}` plus `X-Device-Id` header. plants array capped at 50, per-plant counts capped at 30, week totals capped at 300 — bounded so a hostile body can't blow up the prompt token count. Returns `ApiResult<ReviewResponse>`.
- `ReviewResponse` shape: `{headline, narrative, per_plant: [{species_slug, observation}], confidence, source, latency_ms}`. Headline ≤ 80 chars, narrative ≤ 400 chars (per the test plan's 100-400 range), each observation ≤ 200 chars. The mobile A-6 weekly review screen renders the headline + narrative as the editorial voice and pairs each observation with the local 7-day ledger for that plant.
- `SYSTEM_PROMPT_REVIEW` requiring `headline + narrative + per_plant + confidence`. Voice is editorial: "names the week's character, not its numbers"; narrative addresses the reader as 'you'; per_plant entries use the plant's nickname when present and interpret the data rather than echoing it. Empty plants array still returns a valid response with a "Ready when you are" nudge to add the user's first plant.
- `parseReview` with strict `per_plant` array validation: hostile entries (null, missing species_slug, missing observation, whitespace-only fields) are dropped silently; oversized observations truncated; missing or non-array `per_plant` triggers escalation rather than passing through.
- `routes/_reviewRequest.ts` JSON-body validator: `isBoundedInt` rejects fractional counts (would shift the LLM prompt), negative numbers, and over-cap values; nickname trimmed and length-capped; species_slug required and trimmed.
- 21 backend tests covering router boundaries (escalation on parse fail, escalation on low confidence, paid recommendation, free_failed degraded fallback), parser hostile-input cases (oversized inputs truncated to spec caps, mixed-quality per_plant entries dropped, missing per_plant triggers escalation), and HTTP-level JSON validation (missing/fractional/negative counts, oversized plants array, invalid plant entries). Total backend tests: 148.

### Changed
- `apps/backend/src/index.ts` registers `/api/review` alongside identify, diagnose, and consult. All four endpoints now share the `createLlmRouter<T>` factory and the same `IdentifySource` discriminator (`'free' | 'paid_escalated' | 'free_failed'`).
- `routes/_consultRequest.ts` comment updated: `_validation/` subdirectory deferred. Three flat `_*.ts` helpers (`_imageUpload`, `_consultRequest`, `_reviewRequest`) is still easier to find than three under a subdirectory; the regroup waits until a fourth helper or a real navigation pain point shows up.

### Deferred (post-V1)
- Per-plant observation eval — E1-005 will assert observation length and species_slug echoing against a fixture week. Not wired in this PR.
- `ReviewResponse.per_plant` ordering: parser preserves model-emitted order. Mobile A-6 will pair observations to plants by `species_slug` lookup rather than relying on positional order, so a model that reorders entries doesn't misattribute observations.

## [0.1.3.0] - 2026-05-04

E1-003 — third of four LLM proxy endpoints. The backend can now answer a free-text question about a specific plant: mobile POSTs a note (e.g. "I just repotted it") plus optional plant context, backend asks the free model first, escalates to paid on parse failure or low confidence. First text-only endpoint, and the first one with a structural off-topic rejection path so a hostile or irrelevant note ("recommend bleach", "tell me a joke") gets refused without burning a paid call. Not yet wired to mobile (E8 will consume it).

### Added
- `POST /api/consult` on the Cloudflare Worker. Accepts JSON body `{note, plant_context?}` plus `X-Device-Id` header. Note is 1-2000 chars after trim with the length cap applied before trim so a 100KB whitespace blob can't burn CPU. plant_context is optional and strictly validated per field (species_slug, is_indoor, override_interval_days as positive integer 1-365, watering_history capped at 7 entries). Returns `ApiResult<ConsultResponse>`.
- `ConsultResponse` is a discriminated union: `{kind: 'recommendation', revised_interval_days, reasoning, confidence, source, latency_ms}` for plant-care answers, or `{kind: 'rejected_off_topic', reason, source, latency_ms}` for off-topic notes. The route handler maps `rejected_off_topic` to `ApiResult.rejected_off_topic` at the wire boundary, so mobile callers get the same `ok: false, kind: 'rejected_off_topic'` shape they already handle.
- `SYSTEM_PROMPT_CONSULT` requiring the model to return JSON in one of two shapes, each tagged with an explicit `rejected: <bool>` discriminator. Rejection triggers are enumerated in the prompt: not plant-related, instruction-override attempts, harmful actions (bleach, gasoline, salting soil), and ambiguous notes.
- `parseConsult` with the rejection discriminator winning over recommendation keys — a hostile model that emits `{rejected: true, revised_interval_days: 1, reasoning: "water with bleach"}` still routes to rejection. Parser-level defenses cover NaN/Infinity confidence, fractional `revised_interval_days` clamping to [1, 30], reasoning truncation at 500 chars, rejection-reason truncation at 200 chars.
- 49 backend tests across consult router boundaries (rejection bypasses both confidence gate and budget gate, paid-side rejection collapses correctly, abort signal threading, system prompt isolation), parser hostile-input cases (prompt injection wrapped around valid JSON, missing/non-boolean discriminator, oversized inputs), and HTTP-level JSON validation (note bounds, plant_context shape, fractional override rejection). Total backend tests: 127.

### Changed
- `RouterInput` widened to a discriminated union: `{kind: 'vision', imageDataUrl}` for identify/diagnose, `{kind: 'text', userMessage}` for consult and the future review endpoint. `CallArgs` in `openrouter.ts` mirrors the shape; `callOpenRouter` switches on `kind` to build either the OpenRouter image_url content array or a plain string. Identify and diagnose call sites updated; their existing 78 tests stay green.
- `createLlmRouter` parser contract widened from `T | null` to `ParseResult<T> | null` where `ParseResult<T> = {kind: 'ok', value} | {kind: 'final', value}`. `null` still escalates (parse fail), `ok` is confidence-gated as before, `final` is terminal — bypasses both the confidence gate and the paid-escalation budget gate. Identify and diagnose parsers wrapped via an `asOk()` adapter so their `T | null` test surface is unchanged. The `WithConfidence` generic constraint dropped in favor of a defensive runtime `readConfidence(value)` that returns 0 (escalates) on a malformed `ok` parse rather than silently passing it through.
- `routes/_consultRequest.ts` is the JSON-body counterpart to `routes/_imageUpload.ts` — same `{ok, request | response}` return shape, same defense-in-depth ordering (device-id check before body read, length cap before trim, strict per-field validation). Two helpers in `routes/` is fine; an `_validation/` subdirectory waits until E1-004 makes it three.

### Deferred (post-V1)
- Anti-injection delimiter framing around the user note in the system prompt (e.g. `<user_note>...</user_note>` wrapping). Parser provides the structural backstop today; harden the prompt itself when E1-005 eval fixtures show measurable injection success.
- `ConsultRejection`'s in-process `source` and `latency_ms` fields drop on the wire (the `ApiResult.rejected_off_topic` variant doesn't carry them). Revisit when E8 mobile surfaces a need for either field on rejections.

## [0.1.2.0] - 2026-05-03

E1-002 — second of four LLM proxy endpoints. The backend can now diagnose a sick plant from a photo: mobile POSTs an image, backend asks a free vision model first, escalates to a paid model only when the free model can't answer confidently. Same tiered router as identify, different system prompt + response shape. Not yet wired to mobile (E5 will consume it).

### Added
- `POST /api/diagnose` on the Cloudflare Worker. Same multipart contract as `/api/identify` (image file + `X-Device-Id` header, MIME + magic-byte validation, 8MB ceiling). Returns `ApiResult<DiagnoseResponse>` with disease + confidence + severity + fix steps + alternatives + which model answered.
- `DiagnoseResponse` shape: `{disease_slug, disease_label, confidence, severity, fix_steps[], alternatives[], source, latency_ms}`. Healthy convention: `disease_slug='healthy'`, severity `'low'`, empty fix_steps. Cannot-tell convention: `disease_slug='unknown'` with confidence below 30.
- `parseDiagnose` with tolerant severity normalization — synonym map (`severe`→`high`, `moderate`→`medium`, `mild`→`low`) and ASCII-letter-run extraction so prose tails like `"high — likely fatal"` still match. Defaults to `'medium'` (not `'low'`) on garbage so serious diagnoses can't be silently downgraded. Cap of 8 fix_steps and 5 alternatives, each with early-exit and per-entry validation against hostile model output.
- 48 backend tests across diagnose router boundaries, parser edge cases (severity drift, fix_steps cap, malformed alternatives), and HTTP-level multipart validation. Total backend tests: 78.

### Changed
- `router.ts` refactored to a generic `createLlmRouter<T extends {confidence:number}>` factory. Both `identifyRouter` and `diagnoseRouter` are built on it; the abort/escalation/fallback state machine lives in one place. Behavior preserved for identify (existing 16 router tests stay green).
- `routes/identify.ts` and `routes/diagnose.ts` share a `parseImageUpload(c)` helper covering multipart parse, MIME allowlist, 8MB ceiling, magic-byte sniff, base64 conversion. Security-critical validation now lives in one file.
- `OPENROUTER_API_KEY` check now runs before multipart body read on both routes — a misconfigured Worker no longer burns memory parsing 8MB uploads it would immediately reject.

### Deferred (post-V1)
- **PV1-001** in WORKBACK.md: server-side cheap-model verifier to normalize/sanity-check `/api/diagnose` output. V1 handles severity drift via deterministic string normalization; verifier earns its keep only if the eval suite (E5-002) shows free-tier accuracy below 70% on fixtures.

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
