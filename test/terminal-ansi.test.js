import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTerminalAnsi } from '../terminal-ansi.js';

test('parses safe SGR text into exact UTF-16 style offsets', () => {
  const parsed = parseTerminalAnsi([
    '\u001b[1;31mBold\u001b[22;39m plain ',
    '\u001b[4;38;5;33munder\u001b[0m ',
    '\u001b[3;48;2;1;2;3;38;2;250;128;0mcolor\u001b[23;49;39m'
  ].join(''));

  assert.equal(parsed.text, 'Bold plain under color');
  assert.equal(parsed.styleStatus, 'styled');
  assert.deepEqual(parsed.styleRuns, [
    {
      start: 0,
      end: 4,
      fg: '#cd3131',
      bg: '',
      bold: true,
      dim: false,
      italic: false,
      underline: false,
      inverse: false
    },
    {
      start: 11,
      end: 16,
      fg: '#0087ff',
      bg: '',
      bold: false,
      dim: false,
      italic: false,
      underline: true,
      inverse: false
    },
    {
      start: 17,
      end: 22,
      fg: '#fa8000',
      bg: '#010203',
      bold: false,
      dim: false,
      italic: true,
      underline: false,
      inverse: false
    }
  ]);
});

test('supports standard, bright, grayscale, dim, inverse, and reset controls', () => {
  const parsed = parseTerminalAnsi(
    '\u001b[2;7;44;97mA\u001b[27;49;39mB\u001b[38;5;232mC\u001b[38;5;255mD\u001b[mE'
  );

  assert.equal(parsed.text, 'ABCDE');
  assert.deepEqual(parsed.styleRuns, [
    {
      start: 0,
      end: 1,
      fg: '#ffffff',
      bg: '#2472c8',
      bold: false,
      dim: true,
      italic: false,
      underline: false,
      inverse: true
    },
    {
      start: 1,
      end: 2,
      fg: '',
      bg: '',
      bold: false,
      dim: true,
      italic: false,
      underline: false,
      inverse: false
    },
    {
      start: 2,
      end: 3,
      fg: '#080808',
      bg: '',
      bold: false,
      dim: true,
      italic: false,
      underline: false,
      inverse: false
    },
    {
      start: 3,
      end: 4,
      fg: '#eeeeee',
      bg: '',
      bold: false,
      dim: true,
      italic: false,
      underline: false,
      inverse: false
    }
  ]);
});

test('strips every non-presentation control sequence and unsafe C0 or C1 byte', () => {
  const parsed = parseTerminalAnsi(
    'one\r\ntwo\rthree\t\u0001'
      + '\u001b]0;private title\u0007four'
      + '\u001bPprivate dcs\u001b\\five'
      + '\u001b[2Jsix\u001b7seven'
      + '\u009dprivate c1 osc\u009cnine'
      + '\u0090private c1 dcs\u0007ten\u0085'
      + '\u009b32meight\u009b0m'
  );

  assert.equal(parsed.text, 'one\ntwo\nthree\tfourfivesixsevennineteneight');
  assert.equal(parsed.styleRuns.at(-1).fg, '#0dbc79');
  assert.equal(parsed.text.includes('private'), false);
  assert.match(parsed.text, /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);
});

test('fails closed to unstyled text for malformed color and run overflow', () => {
  const malformed = parseTerminalAnsi('\u001b[31mred\u001b[38;2;999;0;0mbad\u001b[0m plain');
  assert.equal(malformed.text, 'redbad plain');
  assert.equal(malformed.styleStatus, 'plain-fallback');
  assert.deepEqual(malformed.styleRuns, []);

  const limited = parseTerminalAnsi('\u001b[31mred\u001b[0m', { maximumStyleRuns: 0 });
  assert.equal(limited.text, 'red');
  assert.equal(limited.styleStatus, 'style-limit');
  assert.deepEqual(limited.styleRuns, []);
});

test('handles unsupported SGR values and incomplete escapes without leaking bytes', () => {
  const ignored = parseTerminalAnsi('\u001b[5;21;100mvisible\u001b[24;107mbright');
  assert.equal(ignored.text, 'visiblebright');
  assert.equal(ignored.styleStatus, 'styled');
  assert.equal(ignored.styleRuns[0].underline, true);
  assert.equal(ignored.styleRuns[0].bg, '#666666');
  assert.equal(ignored.styleRuns[1].underline, false);
  assert.equal(ignored.styleRuns[1].bg, '#ffffff');

  const badIndexed = parseTerminalAnsi('ok\u001b[48;5;256mstill text');
  assert.equal(badIndexed.text, 'okstill text');
  assert.equal(badIndexed.styleStatus, 'plain-fallback');

  const incompleteCsi = parseTerminalAnsi('before\u001b[38;2');
  assert.deepEqual(incompleteCsi, { text: 'before', styleRuns: [], styleStatus: 'plain-fallback' });
  const incompleteOsc = parseTerminalAnsi('before\u001b]title');
  assert.deepEqual(incompleteOsc, { text: 'before', styleRuns: [], styleStatus: 'plain-fallback' });
  const incompleteC1Osc = parseTerminalAnsi('before\u009dtitle');
  assert.deepEqual(incompleteC1Osc, { text: 'before', styleRuns: [], styleStatus: 'plain-fallback' });
});

test('uses bounded defaults for invalid parser options and merges identical adjacent styles', () => {
  const parsed = parseTerminalAnsi('\u001b[31mone\u001b[31mtwo', { maximumStyleRuns: -1 });
  assert.equal(parsed.text, 'onetwo');
  assert.equal(parsed.styleRuns.length, 1);
  assert.deepEqual(parseTerminalAnsi(null), { text: '', styleRuns: [], styleStatus: 'styled' });
});
