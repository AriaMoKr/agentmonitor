// One look at the monitor, apart from where it is drawn: the view shown (the list, an agent's
// details, the help), the rows, the selection, the view below the rows, and what keys and clicks
// do to them. The full-screen monitor has one; the web view has one for each page open.
import { durationLabel } from './format.js';
import { MOVED, VIEWS, boardColumn, viewOf } from './panels.js';
import { AGENTS_SHOWN, SORTS, detailLines, endedShown, helpLines, initialUi, listLines, settleSelection, visibleRows } from './view.js';

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
   * @param {boolean} [o.showArchived] whether the sessions that ended are listed with those
   *   archived in the desktop app (e steps through on, off and all)
   * @param {boolean} [o.bell] whether the bell starts on
   * @param {string} [o.view] the view below the rows it starts with, by its name (src/panels.js):
   *   the board unless told
   * @param {boolean} [o.mouse] whether clicks reach it (the help says what they do)
   * @param {() => void} [o.refresh] has everything read again now (r, w)
   * @param {(key: string | undefined) => void} [o.onFocus] told when the selected agent changes
   *   (in the list, where the panel below the rows shows it, or in its details), whose transcript
   *   is then to be read though it is not at work
   * @param {(key: string) => void} [o.onOpen] where agents' details open elsewhere (the
   *   agentmonitor app's flyout hands them to its window): told the key of the agent to open,
   *   this view staying as it is; and as there is nothing here to step into, one click on a row
   *   opens it
   */
  constructor({ monitor, t, agents, showEnded, showArchived = false, bell = false, view = 'board', mouse = true, refresh = () => {}, onFocus = () => {}, onOpen }) {
    this.monitor = monitor;
    this.t = t;
    this.mouseOn = mouse;
    this.refresh = refresh;
    this.onFocus = onFocus;
    this.onOpen = onOpen;
    this.ui = { ...initialUi(), agents, showEnded, showArchived, bell, panel: viewOf(view).name };
    /** @type {Map<string, string>} each session's state as rings was last told it */
    this.states = new Map();
    /** @type {Map<string, string>} each session's column on the board, as last drawn */
    this.columns = new Map();
    /** whether the view below the rows, as last drawn, moves of itself */
    this.animating = false;
    /** @type {import('./view.js').Row[]} */
    this.rows = [];
    /** @type {import('./view.js').Hit[]} where a click goes, on the screen as last drawn */
    this.hits = [];
    /** @type {Agent | undefined} the agent in the detail view, as last seen */
    this.detail = undefined;
    /** the row last clicked, and when: a second click on it soon after opens it */
    this.lastClick = { key: '', at: 0 };
    /** @type {string | undefined} the selected agent, as onFocus was last told */
    this.told = undefined;
    /** the screen's height as last drawn, for the keys that move by pages */
    this.height = 24;
  }

  /** The key of the selected agent, in the list or in its details. */
  get focus() {
    return this.ui.selected;
  }

  /**
   * Whether a row on screen is at work, or the view below the rows moves of itself, so that it is
   * worth drawing often.
   */
  get spinning() {
    return this.ui.view !== 'help' && (this.animating || this.rows.some((r) => r.agent.state === 'working' || r.agent.state === 'running'));
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
    this.animating = false;
    if (!snap) return [` ${t.bold('Claude agents')}  ${t.dim(`reading ${this.monitor.dir}`)}`];
    this.moved(snap, screen.now);
    if (ui.view === 'help') return helpLines(ui, screen, t, this.monitor.dir, this.mouseOn, VIEWS);
    this.rows = visibleRows(snap, ui, t);
    if (ui.view === 'detail') {
      this.detail = find(snap, ui.selected) ?? this.detail;
      if (this.detail) return detailLines(this.detail, snap, ui, screen, t, this.hits);
      ui.view = 'list';
      this.tell();
    }
    // The rows that came or went can move the selection.
    settleSelection(ui, this.rows, screen.height - 3);
    this.tell();
    const view = viewOf(ui.panel);
    /** @type {import('./view.js').Panel | undefined} the view below the rows, where there is room */
    const panel = view.lines && ((...args) => {
      this.animating = view.animated;
      return /** @type {import('./view.js').Panel} */ (view.lines)(...args);
    });
    return listLines(snap, this.rows, ui, screen, t, this.hits, panel);
  }

  /**
   * Keeps the board's record of the sessions that moved from one of its columns to another
   * lately, whatever view is shown, so that the board shows them as soon as it is.
   * @param {Snapshot} snap
   * @param {number} now
   */
  moved(snap, now) {
    const { moves } = this.ui;
    for (const [key, m] of moves) if (now - m.at >= MOVED) moves.delete(key);
    /** @type {Map<string, string>} */
    const columns = new Map();
    for (const a of snap.rows) {
      const to = boardColumn(a);
      const from = this.columns.get(a.key);
      if (from !== undefined && from !== to) moves.set(a.key, { from, to, at: now });
      columns.set(a.key, to);
    }
    this.columns = columns;
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

  /** Tells onFocus of the selected agent, when that changed. */
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
    this.states = sessionStates(snap);
    return this.ui.bell && ringing(before, snap).length > 0;
  }

  /**
   * The filter as typed so far in a web page's text field, where a phone's keyboard types: it
   * takes the filter's place, being typed still (Enter keeps it). Only in the list, as / is.
   * @param {string} text
   */
  typeFilter(text) {
    if (this.ui.view === 'list') Object.assign(this.ui, { filter: text, editingFilter: true, top: 0 });
  }

  /**
   * A finger dragged a line's height up or down a web page. In the list the selection goes with
   * it, a row; in the details and the help the text does, a line, as on any page on a phone, so
   * that a drag up shows what is further down.
   * @param {boolean} up
   */
  drag(up) {
    const { ui } = this;
    if (ui.view === 'list') this.move(up ? -1 : 1);
    else if (ui.view === 'detail') ui.logScroll = Math.max(0, ui.logScroll + (up ? -1 : 1));
    else ui.helpTop = Math.max(0, ui.helpTop + (up ? 1 : -1));
  }

  /** @param {string} message shown in the footer for a while */
  say(message) {
    Object.assign(this.ui, { message, messageUntil: Date.now() + 2500 });
  }

  /**
   * Moves the selection by `by` rows, or to row `to`. With none selected, down from above the
   * first row, or up from below the last.
   */
  move(/** @type {number} */ by, /** @type {number | undefined} */ to = undefined) {
    const { ui, rows } = this;
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.agent.key === ui.selected);
    const from = at >= 0 ? at : ui.index >= 0 ? ui.index : by < 0 ? rows.length : -1;
    ui.index = Math.max(0, Math.min(rows.length - 1, to ?? from + by));
    ui.selected = rows[ui.index].agent.key;
  }

  /** Opens the details of the selected row, when one is. */
  open() {
    if (this.ui.selected !== undefined) this.goTo(this.ui.selected);
  }

  /**
   * Opens the details of the agent with this key, from wherever this view is (a click on it in the
   * panel below the rows, or the agentmonitor app's taskbar, jump list or menu); or, where they
   * open elsewhere, hands it on.
   * @param {string} key
   */
  goTo(key) {
    if (this.onOpen) {
      this.onOpen(key);
      return;
    }
    Object.assign(this.ui, { view: 'detail', selected: key, logScroll: 0, editingFilter: false });
    this.detail = undefined;
    this.tell();
  }

  sortBy(/** @type {import('./view.js').Sort} */ sort) {
    this.ui.sort = sort;
    this.say(`sorted by ${sort === 'recent' ? 'most recent' : sort}`);
  }

  /**
   * A click on a row selects it, and a second one soon after opens it; one below the rows selects
   * none, but on an agent the panel there names, which it opens, as one on an agent in the details
   * does; one on a column's title sorts by it, one on a key presses it, and one on the help goes
   * back. The wheel moves the selection, or scrolls the activity in the details, or the help.
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
    if ('unselect' in action) {
      Object.assign(ui, { selected: undefined, index: -1 });
      this.lastClick = { key: '', at: 0 };
      return;
    }
    if ('open' in action) return this.goTo(action.open);
    const now = Date.now();
    const again = m.double || (action.select === this.lastClick.key && now - this.lastClick.at < DOUBLE_CLICK);
    this.lastClick = again ? { key: '', at: 0 } : { key: action.select, at: now };
    ui.selected = action.select;
    if (again || this.onOpen) this.open();
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
      // A web page is closed, not quit; the agentmonitor app's window quits as a terminal does.
      case 'q': return this.t.quit ? 'quit' : undefined;
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
      case 'e': {
        const next = { on: 'off', off: 'all', all: 'on' }[endedShown(ui)];
        ui.showEnded = next !== 'off';
        ui.showArchived = next === 'all';
        this.say(next === 'on' ? 'showing the sessions that ended, but those archived' : next === 'off' ? 'hiding the sessions that ended' : 'showing every session that ended, those archived too');
        return;
      }
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
      case 'v': case 'V': {
        const at = VIEWS.indexOf(viewOf(ui.panel));
        const next = VIEWS[(at + (key.name === 'v' ? 1 : VIEWS.length - 1)) % VIEWS.length];
        ui.panel = next.name;
        this.say(`${next.name}: ${next.what}`);
        return;
      }
      case '?':
        Object.assign(ui, { view: 'help', helpTop: 0 });
        return;
    }
  }
}

/**
 * Each session's state, by its key.
 * @param {Snapshot} snap
 * @returns {Map<string, string>}
 */
export function sessionStates(snap) {
  return new Map(snap.rows.map((r) => [r.key, r.state]));
}

/**
 * The sessions in `snap` that ring the bell: those that started waiting for you, or went from
 * working to idle, since `before` (each session's state as last seen). A session not seen before
 * rings for nothing.
 * @param {Map<string, string>} before
 * @param {Snapshot} snap
 * @returns {Agent[]}
 */
export function ringing(before, snap) {
  return snap.rows.filter((r) => {
    const was = before.get(r.key);
    return was !== undefined && was !== r.state && (r.state === 'waiting' || (was === 'working' && r.state === 'idle'));
  });
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
