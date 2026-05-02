// Worker bindings. Secrets set via `wrangler secret put OPENROUTER_API_KEY`.
export type Env = {
  OPENROUTER_API_KEY: string;
};

// Hono context type — pass to `new Hono<HonoEnv>()` so c.env is typed.
export type HonoEnv = { Bindings: Env };
