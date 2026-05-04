import { defineConfig } from 'vitest/config';

// Eval harness config. Evals exercise the parser + router state machine
// driven by canned OpenRouter responses (mock mode) or — when
// EVAL_REAL_API=1 — real OpenRouter calls. Neither path needs workerd, so
// we run under the default Node pool: faster startup, simpler tracebacks,
// and no miniflare bindings to worry about.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    // Real-API mode hits OpenRouter; raise the timeout to allow free-tier
    // latency (cold paths can take 8-12s) plus an escalation. Mock mode
    // ignores this — every call resolves synchronously.
    testTimeout: 60_000,
  },
});
