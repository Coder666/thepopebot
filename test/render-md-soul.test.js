/**
 * Tests for {{soul}} variable support in lib/utils/render-md.js.
 *
 * render_md(filePath, chain, extraVars) accepts an optional extraVars object.
 * When extraVars.soul is set, {{soul}} placeholders are replaced with that value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { render_md } = await import('../lib/utils/render-md.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write content to a temp file, call fn(filePath), clean up.
 * @param {string} content
 * @param {(file: string) => any} fn
 */
function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pope-render-md-'));
  const file = path.join(dir, 'test.md');
  fs.writeFileSync(file, content, 'utf8');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── {{soul}} basic resolution ────────────────────────────────────────────────

test('{{soul}} is replaced with extraVars.soul', () => {
  withTempFile('Hello {{soul}}!', (file) => {
    assert.equal(render_md(file, [], { soul: 'World' }), 'Hello World!');
  });
});

test('{{soul}} resolves to empty string when soul is not in extraVars', () => {
  withTempFile('A{{soul}}B', (file) => {
    assert.equal(render_md(file, [], {}), 'AB');
  });
});

test('{{soul}} resolves to empty string when extraVars is omitted entirely', () => {
  withTempFile('{{soul}}', (file) => {
    assert.equal(render_md(file), '');
  });
});

test('{{soul}} resolves to empty string when soul is undefined in extraVars', () => {
  withTempFile('{{soul}}', (file) => {
    assert.equal(render_md(file, [], { soul: undefined }), '');
  });
});

// ─── case insensitivity ───────────────────────────────────────────────────────

test('{{SOUL}} uppercase is resolved', () => {
  withTempFile('{{SOUL}}', (file) => {
    assert.equal(render_md(file, [], { soul: 'X' }), 'X');
  });
});

test('{{Soul}} mixed case is resolved', () => {
  withTempFile('{{Soul}}', (file) => {
    assert.equal(render_md(file, [], { soul: 'X' }), 'X');
  });
});

test('all case variants resolve to the same value', () => {
  withTempFile('{{soul}}-{{SOUL}}-{{Soul}}', (file) => {
    assert.equal(render_md(file, [], { soul: 'Y' }), 'Y-Y-Y');
  });
});

// ─── multi-line and rich content ──────────────────────────────────────────────

test('multi-line soul content is inserted verbatim', () => {
  const soul = '# Identity\n\nYou are a helpful bot.\n- Trait A\n- Trait B';
  withTempFile('{{soul}}', (file) => {
    assert.equal(render_md(file, [], { soul }), soul);
  });
});

test('soul content with markdown special characters is not escaped', () => {
  const soul = '**bold** _italic_ `code` [link](https://example.com)';
  withTempFile('{{soul}}', (file) => {
    assert.equal(render_md(file, [], { soul }), soul);
  });
});

// ─── co-existence with other variables ───────────────────────────────────────

test('{{datetime}} resolves alongside {{soul}}', () => {
  withTempFile('date={{datetime}} soul={{soul}}', (file) => {
    const result = render_md(file, [], { soul: 'Persona' });
    // datetime is an ISO 8601 timestamp
    assert.match(result, /date=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.ok(result.includes('soul=Persona'), `Expected 'soul=Persona' in: ${result}`);
  });
});

test('{{soul}} and surrounding text are preserved correctly', () => {
  withTempFile('Before\n\n{{soul}}\n\nAfter', (file) => {
    assert.equal(render_md(file, [], { soul: '## Middle' }), 'Before\n\n## Middle\n\nAfter');
  });
});

test('template with no soul placeholder ignores extraVars.soul', () => {
  withTempFile('# No placeholder here', (file) => {
    assert.equal(render_md(file, [], { soul: 'ignored' }), '# No placeholder here');
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────────

test('non-existent file returns empty string regardless of extraVars', () => {
  assert.equal(render_md('/nonexistent/path/missing.md', [], { soul: 'x' }), '');
});

test('empty file returns empty string', () => {
  withTempFile('', (file) => {
    assert.equal(render_md(file, [], { soul: 'x' }), '');
  });
});

test('soul with empty string value replaces placeholder with empty string', () => {
  withTempFile('prefix{{soul}}suffix', (file) => {
    assert.equal(render_md(file, [], { soul: '' }), 'prefixsuffix');
  });
});
