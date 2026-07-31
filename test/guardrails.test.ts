import { describe, expect, it } from 'vitest';
import {
  containsUrl,
  costFor,
  countCodepoints,
  normalizeText,
  validateText,
  MAX_POST_CODEPOINTS,
} from '../worker/lib/guardrails.ts';
import { synthesizeIdemKey } from '../worker/lib/idempotency.ts';
import { COST_PER_POST_USD, COST_PER_POST_WITH_URL_USD } from '../worker/lib/xclient.ts';

describe('containsUrl', () => {
  // A false positive costs one explicit allowUrl:true. A false negative costs $0.185.
  it('detects things X would bill at the URL rate', () => {
    for (const t of [
      'see https://example.com',
      'see http://example.com/path?a=1',
      'visit www.example.com',
      'read surfaced.dev for more',
      'we launched at hellominds.ai today',
      'check foo.io/bar',
    ]) {
      expect(containsUrl(t), t).toBe(true);
    }
  });

  it('does not fire on ordinary prose', () => {
    for (const t of [
      'agents are changing how discovery works',
      'I think, therefore I am. Probably.',
      'version 2.5 shipped',
      'e.g. this sentence, i.e. no links',
      'ratio was 3.14 to 1',
    ]) {
      expect(containsUrl(t), t).toBe(false);
    }
  });
});

describe('costFor', () => {
  it('reflects the 13x URL cliff', () => {
    expect(costFor(false)).toBe(COST_PER_POST_USD);
    expect(costFor(true)).toBe(COST_PER_POST_WITH_URL_USD);
    expect(costFor(true) / costFor(false)).toBeGreaterThan(13);
  });
});

describe('countCodepoints', () => {
  it('counts emoji and astral characters as single codepoints', () => {
    expect(countCodepoints('abc')).toBe(3);
    expect(countCodepoints('🚀')).toBe(1); // 2 UTF-16 units, 1 codepoint
    expect(countCodepoints('a🚀b')).toBe(3);
  });
});

describe('validateText', () => {
  it('accepts a clean post', () => {
    expect(() => validateText('hello world', false, false)).not.toThrow();
  });

  it('rejects empty and whitespace-only text', () => {
    expect(() => validateText('', false, false)).toThrow(/empty/);
    expect(() => validateText('   \n ', false, false)).toThrow(/empty/);
  });

  it('rejects text over the limit but accepts text at the limit', () => {
    expect(() => validateText('x'.repeat(MAX_POST_CODEPOINTS), false, false)).not.toThrow();
    expect(() => validateText('x'.repeat(MAX_POST_CODEPOINTS + 1), false, false)).toThrow(
      /280/,
    );
  });

  it('requires allowUrl for link posts', () => {
    expect(() => validateText('see https://a.com', true, false)).toThrow(/allowUrl/);
    expect(() => validateText('see https://a.com', true, true)).not.toThrow();
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and case so trivial edits do not defeat dedupe', () => {
    expect(normalizeText('  Hello   World  ')).toBe('hello world');
    expect(normalizeText('Hello\nWorld')).toBe(normalizeText('hello world'));
  });
});

describe('synthesizeIdemKey', () => {
  it('collapses identical text from the same user in the same window', async () => {
    const a = await synthesizeIdemKey('adam', 'same text');
    const b = await synthesizeIdemKey('adam', 'same  text  ');
    expect(a).toBe(b);
    expect(a).toMatch(/^auto_[0-9a-f]{32}$/);
  });

  it('separates different users and different text', async () => {
    expect(await synthesizeIdemKey('adam', 't')).not.toBe(await synthesizeIdemKey('beth', 't'));
    expect(await synthesizeIdemKey('adam', 't1')).not.toBe(await synthesizeIdemKey('adam', 't2'));
  });
});
