// One look at the monitor, apart from where it is drawn: the view shown (the list, an agent's
// details, the help), the rows, the selection, and what keys and clicks do to them. The
// full-screen monitor has one; the web view has one for each page open.
import { durationLabel } from './format.js';
import { AGENTS_SHOWN, SORTS, detailLines, helpLines, initialUi, listLines, settleSelection, visibleRows } from './view.js';

/** The windows the w key steps through. */
export const WINDOWS = [1, 6, 24, 72, 168].map((h) => h * 3_600_000);

/** How soon a second click on a row opens it (ms). */
const DOUBLE_CLICK = 500;

/**
 * @typedef {import('./monitor.js').Agent} Agent
 * @typedef {import('./monitor.js').Snapshot} Snapshot
 * @typedef {import('./keys.js').Key} Key
 * @typedef {import('./keys.js').Mouse} Mouse
 */

export class Viewer {
  /**
   * @param {object} o
   * @param {{ dir: string, windowMs: number }} o.monitor what it looks at: the folder read, and
   *   the window for "recently active", which w steps
   * @param {import('./view.js').Theme} o.t
   * @param {import('./view.js').AgentsShown} o.agents
   * @param {boolean} o.showEnded
   * @param {boolean} [o.bell] whether the bell starts on
   * @param {boolean} [o.mouse] whether clicks reach it (the help says what they do)
   * @param {() => void} [o.refresh] has everything read again now (r, w)
   * @param {(key: string | undefined) => void} [o.onFocus] told when the agent in the details
   *   changes, whose transcript is then to be read though it is not at work
   */
  constructor({ monitor, t, agents, showEnded, bell = false, mouse = true, refresh = () => {}, onFocus = () => {} }) {
    this.monitor = monitor;
    this.t = t;
    this.mouseOn = mouse;
    this.refresh = refresh;
    this.onFocus = onFocus;
    this.ui = { ...initialUi(), agents, showEnded, bell };
    /** @type {Map<string, string>} each session's state as rings was last told it */
    this.states = new Map();
    /** @type {import('./view.js').Row[]} */
    this.rows = [];
    /** @type {import('./view.js').Hit[]} where a click goes, on the screen as last drawn */
    this.hits = [];
    /** @type {Agent | undefined} the agent in the detail view, as last seen */
    this.detail = undefined;
    /** the row last clicked, and when: a second click on it soon after opens it */
    this.lastClick = { key: '', at: 0 };
    /** @type {string | undefined} the agent in the details, as onFocus was last told */
    this.told = undefined;
    /** the screen's height as last drawn, for the keys that move by pages */
    this.height = 24;
  }

  /** The key of the agent in the details, if they are shown. */
  get focus() {
    return this.ui.view === 'detail' ? this.ui.selected : undefined;
  }

  /** Whether a row on screen is at work, so that it is worth drawing often. */
  get spinning() {
    return this.ui.view !== 'help' && this.rows.some((r) => r.agent.state === 'working' || r.agent.state === 'running');
  }

  /**
   * What the screen shows, as lines; and in `hits`, where a click on them goes.
   * @param {Snapshot | null} snap null before the first read
   * @param {import('./view.js').Screen} screen
   * @returns {string[]}
   */
  lines(snap, screen) {
    const { t, ui } = this;
    this.hits = [];
    this.height = screen.height;
    if (!snap) return [` ${t.bold('Claude agents')}  ${t.dim(`reading ${this.monitor.dir}`)}`];
    if (ui.view === 'help') return helpLines(ui, screen, t, this.monitor.dir, this.mouseOn);
    this.rows = visibleRows(snap, ui, t);
    if (ui.view === 'detail') {
      this.detail = find(snap, ui.selected) ?? this.detail;
      if (this.detail) return detailLines(this.detail, snap, ui, screen, t, this.hits);
      ui.view = 'list';
      this.tell();
    }
    settleSelection(ui, this.rows, screen.height - 3);
    return listLines(snap, this.rows, ui, screen, t, this.hits);
  }

  /**
   * A key pressed.
   * @param {Key} key
   * @returns {'quit' | undefined} 'quit' when it asks to quit: q in the list
   */
  key(key) {
    const done = this.onKey(key);
    this.tell();
    return done;
  }

  /**
   * A click or a turn of the wheel.
   * @param {Mouse} m
   * @returns {'quit' | undefined} 'quit' for a click on q in the footer
   */
  mouse(m) {
    const done = this.onMouse(m);
    this.tell();
    return done;
  }

  /** Tells onFocus of the agent in the details, when that changed. */
  tell() {
    const key = this.focus;
    if (key === this.told) return;
    this.told = key;
    this.onFocus(key);
  }

  /**
   * Whether `snap` rings the bell, when it is on: a session in it started waiting for you, or
   * went from working to idle, since the snapshot this was last told of. Told of every one, the
   * bell on or off, so that turning it on rings for nothing old.
   * @param {Snapshot} snap
   */
  rings(snap) {
    const before = this.states;
    this.states = new Map(snap.rows.map((r) => [r.key, r.state]));
    return this.ui.bell && snap.rows.some((r) => {
      const was = before.get(r.key);
      return was !== undefined && was !== r.state && (r.state === 'waiting' || (was === 'working' && r.state === 'idle'));
    });
  }

  /**
   * The filter as typed so far in a web page's text field, where a phone's keyboard types: it
   * takes the filter's place, being typed still (Enter keeps it). Only in the list, as / is.
   * @param {string} text
   */
  typeFilter(text) {
    if (this.ui.view === 'list') Object.assign(this.ui, { filter: text, editingFilter: true, top: 0 });
  }

  /** @param {string} message shown in the footer for a while */
  say(message) {
    Object.assign(this.ui, { message, messageUntil: Date.now() + 2500 });
  }

  /** Moves the selection by `by` rows, or to row `to`. */
  move(/** @type {number} */ by, /** @type {number | undefined} */ to = undefined) {
    const { ui, rows } = this;
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.agent.key === ui.selected);
    if (at >= 0) ui.index = at;
    ui.index = Math.max(0, Math.min(rows.length - 1, to ?? ui.index + by));
    ui.selected = rows[ui.index].agent.key;
  }

  /** Opens the details of the selected row. */
  open() {
    if (this.rows.length) Object.assign(this.ui, { view: 'detail', logScroll: 0 });
    this.detail = undefined;
  }

  sortBy(/** @type {import('./view.js').Sort} */ sort) {
    this.ui.sort = sort;
    this.say(`sorted by ${sort === 'recent' ? 'most recent' : sort}`);
  }

  /**
   * A click on a row selects it, and a second one soon after opens it; one on a column's title
   * sorts by it, one on a key presses it, one on an agent in the details opens that agent, and
   * one on the help goes back. The wheel moves the selection, or scrolls the activity in the
   * details, or the help.
   * @param {Mouse} m
   * @returns {'quit' | undefined}
   */
  onMouse(m) {
    const { ui } = this;
    if (m.release || m.motion) return;
    if (m.button === 'wheelup' || m.button === 'wheeldown') {
      const by = m.button === 'wheelup' ? -1 : 1;
      if (ui.view === 'detail') ui.logScroll = Math.max(0, ui.logScroll - 3 * by);
      else if (ui.view === 'help') ui.helpTop = Math.max(0, ui.helpTop + 3 * by);
      else if (ui.view === 'list') this.move(by);
      return;
    }
    if (m.button !== 'left') return;
    if (ui.view === 'help') {
      ui.view = 'list';
      return;
    }
    const action = this.hits.find((h) => h.y === m.y && m.x >= h.x0 && m.x < h.x1)?.action;
    if (!action) return;
    if ('key' in action) return this.onKey({ name: action.key });
    // A click on anything else ends the typing of a filter, as Enter does.
    ui.editingFilter = false;
    if ('sort' in action) return this.sortBy(action.sort);
    if ('open' in action) {
      Object.assign(ui, { selected: action.open, logScroll: 0 });
      this.detail = undefined;
      return;
    }
    const now = Date.now();
    const again = m.double || (action.select === this.lastClick.key && now - this.lastClick.at < DOUBLE_CLICK);
    this.lastClick = again ? { key: '', at: 0 } : { key: action.select, at: now };
    ui.selected = action.select;
    if (again) this.open();
  }

  /**
   * @param {Key} key
   * @returns {'quit' | undefined}
   */
  onKey(key) {
    const { ui } = this;
    const page = Math.max(1, this.height - 4);
    if (ui.editingFilter) {
      if (key.name === 'enter') ui.editingFilter = false;
      else if (key.name === 'escape') Object.assign(ui, { filter: '', editingFilter: false });
      else if (key.name === 'backspace') ui.filter = [...ui.filter].slice(0, -1).join('');
      else if (key.ch) ui.filter += key.ch;
      ui.top = 0;
      return;
    }
    if (ui.view === 'help') {
      // The keys that scroll it (its drawing keeps it from going past its end); any other goes back.
      switch (key.name) {
        case 'up': case 'k': ui.helpTop = Math.max(0, ui.helpTop - 1); return;
        case 'down': case 'j': ui.helpTop++; return;
        case 'pageup': ui.helpTop = Math.max(0, ui.helpTop - page); return;
        case 'pagedown': ui.helpTop += page; return;
        case 'home': case 'g': ui.helpTop = 0; return;
        case 'end': case 'G': ui.helpTop = Number.MAX_SAFE_INTEGER; return;
      }
      ui.view = 'list';
      return;
    }
    if (ui.view === 'detail') {
      switch (key.name) {
        case 'escape': case 'left': case 'h': case 'backspace': case 'q':
          ui.view = 'list';
          return;
        case 'up': case 'k': ui.logScroll++; return;
        case 'down': case 'j': ui.logScroll = Math.max(0, ui.logScroll - 1); return;
        case 'pageup': ui.logScroll += page; return;
        case 'pagedown': ui.logScroll = Math.max(0, ui.logScroll - page); return;
        case 'home': case 'g': ui.logScroll = Number.MAX_SAFE_INTEGER; return;
        case 'end': case 'G': ui.logScroll = 0; return;
        case 'tab': case 'backtab':
          this.move(key.name === 'tab' ? 1 : -1);
          ui.logScroll = 0;
          return;
      }
      return;
    }
    switch (key.name) {
      // A web page is closed, not quit.
      case 'q': return this.t.web ? undefined : 'quit';
      case 'up': case 'k': return this.move(-1);
      case 'down': case 'j': return this.move(1);
      case 'pageup': return this.move(-page);
      case 'pagedown': return this.move(page);
      case 'home': case 'g': return this.move(0, 0);
      case 'end': case 'G': return this.move(0, this.rows.length - 1);
      case 'enter': case 'right': case 'l':
        return this.open();
      case '/':
        ui.editingFilter = true;
        return;
      case 'escape':
        ui.filter = '';
        return;
      case 's':
        return this.sortBy(SORTS[(SORTS.indexOf(ui.sort) + 1) % SORTS.length]);
      case 'e':
        ui.showEnded = !ui.showEnded;
        this.say(ui.showEnded ? 'showing the sessions that ended' : 'hiding the sessions that ended');
        return;
      case 'a':
        ui.agents = AGENTS_SHOWN[(AGENTS_SHOWN.indexOf(ui.agents) + 1) % AGENTS_SHOWN.length];
        this.say(ui.agents === 'running' ? 'listing the agents at work' : ui.agents === 'all' ? 'listing every agent' : 'listing no agents');
        return;
      case 'w': {
        const at = WINDOWS.findIndex((w) => w > this.monitor.windowMs);
        this.monitor.windowMs = WINDOWS[at < 0 ? 0 : at];
        this.say(`recently active: the last ${durationLabel(this.monitor.windowMs)}`);
        this.refresh();
        return;
      }
      case 'r':
        this.say('reading again');
        this.refresh();
        return;
      case 'b':
        ui.bell = !ui.bell;
        this.say(ui.bell ? 'the bell rings when a session needs you or ends its turn' : 'no bell');
        return;
      case '?':
        Object.assign(ui, { view: 'help', helpTop: 0 });
        return;
    }
  }
}

/**
 * The agent with this key, wherever it is in the snapshot (an agent can be hidden from the list).
 * @param {Snapshot} snap
 * @param {string | undefined} key
 * @returns {Agent | undefined}
 */
export function find(snap, key) {
  if (!key) return undefined;
  /** @type {Agent[]} */
  const todo = [...snap.rows];
  for (let a = todo.pop(); a; a = todo.pop()) {
    if (a.key === key) return a;
    todo.push(...a.children);
  }
  return undefined;
}
