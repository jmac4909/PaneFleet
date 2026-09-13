const STANDARD_COLORS = Object.freeze([
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
]);

const DEFAULT_MAX_STYLE_RUNS = 12_000;

function boundedByte(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 255 ? number : null;
}

function byteHex(value) {
  return value.toString(16).padStart(2, '0');
}

function indexedColor(index) {
  const value = boundedByte(index);
  if (value === null) return null;
  if (value < 16) return STANDARD_COLORS[value];
  if (value < 232) {
    const offset = value - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor((offset % 36) / 6);
    const blue = offset % 6;
    const channel = (part) => part === 0 ? 0 : 55 + part * 40;
    return `#${byteHex(channel(red))}${byteHex(channel(green))}${byteHex(channel(blue))}`;
  }
  const gray = 8 + (value - 232) * 10;
  return `#${byteHex(gray)}${byteHex(gray)}${byteHex(gray)}`;
}

function sameStyle(left, right) {
  return left.fg === right.fg
    && left.bg === right.bg
    && left.bold === right.bold
    && left.dim === right.dim
    && left.italic === right.italic
    && left.underline === right.underline
    && left.inverse === right.inverse;
}

function styleIsDefault(style) {
  return !style.fg
    && !style.bg
    && !style.bold
    && !style.dim
    && !style.italic
    && !style.underline
    && !style.inverse;
}

function freshStyle() {
  return {
    fg: '',
    bg: '',
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false
  };
}

function applyExtendedColor(style, parameters, index, target) {
  const mode = Number(parameters[index + 1]);
  if (mode === 5) {
    const color = indexedColor(parameters[index + 2]);
    if (!color) return { next: index, valid: false };
    style[target] = color;
    return { next: index + 2, valid: true };
  }
  if (mode === 2) {
    const channels = parameters.slice(index + 2, index + 5).map(boundedByte);
    if (channels.length !== 3 || channels.includes(null)) return { next: index, valid: false };
    style[target] = `#${channels.map(byteHex).join('')}`;
    return { next: index + 4, valid: true };
  }
  return { next: index, valid: false };
}

function applySgr(style, rawParameters) {
  const parameters = rawParameters === ''
    ? [0]
    : rawParameters.split(';').map((part) => part === '' ? 0 : Number(part));
  if (parameters.some((value) => !Number.isInteger(value) || value < 0)) return false;

  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index];
    if (code === 0) Object.assign(style, freshStyle());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4 || code === 21) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code >= 30 && code <= 37) style.fg = STANDARD_COLORS[code - 30];
    else if (code >= 40 && code <= 47) style.bg = STANDARD_COLORS[code - 40];
    else if (code >= 90 && code <= 97) style.fg = STANDARD_COLORS[code - 90 + 8];
    else if (code >= 100 && code <= 107) style.bg = STANDARD_COLORS[code - 100 + 8];
    else if (code === 39) style.fg = '';
    else if (code === 49) style.bg = '';
    else if (code === 38 || code === 48) {
      const result = applyExtendedColor(style, parameters, index, code === 38 ? 'fg' : 'bg');
      if (!result.valid) return false;
      index = result.next;
    }
    // Unsupported presentation-only SGR values are ignored. The escape bytes
    // themselves are still removed and never reach the browser.
  }
  return true;
}

function controlSequenceEnd(value, start) {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function stringControlEnd(value, start) {
  for (let index = start; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x07) return index;
    if (value.charCodeAt(index) === 0x9c) return index;
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === '\\') return index + 1;
  }
  return -1;
}

/**
 * Converts tmux `capture-pane -e` output into plain text plus validated style
 * offsets. No terminal control bytes are returned. Unsupported or malformed
 * sequences fail closed to unstyled text while preserving the readable copy.
 */
export function parseTerminalAnsi(input, { maximumStyleRuns = DEFAULT_MAX_STYLE_RUNS } = {}) {
  const value = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const style = freshStyle();
  const styleRuns = [];
  let output = '';
  let runStart = 0;
  let stylesReliable = true;

  const flush = () => {
    if (output.length <= runStart || styleIsDefault(style)) {
      runStart = output.length;
      return;
    }
    const next = { start: runStart, end: output.length, ...style };
    const previous = styleRuns.at(-1);
    if (previous && previous.end === next.start && sameStyle(previous, next)) previous.end = next.end;
    else styleRuns.push(next);
    runStart = output.length;
  };

  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const marker = value[index + 1];
      if (marker === '[') {
        const end = controlSequenceEnd(value, index + 2);
        if (end < 0) {
          stylesReliable = false;
          break;
        }
        if (value[end] === 'm') {
          flush();
          if (!applySgr(style, value.slice(index + 2, end))) stylesReliable = false;
          runStart = output.length;
        }
        index = end + 1;
        continue;
      }
      if (']PX^_'.includes(marker || '')) {
        const end = stringControlEnd(value, index + 2);
        if (end < 0) {
          stylesReliable = false;
          break;
        }
        index = end + 1;
        continue;
      }
      index += Math.min(2, value.length - index);
      continue;
    }
    if (code === 0x9b) {
      const end = controlSequenceEnd(value, index + 1);
      if (end < 0) {
        stylesReliable = false;
        break;
      }
      if (value[end] === 'm') {
        flush();
        if (!applySgr(style, value.slice(index + 1, end))) stylesReliable = false;
        runStart = output.length;
      }
      index = end + 1;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      const end = stringControlEnd(value, index + 1);
      if (end < 0) {
        stylesReliable = false;
        break;
      }
      index = end + 1;
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if (code === 0x0a || code === 0x09) output += value[index];
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  flush();

  const maximumRuns = Number.isSafeInteger(maximumStyleRuns) && maximumStyleRuns >= 0
    ? maximumStyleRuns
    : DEFAULT_MAX_STYLE_RUNS;
  const withinLimit = styleRuns.length <= maximumRuns;
  return {
    text: output,
    styleRuns: stylesReliable && withinLimit ? styleRuns : [],
    styleStatus: stylesReliable ? (withinLimit ? 'styled' : 'style-limit') : 'plain-fallback'
  };
}
