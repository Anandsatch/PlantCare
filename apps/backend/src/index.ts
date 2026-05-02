import { Hono } from 'hono';
import type { HonoEnv } from './env';
import { identifyRoute } from './routes/identify';

const app = new Hono<HonoEnv>();

app.get('/', (c) =>
  c.json({ ok: true, service: 'plantcare-api', version: '0.0.0' }),
);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/api/identify', identifyRoute);

// Endpoints land in:
//   E1 — POST /api/identify   ✓
//   E1 — POST /api/diagnose
//   E1 — POST /api/consult
//   E1 — POST /api/review

export default app;
