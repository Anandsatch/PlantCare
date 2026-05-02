import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// vitest config for the Hono Cloudflare Worker.
// Uses the workers pool so tests run inside a workerd-like environment with
// fetch/Request/Response, KV, R2, etc. wired up. `wrangler` config is read so
// bindings (KV namespaces, secrets) match production. Compat date pinned to
// the same value as wrangler.toml.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // OPENROUTER_API_KEY is a production secret; provide a dummy in tests
          // so route handlers don't 500 with 'service_unconfigured'. Tests
          // intercept fetch via cloudflare:test fetchMock so this never goes
          // over the wire.
          bindings: {
            OPENROUTER_API_KEY: 'test-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        },
      },
    },
  },
});
