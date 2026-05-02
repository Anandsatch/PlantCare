// Tolerant JSON parser for LLM output. Free-tier models often wrap JSON in
// ```json fences, prepend "Here is the result:", or emit trailing commas.
// We try strict parse first, then progressive cleanup, then bail.
export function safeJsonParse<T = unknown>(raw: string): T | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Strict
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;

  // 2. Strip ```json … ``` or ``` … ``` fences (with or without language tag)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    const fenced = tryParse<T>(fenceMatch[1].trim());
    if (fenced !== null) return fenced;
  }

  // 3. Extract the first balanced {...} block (handles leading prose)
  const block = extractFirstObject(trimmed);
  if (block) {
    const parsed = tryParse<T>(block);
    if (parsed !== null) return parsed;
    // 4. Last-ditch: strip trailing commas inside the block
    const cleaned = block.replace(/,(\s*[}\]])/g, '$1');
    const recovered = tryParse<T>(cleaned);
    if (recovered !== null) return recovered;
  }

  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// Walk the string, return the substring of the first balanced {...} block,
// respecting string literals so braces inside strings don't confuse the count.
function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
