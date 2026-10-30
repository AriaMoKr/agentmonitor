// The full-screen monitor: draws on the terminal's alternate screen, reads everything again
// every interval, redraws only the lines that changed (often, while something spins), and
// answers keys. The terminal is put back as it was on every way out.
import { durationLabel } from './format.js';
import { parseKeys } from './keys.js';
import { AGENTS_SHOWN, SORTS, detailLines, helpLines, initialUi, listLines, makeTheme, settleSelection, visibleRows } from './view.js';

/** The windows the w key steps through. */
export const WINDOWS = [1, 6, 24, 72, 168].map((h) => h * 3_600_000);

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
const LEAVE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

/**
 * @typedef {import('./monitor.js').Agent} Agent
 * @typedef {import('./monitor.js').Snapshot} Snapshot
 */

/**
 * Runs until the user quits.
 * @param {import('./monitor.js').Monitor} monitor
 * @param {object} o
 * @param {number} o.intervalMs
 * @param {boolean} o.color
 * @param {boolean} o.ascii
 * @param {boolean} o.bell ring when a session starts waiting, or finishes its turn
 * @param {import('./view.js').AgentsShown} o.agents
 * @param {boolean} o.showEnded
 * @param {NodeJS.ReadStream} [o.stdin]
 * @param {NodeJS.WriteStream} [o.stdout]
 * @returns {Promise<void>}
 */
export function runTui(monitor, { intervalMs, color, ascii, bell, agents, showEnded, stdin = process.stdin, stdout = process.stdout }) {
  const t = makeTheme({ color, ascii });
  const ui = { ...initialUi(), agents, showEnded };
  /** @type {Snapshot | null} */
  let snap = null;
  /** @type {import('./view.js').Row[]} */
  let rows = [];
  /** @type {string[]} */
  let shown = [];
  /** @type {Agent | undefined} the agent in the detail view, as last seen */
  let detail;
  /** @type {Map<string, string>} each session's state at the last refresh, for the bell */
  let states = new Map();
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
  const say = (/** @type {string} */ message) => Object.assign(ui, { message, messageUntil: Date.now() + 2500 });

  function setup() {
    stdout.write(ENTER);
    shown = [];
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
  }

  function restore() {
    try {
      stdin.setRawMode(false);
    } catch {
      // stdin closed already
    }
    stdin.pause();
    stdout.write(LEAVE);
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

  /** Writes the lines that differ from what is on screen. */
  function paint(/** @type {string[]} */ lines) {
    let out = '';
    for (let i = 0; i < lines.length; i++) if (lines[i] !== shown[i]) out += `\x1b[${i + 1};1H${lines[i]}\x1b[0m`;
    if (lines.length < shown.length) out += `\x1b[${lines.length + 1};1H\x1b[J`;
    shown = lines;
    if (out) stdout.write(out);
  }

  function render() {
    if (closed) return;
    const { width, height } = size();
    const now = Date.now();
    if (!snap) {
      paint([` ${t.bold('Claude agents')}  ${t.dim(`reading ${monitor.dir}`)}`]);
      return;
    }
    if (ui.view === 'help') {
      paint(helpLines({ width, height, now }, t, monitor.dir));
      return;
    }
    rows = visibleRows(snap, ui, t);
    if (ui.view === 'detail') {
      detail = find(snap, ui.selected) ?? detail;
      if (detail) {
        paint(detailLines(detail, snap, ui, { width, height, now }, t));
        return;
      }
      ui.view = 'list';
      focus();
    }
    settleSelection(ui, rows, height - 3);
    paint(listLines(snap, rows, ui, { width, height, now }, t));
  }

  /** Redraws now and again soon: ten times a second while something spins, else each second. */
  function frame() {
    clearTimeout(frameTimer);
    render();
    const spinning = ui.view !== 'help' && rows.some((r) => r.agent.state === 'working' || r.agent.state === 'running');
    frameTimer = setTimeout(frame, spinning ? 100 : 1000);
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
      if (bell) ring(snap);
    } catch (e) {
      say(`could not read: ${/** @type {Error} */ (e).message}`);
    }
    refreshing = false;
    if (closed) return;
    frame();
    if (again) {
      again = false;
      refresh();
    } else refreshTimer = setTimeout(refresh, intervalMs);
  }

  /** Rings the bell when a session starts waiting for the user, or stops working. */
  function ring(/** @type {Snapshot} */ s) {
    const next = new Map(s.rows.map((r) => [r.key, r.state]));
    const rang = s.rows.some((r) => {
      const was = states.get(r.key);
      return was && was !== r.state && (r.state === 'waiting' || (was === 'working' && r.state === 'idle'));
    });
    if (rang && states.size) stdout.write('\x07');
    states = next;
  }

  /** Has the monitor read the transcript of the agent in the detail view, done or not; now. */
  function focus() {
    const key = ui.view === 'detail' ? ui.selected : undefined;
    if (key === monitor.focus) return;
    monitor.focus = key;
    if (key?.startsWith('a:')) refresh();
  }

  /** Moves the selection by `by` rows, or to row `to`. */
  function move(/** @type {number} */ by, /** @type {number | undefined} */ to = undefined) {
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.agent.key === ui.selected);
    if (at >= 0) ui.index = at;
    ui.index = Math.max(0, Math.min(rows.length - 1, to ?? ui.index + by));
    ui.selected = rows[ui.index].agent.key;
  }

  function onKey(/** @type {import('./keys.js').Key} */ key) {
    const page = Math.max(1, size().height - 4);
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
    if (ui.editingFilter) {
      if (key.name === 'enter') ui.editingFilter = false;
      else if (key.name === 'escape') Object.assign(ui, { filter: '', editingFilter: false });
      else if (key.name === 'backspace') ui.filter = [...ui.filter].slice(0, -1).join('');
      else if (key.ch) ui.filter += key.ch;
      ui.top = 0;
      return;
    }
    if (ui.view === 'help') {
      ui.view = 'list';
      return;
    }
    if (ui.view === 'detail') {
      switch (key.name) {
        case 'escape': case 'left': case 'h': case 'backspace': case 'q':
          ui.view = 'list';
          focus();
          return;
        case 'up': case 'k': ui.logScroll++; return;
        case 'down': case 'j': ui.logScroll = Math.max(0, ui.logScroll - 1); return;
        case 'pageup': ui.logScroll += page; return;
        case 'pagedown': ui.logScroll = Math.max(0, ui.logScroll - page); return;
        case 'home': case 'g': ui.logScroll = Number.MAX_SAFE_INTEGER; return;
        case 'end': case 'G': ui.logScroll = 0; return;
        case 'tab': case 'backtab':
          move(key.name === 'tab' ? 1 : -1);
          ui.logScroll = 0;
          focus();
          return;
      }
      return;
    }
    switch (key.name) {
      case 'q': return close();
      case 'up': case 'k': return move(-1);
      case 'down': case 'j': return move(1);
      case 'pageup': return move(-page);
      case 'pagedown': return move(page);
      case 'home': case 'g': return move(0, 0);
      case 'end': case 'G': return move(0, rows.length - 1);
      case 'enter': case 'right': case 'l':
        if (rows.length) Object.assign(ui, { view: 'detail', logScroll: 0 });
        detail = undefined;
        focus();
        return;
      case '/':
        ui.editingFilter = true;
        return;
      case 'escape':
        ui.filter = '';
        return;
      case 's':
        ui.sort = SORTS[(SORTS.indexOf(ui.sort) + 1) % SORTS.length];
        say(`sorted by ${ui.sort === 'recent' ? 'most recent' : ui.sort}`);
        return;
      case 'e':
        ui.showEnded = !ui.showEnded;
        say(ui.showEnded ? 'showing the sessions that ended' : 'hiding the sessions that ended');
        return;
      case 'a':
        ui.agents = AGENTS_SHOWN[(AGENTS_SHOWN.indexOf(ui.agents) + 1) % AGENTS_SHOWN.length];
        say(ui.agents === 'running' ? 'listing the agents at work' : ui.agents === 'all' ? 'listing every agent' : 'listing no agents');
        return;
      case 'w': {
        const at = WINDOWS.findIndex((w) => w > monitor.windowMs);
        monitor.windowMs = WINDOWS[at < 0 ? 0 : at];
        say(`recently active: the last ${durationLabel(monitor.windowMs)}`);
        refresh();
        return;
      }
      case 'r':
        say('reading again');
        refresh();
        return;
      case '?':
        ui.view = 'help';
        return;
    }
  }

  function onData(/** @type {string} */ data) {
    for (const key of parseKeys(data)) {
      onKey(key);
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

/**
 * The agent with this key, wherever it is in the snapshot (an agent can be hidden from the list).
 * @param {Snapshot} snap
 * @param {string | undefined} key
 * @returns {Agent | undefined}
 */
function find(snap, key) {
  if (!key) return undefined;
  /** @type {Agent[]} */
  const todo = [...snap.rows];
  for (let a = todo.pop(); a; a = todo.pop()) {
    if (a.key === key) return a;
    todo.push(...a.children);
  }
  return undefined;
}
