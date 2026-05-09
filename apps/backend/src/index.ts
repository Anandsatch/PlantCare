import { Hono } from 'hono';
import type { HonoEnv } from './env';
import { identifyRoute } from './routes/identify';
import { diagnoseRoute } from './routes/diagnose';
import { consultRoute } from './routes/consult';
import { reviewRoute } from './routes/review';
import { weatherRoute } from './routes/weather';

const app = new Hono<HonoEnv>();

app.get('/', (c) =>
  c.json({ ok: true, service: 'plantcare-api', version: '0.0.0' }),
);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/api/identify', identifyRoute);
app.route('/api/diagnose', diagnoseRoute);
app.route('/api/consult', consultRoute);
app.route('/api/review', reviewRoute);
app.route('/api/weather', weatherRoute);

// Endpoints land in:
//   E1 — POST /api/identify   ✓
//   E1 — POST /api/diagnose   ✓
//   E1 — POST /api/consult    ✓
//   E1 — POST /api/review     ✓
//   E6 — GET  /api/weather    ✓

export default app;
