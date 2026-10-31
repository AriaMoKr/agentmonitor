// Keys from a terminal in raw mode: the escape sequences that arrows, Home, Page Up and the like
// send, made names; and the mouse's clicks and wheel, which a terminal reports the same way once
// asked to. Windows consoles send the same sequences to Node in raw mode, their VT input.

/**
 * @typedef {{ name: string, ch?: string, ctrl?: boolean, mouse?: Mouse }} Key
 *   name: 'up', 'enter', 'escape'... or the character typed, or 'mouse'; ch: the character typed
 * @typedef {{ button: 'left' | 'middle' | 'right' | 'wheelup' | 'wheeldown' | 'other', x: number,
 *   y: number, release: boolean, motion: boolean, double?: boolean }} Mouse x and y: the cell, from
 *   0 at the top left; double: the second click of a double click, as a browser tells it (a
 *   terminal does not)
 */

/** @type {Record<string, string>} */
const SEQUENCES = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[3~': 'delete', '\x1b[2~': 'insert',
  '\x1b[Z': 'backtab',
};

/**
 * The keys in one read from the terminal.
 * @param {string} data
 * @returns {Key[]}
 */
export function parseKeys(data) {
  /** @type {Key[]} */
  const keys = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (c === '\x1b') {
      const next = data[i + 1];
      if (next === '[') {
        // A mouse report in the old form: ESC [ M and three characters, each a number plus 32.
        if (data[i + 2] === 'M' && i + 5 < data.length) {
          const at = (/** @type {number} */ k) => data.charCodeAt(i + k) - 32;
          keys.push(mouseKey(at(3), at(4) - 1, at(5) - 1, false));
          i += 6;
          continue;
        }
        let j = i + 2;
        while (j < data.length && /[0-9;<?]/.test(data[j])) j++;
        if (j < data.length) {
          // One in the SGR form: ESC [ < button ; x ; y, then M when pressed and m when released.
          const sgr = data[i + 2] === '<' && (data[j] === 'M' || data[j] === 'm') ? data.slice(i + 3, j).split(';').map(Number) : [];
          if (sgr.length === 3 && sgr.every(Number.isInteger)) keys.push(mouseKey(sgr[0], sgr[1] - 1, sgr[2] - 1, data[j] === 'm'));
          else keys.push({ name: SEQUENCES[data.slice(i, j + 1)] ?? 'unknown' });
          i = j + 1;
          continue;
        }
      } else if (next === 'O' && i + 2 < data.length) {
        keys.push({ name: SEQUENCES[data.slice(i, i + 3)] ?? 'unknown' });
        i += 3;
        continue;
      } else if (next !== undefined && next !== '\x1b') {
        keys.push({ name: 'alt', ch: next });
        i += 2;
        continue;
      }
      keys.push({ name: 'escape' });
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      keys.push({ name: 'enter' });
      i += c === '\r' && data[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    const code = c.charCodeAt(0);
    if (c === '\t') keys.push({ name: 'tab' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (code < 0x20) keys.push({ name: String.fromCharCode(code + 0x60), ctrl: true });
    else {
      const ch = String.fromCodePoint(/** @type {number} */ (data.codePointAt(i)));
      keys.push({ name: ch, ch });
      i += ch.length;
      continue;
    }
    i++;
  }
  return keys;
}

/**
 * A mouse report as a key. Its button number holds the button in its low two bits, with 64 for
 * the wheel and 128 for the buttons past the fifth; and the keys held (4, 8, 16) and whether
 * the mouse moved (32).
 * @param {number} code
 * @param {number} x
 * @param {number} y
 * @param {boolean} release
 * @returns {Key}
 */
function mouseKey(code, x, y, release) {
  const low = code & 3;
  const group = code & 192;
  /** @type {Mouse['button']} */
  let button = 'other';
  if (group === 64) button = low === 0 ? 'wheelup' : low === 1 ? 'wheeldown' : 'other';
  else if (group === 0 && low < 3) button = /** @type {const} */ (['left', 'middle', 'right'])[low];
  // The old form reports a release as button 3, without saying which was let go.
  const released = release || (group === 0 && low === 3);
  return { name: 'mouse', mouse: { button, x, y, release: released, motion: Boolean(code & 32) } };
}
