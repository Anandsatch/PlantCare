// Thin OpenRouter client. Two entry points: callFree (Llama 3.2 11B Vision,
// free tier) and callPaid (Claude 3.5 Sonnet vision). Each wraps the same
// chat-completions HTTP call with model + timeout differences.
//
// Why not stream: identify is single-shot JSON; streaming adds a parse buffer
// for no UX win.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const FREE_MODEL = 'meta-llama/llama-3.2-11b-vision-instruct:free';
export const PAID_MODEL = 'anthropic/claude-3.5-sonnet';

const FREE_TIMEOUT_MS = 12_000;
const PAID_TIMEOUT_MS = 25_000;

export type CallResult =
  | { ok: true; content: string; latency_ms: number }
  | { ok: false; reason: 'timeout' | 'http_error' | 'empty'; status?: number; latency_ms: number };

type CallArgs = {
  apiKey: string;
  systemPrompt: string;
  imageDataUrl: string; // data: URL or https: URL accepted by OpenRouter vision
  fetchImpl?: typeof fetch; // injection seam for tests
  signal?: AbortSignal;
};

export function callFree(args: CallArgs): Promise<CallResult> {
  return callOpenRouter({ ...args, model: FREE_MODEL, timeoutMs: FREE_TIMEOUT_MS });
}

export function callPaid(args: CallArgs): Promise<CallResult> {
  return callOpenRouter({ ...args, model: PAID_MODEL, timeoutMs: PAID_TIMEOUT_MS });
}

async function callOpenRouter(
  args: CallArgs & { model: string; timeoutMs: number },
): Promise<CallResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  if (args.signal) {
    args.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: 'system', content: args.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: args.imageDataUrl } },
            ],
          },
        ],
        // OpenRouter accepts response_format hint; free models often ignore it,
        // which is why we still need safeJsonParse downstream.
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return { ok: false, reason: 'http_error', status: res.status, latency_ms };
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return { ok: false, reason: 'empty', latency_ms };
    return { ok: true, content, latency_ms };
  } catch (e) {
    const latency_ms = Date.now() - start;
    if ((e as Error).name === 'AbortError') {
      return { ok: false, reason: 'timeout', latency_ms };
    }
    return { ok: false, reason: 'http_error', latency_ms };
  } finally {
    clearTimeout(timer);
  }
}
