// Worker bindings. Secrets set via `wrangler secret put OPENROUTER_API_KEY`.
export type Env = {
  OPENROUTER_API_KEY: string;
  // E6-001 — KV cache for Open-Meteo wrapper (1-hour TTL keyed on lat/lon).
  // Bound in wrangler.toml; consumed by `src/lib/openMeteo.ts`.
  WEATHER_CACHE: KVNamespace;
};

// Hono context type — pass to `new Hono<HonoEnv>()` so c.env is typed.
export type HonoEnv = { Bindings: Env };
