import { Hono } from 'hono';

type Bindings = {
  OPENROUTER_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) =>
  c.json({ ok: true, service: 'plantcare-api', version: '0.0.0' }),
);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// Endpoints land in:
//   E1 — POST /api/identify
//   E5 — POST /api/diagnose
//   E8 — POST /api/consult
//   E9 — POST /api/review

export default app;
