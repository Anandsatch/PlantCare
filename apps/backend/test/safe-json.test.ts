import { describe, expect, it } from 'vitest';
import { safeJsonParse } from '../src/llm/safe-json';

describe('safeJsonParse', () => {
  it('parses strict JSON', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"species_slug":"monstera_deliciosa","confidence":92}\n```';
    expect(safeJsonParse(raw)).toEqual({ species_slug: 'monstera_deliciosa', confidence: 92 });
  });

  it('strips bare ``` fences without language tag', () => {
    expect(safeJsonParse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON from leading prose', () => {
    const raw = 'Here is the result:\n{"species_slug":"ficus_lyrata","confidence":81}';
    expect(safeJsonParse(raw)).toEqual({ species_slug: 'ficus_lyrata', confidence: 81 });
  });

  it('strips trailing commas inside the block', () => {
    expect(safeJsonParse('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('handles nested objects with braces in string literals', () => {
    const raw = '{"name":"Steve {the plant}","slug":"monstera"}';
    expect(safeJsonParse(raw)).toEqual({ name: 'Steve {the plant}', slug: 'monstera' });
  });

  it('returns null on empty input', () => {
    expect(safeJsonParse('')).toBeNull();
    expect(safeJsonParse('   ')).toBeNull();
  });

  it('returns null on garbage with no JSON object', () => {
    expect(safeJsonParse('I cannot identify this plant.')).toBeNull();
  });

  it('returns null on truncated JSON', () => {
    expect(safeJsonParse('{"species_slug":"monstera",')).toBeNull();
  });

  it('returns null on non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(safeJsonParse(null)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(safeJsonParse(123)).toBeNull();
  });
});
