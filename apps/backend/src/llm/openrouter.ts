// Thin OpenRouter client. Two entry points: callFree (Llama 3.2 11B Vision,
// free tier) and callPaid (Claude 3.5 Sonnet vision). Each wraps the same
// chat-completions HTTP call with model + timeout differences.
//
// E1-003 widened the call surface to a discriminated union: vision callers
// (identify, diagnose) pass an imageDataUrl; text callers (consult, review)
// pass a userMessage. The wire shape switches on `kind` — vision builds a
// content array with image_url, text passes the prompt as a plain string.
//
// Why not stream: every endpoint is single-shot JSON; streaming adds a parse
// buffer for no UX win.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const FREE_MODEL = 'meta-llama/llama-3.2-11b-vision-instruct:free';
export const PAID_MODEL = 'anthropic/claude-3.5-sonnet';

const FREE_TIMEOUT_MS = 12_000;
const PAID_TIMEOUT_MS = 25_000;

export type CallResult =
  | { ok: true; content: string; latency_ms: number }
  | {
      ok: false;
      reason: 'timeout' | 'http_error' | 'empty' | 'aborted';
      status?: number;
      latency_ms: number;
    };

type CallArgsCommon = {
  apiKey: string;
  systemPrompt: string;
  fetchImpl?: typeof fetch; // injection seam for tests
  signal?: AbortSignal;
};

export type CallArgs =
  | (CallArgsCommon & { kind: 'vision'; imageDataUrl: string })
  | (CallArgsCommon & { kind: 'text'; userMessage: string });

export function callFree(args: CallArgs): Promise<CallResult> {
  return callOpenRouter(args, FREE_MODEL, FREE_TIMEOUT_MS);
}

export function callPaid(args: CallArgs): Promise<CallResult> {
  return callOpenRouter(args, PAID_MODEL, PAID_TIMEOUT_MS);
}

async function callOpenRouter(
  args: CallArgs,
  model: string,
  timeoutMs: number,
): Promise<CallResult> {
  // Caller already abandoned us — don't even open the socket.
  if (args.signal?.aborted) {
    return { ok: false, reason: 'aborted', latency_ms: 0 };
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (args.signal) {
    args.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: buildUserContent(args) },
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
      // Distinguish caller-initiated abort from our own timeout — the router
      // uses 'aborted' to skip escalation (caller is gone, paid call would
      // burn budget for nothing).
      const reason = args.signal?.aborted ? 'aborted' : 'timeout';
      return { ok: false, reason, latency_ms };
    }
    return { ok: false, reason: 'http_error', latency_ms };
  } finally {
    clearTimeout(timer);
    // Always remove the listener; { once: true } self-removes ONLY if it
    // fired, so on the success path it would otherwise stay on the caller
    // signal forever.
    args.signal?.removeEventListener('abort', onCallerAbort);
  }
}

// Vision: OpenRouter expects content as an array with at least one image_url
// part. Text: a plain string is the canonical form and is what every text
// model expects.
function buildUserContent(args: CallArgs): string | Array<{ type: 'image_url'; image_url: { url: string } }> {
  if (args.kind === 'vision') {
    return [{ type: 'image_url', image_url: { url: args.imageDataUrl } }];
  }
  return args.userMessage;
}
