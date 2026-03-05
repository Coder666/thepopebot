import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTokenBudgetEnabled,
  countTokens,
  messageTokenCounter,
  getContextWindow,
  getResponseReserve,
  getMaxToolOutputChars,
  truncate,
  DEFAULTS,
} from '../lib/ai/token-budget.js';

// ---------------------------------------------------------------------------
// Helper: run fn with a specific env var value, then restore original
// ---------------------------------------------------------------------------
function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// ---------------------------------------------------------------------------
// isTokenBudgetEnabled
// ---------------------------------------------------------------------------
test('isTokenBudgetEnabled', async (t) => {
  await t.test('defaults to true when env var is not set', () => {
    withEnv('TOKEN_BUDGET_ENABLED', undefined, () => {
      assert.equal(isTokenBudgetEnabled(), true);
    });
  });

  await t.test('defaults to true when env var is empty string', () => {
    withEnv('TOKEN_BUDGET_ENABLED', '', () => {
      assert.equal(isTokenBudgetEnabled(), true);
    });
  });

  await t.test('returns true for "true"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', 'true', () => {
      assert.equal(isTokenBudgetEnabled(), true);
    });
  });

  await t.test('returns true for "TRUE"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', 'TRUE', () => {
      assert.equal(isTokenBudgetEnabled(), true);
    });
  });

  await t.test('returns true for "1"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', '1', () => {
      assert.equal(isTokenBudgetEnabled(), true);
    });
  });

  await t.test('returns false for "false"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', 'false', () => {
      assert.equal(isTokenBudgetEnabled(), false);
    });
  });

  await t.test('returns false for "FALSE"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', 'FALSE', () => {
      assert.equal(isTokenBudgetEnabled(), false);
    });
  });

  await t.test('returns false for "0"', () => {
    withEnv('TOKEN_BUDGET_ENABLED', '0', () => {
      assert.equal(isTokenBudgetEnabled(), false);
    });
  });
});

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------
test('countTokens', async (t) => {
  await t.test('returns 0 for empty string', () => {
    assert.equal(countTokens(''), 0);
  });

  await t.test('returns 0 for null', () => {
    assert.equal(countTokens(null), 0);
  });

  await t.test('returns 0 for undefined', () => {
    assert.equal(countTokens(undefined), 0);
  });

  await t.test('counts 4 chars as 1 token', () => {
    assert.equal(countTokens('abcd'), 1);
  });

  await t.test('rounds up — 5 chars is 2 tokens', () => {
    assert.equal(countTokens('abcde'), 2);
  });

  await t.test('rounds up — 1 char is 1 token', () => {
    assert.equal(countTokens('a'), 1);
  });

  await t.test('counts 8 chars as exactly 2 tokens', () => {
    assert.equal(countTokens('12345678'), 2);
  });

  await t.test('coerces non-string to string before counting', () => {
    // 1234 → "1234" → 4 chars → 1 token
    assert.equal(countTokens(1234), 1);
  });

  await t.test('handles a typical paragraph', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'; // 44 chars → ceil(44/4) = 11
    assert.equal(countTokens(text), 11);
  });
});

// ---------------------------------------------------------------------------
// messageTokenCounter
// ---------------------------------------------------------------------------
test('messageTokenCounter', async (t) => {
  await t.test('returns 0 for empty array', () => {
    assert.equal(messageTokenCounter([]), 0);
  });

  await t.test('counts a single string-content message', () => {
    // 'hello' = 5 chars → 2 tokens
    const msgs = [{ content: 'hello' }];
    assert.equal(messageTokenCounter(msgs), 2);
  });

  await t.test('sums tokens across multiple messages', () => {
    // 'abcd' = 1 token, '12345678' = 2 tokens → total 3
    const msgs = [{ content: 'abcd' }, { content: '12345678' }];
    assert.equal(messageTokenCounter(msgs), 3);
  });

  await t.test('serialises non-string content to JSON before counting', () => {
    const msgs = [{ content: [{ type: 'text', text: 'hi' }] }];
    const json = JSON.stringify([{ type: 'text', text: 'hi' }]);
    assert.equal(messageTokenCounter(msgs), countTokens(json));
  });

  await t.test('handles mixed string and array content messages', () => {
    const arrayContent = [{ type: 'text', text: 'yo' }];
    const msgs = [
      { content: 'abcd' },
      { content: arrayContent },
    ];
    const expected = countTokens('abcd') + countTokens(JSON.stringify(arrayContent));
    assert.equal(messageTokenCounter(msgs), expected);
  });
});

// ---------------------------------------------------------------------------
// getContextWindow
// ---------------------------------------------------------------------------
test('getContextWindow', async (t) => {
  await t.test('returns default when env var is not set', () => {
    withEnv('CONTEXT_WINDOW', undefined, () => {
      assert.equal(getContextWindow(), DEFAULTS.CONTEXT_WINDOW);
    });
  });

  await t.test('reads CONTEXT_WINDOW env var', () => {
    withEnv('CONTEXT_WINDOW', '4096', () => {
      assert.equal(getContextWindow(), 4096);
    });
  });

  await t.test('returns a number (not a string)', () => {
    withEnv('CONTEXT_WINDOW', '32768', () => {
      assert.equal(typeof getContextWindow(), 'number');
    });
  });
});

// ---------------------------------------------------------------------------
// getResponseReserve
// ---------------------------------------------------------------------------
test('getResponseReserve', async (t) => {
  await t.test('returns default when env var is not set', () => {
    withEnv('RESPONSE_RESERVE', undefined, () => {
      assert.equal(getResponseReserve(), DEFAULTS.RESPONSE_RESERVE);
    });
  });

  await t.test('reads RESPONSE_RESERVE env var', () => {
    withEnv('RESPONSE_RESERVE', '512', () => {
      assert.equal(getResponseReserve(), 512);
    });
  });
});

// ---------------------------------------------------------------------------
// getMaxToolOutputChars
// ---------------------------------------------------------------------------
test('getMaxToolOutputChars', async (t) => {
  await t.test('returns default when env var is not set', () => {
    withEnv('MAX_TOOL_OUTPUT_CHARS', undefined, () => {
      assert.equal(getMaxToolOutputChars(), DEFAULTS.MAX_TOOL_OUTPUT_CHARS);
    });
  });

  await t.test('reads MAX_TOOL_OUTPUT_CHARS env var', () => {
    withEnv('MAX_TOOL_OUTPUT_CHARS', '4000', () => {
      assert.equal(getMaxToolOutputChars(), 4000);
    });
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------
test('truncate', async (t) => {
  await t.test('returns the original string when it is within the limit', () => {
    assert.equal(truncate('hello', 10), 'hello');
  });

  await t.test('returns the original string when length equals the limit exactly', () => {
    assert.equal(truncate('hello', 5), 'hello');
  });

  await t.test('truncates and appends marker when over the limit', () => {
    const result = truncate('hello world', 5);
    assert.equal(result.startsWith('hello'), true);
    assert.match(result, /\[truncated/);
    assert.match(result, /6 more characters not shown\]/);
  });

  await t.test('uses DEFAULTS.MAX_TOOL_OUTPUT_CHARS when no maxChars provided', () => {
    const shortText = 'x'.repeat(10);
    assert.equal(truncate(shortText), shortText);
  });

  await t.test('truncated result starts with the first maxChars characters', () => {
    const text = 'abcdefghij'; // 10 chars
    const result = truncate(text, 4);
    assert.equal(result.startsWith('abcd'), true);
  });

  await t.test('reports the correct number of remaining characters in the marker', () => {
    const text = '1234567890'; // 10 chars
    const result = truncate(text, 3); // cut at 3 → 7 remaining
    assert.match(result, /7 more characters not shown/);
  });

  await t.test('returns empty string unchanged', () => {
    assert.equal(truncate('', 100), '');
  });

  await t.test('returns null/undefined unchanged (falsy passthrough)', () => {
    assert.equal(truncate(null, 10), null);
    assert.equal(truncate(undefined, 10), undefined);
  });
});
