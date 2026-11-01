// The full-screen monitor: draws on the terminal's alternate screen, reads everything again
// every interval, redraws the lines that changed (often, while something spins) and now and then
// every line, and answers keys and the mouse. The terminal is put back as it was on every way out.
import { parseKeys } from './keys.js';
import { makeTheme } from './view.js';
import { Viewer } from './viewer.js';

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
const LEAVE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
// Clicks and the wheel reported (1000), in the SGR form (1006), which has no limit on columns.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/**
 * @typedef {import('./monitor.js').Snapshot} Snapshot
 */

/**
 * Runs until the user quits.
 * @param {import('./monitor.js').Monitor} monitor
 * @param {object} o
 * @param {number} o.intervalMs
 * @param {boolean} o.color
 * @param {boolean} o.ascii
 * @param {boolean} o.bell whether the bell starts on: it rings when a session starts waiting,
 *   or finishes its turn (b turns it on or off)
 * @param {import('./view.js').AgentsShown} o.agents
 * @param {boolean} o.showEnded
 * @param {string} [o.view] the view below the list it starts with (v steps through them)
 * @param {boolean} [o.mouse] have the terminal report clicks and the wheel
 * @param {number} [o.repaintMs] how often every line is drawn again, changed or not
 * @param {NodeJS.ReadStream} [o.stdin]
 * @param {NodeJS.WriteStream} [o.stdout]
 * @returns {Promise<void>}
 */
export function runTui(monitor, { intervalMs, color, ascii, bell, agents, showEnded, view, mouse = true, repaintMs = 2000, stdin = process.stdin, stdout = process.stdout }) {
  const t = makeTheme({ color, ascii });
  const viewer = new Viewer({
    monitor,
    t,
    agents,
    showEnded,
    bell,
    view,
    mouse,
    refresh: () => refresh(),
    // The selected agent has its transcript read, done or not, for the panel and its details; now.
    onFocus: (key) => {
      monitor.focus = new Set(key ? [key] : []);
      if (key?.startsWith('a:')) refresh();
    },
  });
  /** @type {Snapshot | null} */
  let snap = null;
  /** @type {string[]} */
  let shown = [];
  /** when every line was last drawn */
  let paintedAll = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let refreshTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let frameTimer;
  let refreshing = false;
  let again = false;
  let closed = false;
  /** @type {() => void} */
  let finish = () => {};

  const size = () => ({ width: Math.max(20, stdout.columns || 80), height: Math.max(5, stdout.rows || 24) });

  // Raw mode around the mouse's modes: on Windows it is the console's VT input, and only while
  // that is on does the console pass them on to the terminal (Windows Terminal, VS Code's).
  function setup() {
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdout.write(ENTER + (mouse ? MOUSE_ON : ''));
    shown = [];
  }

  function restore() {
    stdout.write((mouse ? MOUSE_OFF : '') + LEAVE);
    try {
      stdin.setRawMode(false);
    } catch {
      // stdin closed already
    }
    stdin.pause();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(refreshTimer);
    clearTimeout(frameTimer);
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    process.off('exit', restore);
    process.off('SIGTERM', close);
    process.off('SIGHUP', close);
    if (process.platform !== 'win32') process.off('SIGCONT', onContinue);
    restore();
    finish();
  }

  /** Writes the lines that differ from what is on screen, and every few seconds all of them. */
  function paint(/** @type {string[]} */ lines) {
    // A terminal can lose lines without telling the program: the desktop app's Terminal panel
    // has, with no resize reaching it. Every line drawn again now and then mends that.
    const all = Date.now() - paintedAll >= repaintMs;
    if (all) paintedAll = Date.now();
    let out = '';
    for (let i = 0; i < lines.length; i++) if (all || lines[i] !== shown[i]) out += `\x1b[${i + 1};1H${lines[i]}\x1b[0m`;
    if (lines.length < shown.length) out += `\x1b[${lines.length + 1};1H\x1b[J`;
    shown = lines;
    if (out) stdout.write(out);
  }

  function render() {
    if (closed) return;
    paint(viewer.lines(snap, { ...size(), now: Date.now() }));
  }

  /** Redraws now and again soon: ten times a second while something spins, else each second. */
  function frame() {
    clearTimeout(frameTimer);
    render();
    frameTimer = setTimeout(frame, viewer.spinning ? 100 : 1000);
  }

  async function refresh() {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    clearTimeout(refreshTimer);
    try {
      snap = await monitor.refresh();
      if (viewer.rings(snap)) stdout.write('\x07');
    } catch (e) {
      viewer.say(`could not read: ${/** @type {Error} */ (e).message}`);
    }
    refreshing = false;
    if (closed) return;
    frame();
    if (again) {
      again = false;
      refresh();
    } else refreshTimer = setTimeout(refresh, intervalMs);
  }

  /** The keys only a terminal has: Ctrl+C quits, Ctrl+L draws again, Ctrl+Z suspends. */
  function onKey(/** @type {import('./keys.js').Key} */ key) {
    if (key.ctrl && key.name === 'c') return close();
    if (key.ctrl && key.name === 'l') {
      stdout.write('\x1b[2J');
      shown = [];
      return;
    }
    if (key.ctrl && key.name === 'z' && process.platform !== 'win32') {
      restore();
      process.kill(process.pid, 'SIGTSTP');
      return;
    }
    if (viewer.key(key) === 'quit') close();
  }

  function onData(/** @type {string} */ data) {
    for (const key of parseKeys(data)) {
      if (key.mouse) {
        if (viewer.mouse(key.mouse) === 'quit') close();
      } else onKey(key);
      if (closed) return;
    }
    frame();
  }

  function onResize() {
    stdout.write('\x1b[2J');
    shown = [];
    frame();
  }

  function onContinue() {
    setup();
    frame();
  }

  return new Promise((resolve) => {
    finish = resolve;
    setup();
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    process.on('exit', restore);
    process.on('SIGTERM', close);
    process.on('SIGHUP', close);
    // Back from Ctrl+Z (there is none on Windows).
    if (process.platform !== 'win32') process.on('SIGCONT', onContinue);
    render();
    refresh();
  });
}
