const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_STYLE_RUNS = 12_000;
const MAX_LINK_LENGTH = 2048;

function normalizedColor(value) {
  const color = String(value || '');
  return color && COLOR_PATTERN.test(color) ? color.toLowerCase() : '';
}

function normalizedStyle(value) {
  return {
    fg: normalizedColor(value?.fg),
    bg: normalizedColor(value?.bg),
    bold: value?.bold === true,
    dim: value?.dim === true,
    italic: value?.italic === true,
    underline: value?.underline === true,
    inverse: value?.inverse === true
  };
}

export function normalizedTerminalStyleRuns(content, values) {
  const text = String(content || '');
  if (!Array.isArray(values) || values.length > MAX_STYLE_RUNS) return [];
  const normalized = [];
  let previousEnd = 0;
  for (const value of values) {
    const start = Number(value?.start);
    const end = Number(value?.end);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < previousEnd
      || start < 0
      || end <= start
      || end > text.length
      || (value?.fg && !normalizedColor(value.fg))
      || (value?.bg && !normalizedColor(value.bg))
    ) return [];
    normalized.push({ start, end, ...normalizedStyle(value) });
    previousEnd = end;
  }
  return normalized;
}

export function terminalPresentationSlices(content, styleValues = [], matchOffsets = [], queryLength = 0, currentMatch = -1) {
  const text = String(content || '');
  const styles = normalizedTerminalStyleRuns(text, styleValues);
  const matchLength = Number.isSafeInteger(queryLength) && queryLength > 0 ? queryLength : 0;
  const matches = [];
  if (matchLength) {
    for (const value of Array.isArray(matchOffsets) ? matchOffsets : []) {
      const start = Number(value);
      if (
        !Number.isSafeInteger(start)
        || start < 0
        || start + matchLength > text.length
        || start < (matches.at(-1)?.end || 0)
      ) continue;
      matches.push({ start, end: start + matchLength, index: matches.length });
    }
  }
  const boundaries = new Set([0, text.length]);
  styles.forEach(({ start, end }) => { boundaries.add(start); boundaries.add(end); });
  matches.forEach(({ start, end }) => { boundaries.add(start); boundaries.add(end); });
  const offsets = [...boundaries].sort((left, right) => left - right);
  const slices = [];
  let styleIndex = 0;
  let matchIndex = 0;
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (end <= start) continue;
    while (styleIndex < styles.length && styles[styleIndex].end <= start) styleIndex += 1;
    while (matchIndex < matches.length && matches[matchIndex].end <= start) matchIndex += 1;
    const style = styles[styleIndex]?.start <= start && styles[styleIndex]?.end >= end
      ? normalizedStyle(styles[styleIndex])
      : null;
    const match = matches[matchIndex]?.start <= start && matches[matchIndex]?.end >= end
      ? matches[matchIndex]
      : null;
    slices.push({
      text: text.slice(start, end),
      style,
      matchIndex: match?.index ?? -1,
      current: match?.index === currentMatch
    });
  }
  return slices;
}

function safeHttpUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > MAX_LINK_LENGTH) return '';
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function appendTextToken(tokens, text) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else tokens.push({ type: 'text', text });
}

export function terminalMarkdownInline(value) {
  const text = String(value || '');
  const tokens = [];
  const patterns = [
    { type: 'code', regex: /`([^`\n]+)`/ },
    { type: 'link', regex: /\[([^\]\n]+)\]\(([^)\s]+)\)/ },
    { type: 'strong', regex: /\*\*([^*\n]+)\*\*/ },
    { type: 'emphasis', regex: /\*([^*\n]+)\*/ }
  ];
  let cursor = 0;
  while (cursor < text.length) {
    let selected = null;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text.slice(cursor));
      if (!match) continue;
      const start = cursor + match.index;
      if (!selected || start < selected.start) selected = { pattern, match, start };
    }
    if (!selected) {
      appendTextToken(tokens, text.slice(cursor));
      break;
    }
    appendTextToken(tokens, text.slice(cursor, selected.start));
    const [raw, first, second] = selected.match;
    if (selected.pattern.type === 'link') {
      const href = safeHttpUrl(second);
      if (href) tokens.push({ type: 'link', text: first, href });
      else appendTextToken(tokens, raw);
    } else {
      tokens.push({ type: selected.pattern.type, text: first });
    }
    cursor = selected.start + raw.length;
  }
  return tokens;
}

function tableCells(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function tableDelimiter(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function blockStart(lines, index) {
  const line = lines[index] || '';
  return !line.trim()
    || /^\s*```/.test(line)
    || /^#{1,4}\s+/.test(line)
    || /^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+\.)\s+/.test(line)
    || (line.includes('|') && tableDelimiter(lines[index + 1] || ''));
}

export function terminalMarkdownBlocks(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const lines = text.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([A-Za-z0-9_-]{0,24})\s*$/);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1].toLowerCase() || 'text', text: content.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, content: terminalMarkdownInline(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', content: terminalMarkdownInline(quoted.join('\n')) });
      continue;
    }
    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]) !== ordered) break;
        items.push(terminalMarkdownInline(item[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (line.includes('|') && tableDelimiter(lines[index + 1] || '')) {
      const header = tableCells(line).map(terminalMarkdownInline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const cells = tableCells(lines[index]);
        if (cells.length !== header.length) break;
        rows.push(cells.map(terminalMarkdownInline));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !blockStart(lines, index)) paragraph.push(lines[index++]);
    blocks.push({ type: 'paragraph', content: terminalMarkdownInline(paragraph.join('\n')) });
  }
  return blocks;
}

export function terminalDiffLines(value) {
  return String(value || '').split('\n').map((text) => ({
    text,
    kind: text.startsWith('@@')
      ? 'hunk'
      : text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')
        ? 'meta'
        : text.startsWith('+')
          ? 'add'
          : text.startsWith('-')
            ? 'remove'
            : 'context'
  }));
}
