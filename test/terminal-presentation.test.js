import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizedTerminalStyleRuns,
  terminalDiffLines,
  terminalMarkdownBlocks,
  terminalMarkdownInline,
  terminalPresentationSlices
} from '../public/terminal-presentation.js';

test('normalizes only ordered in-bounds terminal style runs', () => {
  const content = 'plain styled text';
  assert.deepEqual(normalizedTerminalStyleRuns(content, [{
    start: 6,
    end: 12,
    fg: '#ABCDEF',
    bg: '#010203',
    bold: true,
    dim: 1,
    italic: true,
    underline: true,
    inverse: true
  }]), [{
    start: 6,
    end: 12,
    fg: '#abcdef',
    bg: '#010203',
    bold: true,
    dim: false,
    italic: true,
    underline: true,
    inverse: true
  }]);

  for (const invalid of [
    null,
    [{ start: -1, end: 2 }],
    [{ start: 2, end: 2 }],
    [{ start: 0.5, end: 2 }],
    [{ start: 0, end: 100 }],
    [{ start: 0, end: 2, fg: 'red' }],
    [{ start: 0, end: 3 }, { start: 2, end: 4 }]
  ]) assert.deepEqual(normalizedTerminalStyleRuns(content, invalid), []);

  assert.deepEqual(normalizedTerminalStyleRuns('x', Array.from({ length: 12_001 }, () => ({}))), []);
});

test('combines ANSI styles and find matches without turning text into markup', () => {
  const slices = terminalPresentationSlices(
    '<b>red blue</b>',
    [{ start: 3, end: 11, fg: '#cd3131', bold: true }],
    [7],
    4,
    0
  );
  assert.equal(slices.map((slice) => slice.text).join(''), '<b>red blue</b>');
  assert.equal(slices.find((slice) => slice.text === 'blue').current, true);
  assert.equal(slices.find((slice) => slice.text === 'blue').style.fg, '#cd3131');
  assert.equal(slices.find((slice) => slice.text === '<b>').style, null);
  assert.deepEqual(terminalPresentationSlices('plain', [], 'bad', -1), [{
    text: 'plain', style: null, matchIndex: -1, current: false
  }]);
  assert.equal(
    terminalPresentationSlices('plain', [], [Number.NaN, 1], 2, 0).some((slice) => slice.current && slice.text === 'la'),
    true
  );
});

test('parses a bounded Markdown presentation model while leaving HTML inert', () => {
  const blocks = terminalMarkdownBlocks([
    '# Result **ready**',
    '',
    '<script>alert(1)</script> with `code`, *care*, [safe](https://example.com/a), and [bad](javascript:alert(1))',
    '',
    '> quoted',
    '> second',
    '',
    '- first',
    '- second',
    '',
    '1. one',
    '2. two',
    '',
    '| Name | State |',
    '| --- | :---: |',
    '| Cribbage | live |',
    '',
    '---',
    '',
    '```diff',
    '+added',
    '-removed',
    '```'
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'paragraph', 'blockquote', 'list', 'list', 'table', 'rule', 'code'
  ]);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].content.some((token) => token.type === 'strong' && token.text === 'ready'), true);
  assert.equal(blocks[1].content[0].text.startsWith('<script>'), true);
  assert.equal(blocks[1].content.some((token) => token.type === 'code'), true);
  assert.equal(blocks[1].content.some((token) => token.type === 'emphasis'), true);
  assert.deepEqual(blocks[1].content.find((token) => token.type === 'link'), {
    type: 'link', text: 'safe', href: 'https://example.com/a'
  });
  assert.equal(blocks[1].content.some((token) => token.href?.startsWith('javascript:')), false);
  assert.equal(blocks[2].content.some((token) => token.text.includes('quoted\nsecond')), true);
  assert.equal(blocks[3].ordered, false);
  assert.equal(blocks[4].ordered, true);
  assert.equal(blocks[5].header.length, 2);
  assert.equal(blocks[5].rows[0][0][0].text, 'Cribbage');
  assert.equal(blocks[7].language, 'diff');
  assert.equal(blocks[7].text, '+added\n-removed');
});

test('handles unfinished fences, malformed tables, controls, and safe link limits', () => {
  const unfinished = terminalMarkdownBlocks('```js\nconst x = 1;\u0000');
  assert.deepEqual(unfinished, [{ type: 'code', language: 'js', text: 'const x = 1;' }]);

  const malformedTable = terminalMarkdownBlocks('| one | two |\n| --- | nope |');
  assert.equal(malformedTable[0].type, 'paragraph');

  const credentialUrl = ['https://user', 'pass@example.com'].join(':');
  const links = terminalMarkdownInline([
    `[credentials](${credentialUrl})`,
    '[ftp](ftp://example.com)',
    `[long](https://example.com/${'x'.repeat(2100)})`
  ].join(' '));
  assert.equal(links.some((token) => token.type === 'link'), false);
});

test('classifies diff lines without confusing file markers for edits', () => {
  assert.deepEqual(terminalDiffLines([
    'diff --git a/a b/a',
    'index 123..456',
    '--- a/a',
    '+++ b/a',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    ' same'
  ].join('\n')).map((line) => line.kind), [
    'meta', 'meta', 'meta', 'meta', 'hunk', 'remove', 'add', 'context'
  ]);
});
