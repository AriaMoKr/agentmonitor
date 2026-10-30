// Keys from a terminal in raw mode: the escape sequences that arrows, Home, Page Up and the like
// send, made names. Windows consoles send the same sequences to Node in raw mode.

/**
 * @typedef {{ name: string, ch?: string, ctrl?: boolean }} Key
 *   name: 'up', 'enter', 'escape'... or the character typed; ch: the character typed
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
        let j = i + 2;
        while (j < data.length && /[0-9;<?]/.test(data[j])) j++;
        if (j < data.length) {
          keys.push({ name: SEQUENCES[data.slice(i, j + 1)] ?? 'unknown' });
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
