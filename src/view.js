// What the monitor draws, as lines for a screen of a given size: the list of agents, one agent
// in detail, and the help; and the plain table --once prints. Pure functions of a snapshot and
// the screen's state, so the tests can draw them; the list and the details also say where a
// click goes, as they draw it.
import { ago, bytes, clock, durationLabel, elapsed, fit, graphemes, shortModel, timeOfDay, tokens, truncate, weekday, width } from './format.js';

/**
 * @typedef {import('./monitor.js').Agent} Agent
 * @typedef {import('./monitor.js').Snapshot} Snapshot
 * @typedef {import('./monitor.js').State} State
 * @typedef {State | 'unread' | 'blocked' | 'tool'} Shown the state a row shows: in place of idle
 *   or ended, blocked when the desktop app's summary of the last turn says it waits on you, or
 *   unread, the app's blue dot; in place of working or running, tool while it waits on a tool
 *   call that has run a while
 * @typedef {'status' | 'recent' | 'name' | 'project'} Sort
 * @typedef {'running' | 'all' | 'none'} AgentsShown
 *
 * @typedef {object} Ui
 * @property {'list' | 'detail' | 'help'} view
 * @property {string | undefined} selected the selected row's key
 * @property {number} index the selected row's place, kept when its row goes away
 * @property {number} top the first row on screen
 * @property {number} logScroll how far the detail view's activity is scrolled back from the newest
 * @property {number} helpTop the help's first line on screen, when it is taller than the screen
 * @property {string} filter
 * @property {boolean} editingFilter
 * @property {Sort} sort
 * @property {boolean} showEnded
 * @property {AgentsShown} agents which agents of a session are listed under it
 * @property {boolean} bell whether the bell rings when a session starts waiting for you, or
 *   finishes its turn
 * @property {string} message shown in the footer until messageUntil
 * @property {number} messageUntil
 *
 * @typedef {{ agent: Agent, depth: number, prefix: string }} Row
 * @typedef {{ width: number, height: number, now: number }} Screen
 *
 * @typedef {{ select: string } | { open: string } | { sort: Sort } | { key: string }} Action what
 *   a click does: select the row with this key (a second click opens it), open this agent's
 *   details, sort, or press a key
 * @typedef {{ y: number, x0: number, x1: number, action: Action }} Hit a place a click acts on:
 *   line y, from column x0 up to x1
 */

/** The sort a click on a column's title picks. */
const COLUMN_SORTS = /** @type {Record<string, Sort>} */ ({ state: 'status', title: 'name', project: 'project', activity: 'status', last: 'recent' });

export const SORTS = /** @type {Sort[]} */ (['status', 'recent', 'name', 'project']);
export const AGENTS_SHOWN = /** @type {AgentsShown[]} */ (['running', 'all', 'none']);

/** @returns {Ui} */
export function initialUi() {
  return {
    view: 'list', selected: undefined, index: 0, top: 0, logScroll: 0, helpTop: 0,
    filter: '', editingFilter: false, sort: 'status', showEnded: true, agents: 'running', bell: false,
    message: '', messageUntil: 0,
  };
}

/**
 * The look: colors as SGR escapes (none without color), the glyphs, Unicode or ASCII, whether
 * work in progress spins (not in a table printed once), and whether it is drawn on a web page,
 * where no key quits and text is selected by dragging.
 * @param {{ color: boolean, ascii: boolean, animate?: boolean, web?: boolean }} o
 */
export function makeTheme({ color, ascii, animate = true, web = false }) {
  const sgr = (/** @type {string} */ code) => (/** @type {string} */ s) => (color && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    color,
    ascii,
    animate,
    web,
    bold: sgr('1'),
    dim: sgr('2'),
    inverse: sgr('7'),
    red: sgr('31'),
    green: sgr('32'),
    yellow: sgr('33'),
    blue: sgr('34'),
    magenta: sgr('35'),
    cyan: sgr('36'),
    yellowBold: sgr('1;33'),
    blueBold: sgr('1;34'),
    ellipsis: ascii ? '~' : '…',
    rule: ascii ? '-' : '─',
    /** between the parts of a field */
    sep: ascii ? ', ' : ' · ',
    spinner: ascii ? ['|', '/', '-', '\\'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    /** a slower one while it waits on a tool call */
    toolSpinner: ascii ? ['%'] : ['◐', '◓', '◑', '◒'],
    glyphs: /** @type {Record<Shown, string>} */ (ascii
      ? { working: '*', running: '*', tool: '%', waiting: '!', blocked: '!', unread: '@', idle: 'o', active: '?', done: '+', failed: 'x', stopped: '#', ended: '.' }
      : { working: '●', running: '●', tool: '◐', waiting: '◆', blocked: '◇', unread: '•', idle: '○', active: '◌', done: '✓', failed: '✗', stopped: '■', ended: '·' }),
    /** a task list's steps */
    steps: ascii ? { completed: '+', in_progress: '>', pending: '-' } : { completed: '✓', in_progress: '▸', pending: '○' },
    tree: ascii ? { mid: '|- ', last: '`- ', pipe: '|  ', none: '   ' } : { mid: '├─ ', last: '└─ ', pipe: '│  ', none: '   ' },
    arrows: ascii ? 'up/down' : '↑↓',
    enter: ascii ? 'enter' : '⏎',
    /** a styled line cut or padded to a width */
    pad: (/** @type {string} */ s, /** @type {number} */ cols) => padStyled(s, cols, ascii ? '~' : '…'),
  };
}
/** @typedef {ReturnType<typeof makeTheme>} Theme */

// What needs you first: waiting or blocked, then unread.
const ORDER = /** @type {Record<Shown, number>} */ ({ waiting: 0, blocked: 0, unread: 1, working: 2, running: 2, tool: 2, active: 3, idle: 4, done: 5, failed: 5, stopped: 5, ended: 5 });

/**
 * The state an agent's row shows.
 * @param {Agent} a
 * @returns {Shown}
 */
export const shown = (a) => (a.blocked ? 'blocked' : a.unread ? 'unread' : a.inTool ? 'tool' : a.state);

/**
 * A state's glyph: a spinner while at work, a slower one while it waits on a tool call.
 * @param {Shown} state
 * @param {Theme} t
 * @param {number} now
 */
function glyphChar(state, t, now) {
  if ((state === 'working' || state === 'running') && t.animate) return t.spinner[Math.floor(now / 100) % t.spinner.length];
  if (state === 'tool' && t.animate) return t.toolSpinner[Math.floor(now / 250) % t.toolSpinner.length];
  return t.glyphs[state] ?? '?';
}

/**
 * A state's glyph, colored.
 * @param {Shown} state
 * @param {Theme} t
 * @param {number} now
 */
function glyph(state, t, now) {
  const g = glyphChar(state, t, now);
  switch (state) {
    case 'working':
    case 'running':
    case 'tool': return t.green(g);
    case 'waiting':
    case 'blocked': return t.yellowBold(g);
    case 'unread': return t.blueBold(g);
    case 'idle': return t.cyan(g);
    case 'active': return t.blue(g);
    case 'failed': return t.red(g);
    case 'stopped': return t.magenta(g);
    default: return t.dim(g);
  }
}

/** @param {State} state */
const over = (state) => ORDER[state] === 5;

/**
 * Whether an agent's activity goes on now, so that how long it has taken means something.
 * @param {Agent} a
 */
const ongoing = (a) => ['tool', 'thinking', 'waiting', 'agents', 'background'].includes(a.activityKind) && a.activityAt > 0;

/**
 * How far its task list has come, as '4/8', while it is at work on it (in the turn that made it).
 * @param {Agent} a
 */
function progress(a) {
  if (!a.plan?.current || !['working', 'waiting', 'running'].includes(a.state)) return '';
  return `${a.plan.steps.filter((s) => s.status === 'completed').length}/${a.plan.steps.length}`;
}

/**
 * The rows to list: the sessions in the chosen order, each followed by the agents it shows.
 * @param {Snapshot} snap
 * @param {Ui} ui
 * @param {Theme} t
 * @returns {Row[]}
 */
export function visibleRows(snap, ui, t) {
  const needle = ui.filter.trim().toLowerCase();
  const matches = (/** @type {Agent} */ a) =>
    [a.title, a.project, a.cwd, a.sessionId, a.kind, shortModel(a.model), a.effort, a.ultracode && 'ultracode', a.activity, a.agentType, String(a.pid ?? '')]
      .some((v) => v && v.toLowerCase().includes(needle));
  const sessions = snap.rows.filter((a) => {
    if (!ui.showEnded && over(a.state)) return false;
    return !needle || matches(a) || a.children.some((c) => matches(c) || c.children.some(matches));
  });
  sessions.sort(compare(ui.sort));
  /** @type {Row[]} */
  const rows = [];
  for (const s of sessions) {
    rows.push({ agent: s, depth: 0, prefix: '' });
    if (ui.agents === 'none') continue;
    const kids = s.children.filter((c) => ui.agents === 'all' || c.state === 'running');
    kids.forEach((c, i) => {
      const last = i === kids.length - 1;
      rows.push({ agent: c, depth: 1, prefix: last ? t.tree.last : t.tree.mid });
      const grand = c.children.filter((g) => ui.agents === 'all' || g.state === 'running');
      grand.forEach((g, j) => {
        rows.push({ agent: g, depth: 2, prefix: (last ? t.tree.none : t.tree.pipe) + (j === grand.length - 1 ? t.tree.last : t.tree.mid) });
      });
    });
  }
  return rows;
}

/**
 * @param {Sort} sort
 * @returns {(a: Agent, b: Agent) => number}
 */
function compare(sort) {
  const recent = (/** @type {Agent} */ a, /** @type {Agent} */ b) => b.lastActive - a.lastActive;
  switch (sort) {
    case 'recent': return recent;
    case 'name': return (a, b) => a.title.localeCompare(b.title) || recent(a, b);
    case 'project': return (a, b) => (a.project ?? '').localeCompare(b.project ?? '') || recent(a, b);
    default: return (a, b) => ORDER[shown(a)] - ORDER[shown(b)] || recent(a, b);
  }
}

/**
 * Keeps the selection on its row (by key) or, when that row went away, at its place; and the
 * selected row on screen.
 * @param {Ui} ui
 * @param {Row[]} rows
 * @param {number} bodyHeight
 */
export function settleSelection(ui, rows, bodyHeight) {
  const at = ui.selected === undefined ? -1 : rows.findIndex((r) => r.agent.key === ui.selected);
  ui.index = at >= 0 ? at : Math.max(0, Math.min(ui.index, rows.length - 1));
  ui.selected = rows[ui.index]?.agent.key;
  const h = Math.max(1, bodyHeight);
  if (ui.index < ui.top) ui.top = ui.index;
  if (ui.index >= ui.top + h) ui.top = ui.index - h + 1;
  ui.top = Math.max(0, Math.min(ui.top, Math.max(0, rows.length - h)));
}

/**
 * @typedef {{ key: string, title: string, width: number, align?: 'left' | 'right', flex?: number, min?: number }} Column
 * The columns that fit `cols`: the name and the activity share what the others leave.
 * @param {number} cols
 * @returns {Column[]}
 */
export function columns(cols) {
  /** @type {(Column & { from?: number })[]} */
  const all = [
    { key: 'state', title: '', width: 1 },
    { key: 'project', title: 'PROJECT', width: 16, from: 72 },
    { key: 'title', title: 'NAME', width: 0, flex: 42, min: 12 },
    { key: 'model', title: 'MODEL', width: 10, from: 104 },
    { key: 'effort', title: 'EFFORT', width: 7, from: 110 },
    { key: 'ctx', title: 'CTX', width: 5, align: 'right', from: 90 },
    { key: 'activity', title: 'ACTIVITY', width: 0, flex: 58, min: 10 },
    { key: 'last', title: 'LAST', width: 4, align: 'right' },
    { key: 'pid', title: 'PID', width: 6, align: 'right', from: 140 },
    { key: 'kind', title: 'KIND', width: 8, from: 118 },
  ];
  const shown = all.filter((c) => !c.from || cols >= c.from);
  // One column of margin on the left, one space between columns.
  const fixed = 1 + (shown.length - 1) + shown.reduce((n, c) => n + c.width, 0);
  const rest = Math.max(0, cols - fixed);
  const title = /** @type {Column} */ (shown.find((c) => c.key === 'title'));
  const activity = /** @type {Column} */ (shown.find((c) => c.key === 'activity'));
  title.width = Math.max(Math.min(rest, title.min ?? 0), Math.floor((rest * 42) / 100));
  activity.width = Math.max(0, rest - title.width);
  return shown;
}

/**
 * One row's cells, styled unless `plain`.
 * @param {Row} row
 * @param {Column[]} cols
 * @param {Theme} t
 * @param {number} now
 * @param {boolean} plain
 */
function rowText(row, cols, t, now, plain) {
  const a = row.agent;
  const dim = over(a.state);
  const style = (/** @type {string} */ s, /** @type {(s: string) => string} */ f) => (plain ? s : f(s));
  const soft = (/** @type {string} */ s) => (plain || !dim ? s : t.dim(s));
  const cells = cols.map((c) => {
    switch (c.key) {
      case 'state':
        return plain ? glyphChar(shown(a), t, now) : glyph(shown(a), t, now);
      case 'title': {
        const prefix = row.prefix;
        const text = fit(prefix + a.title, c.width, 'left', t.ellipsis);
        if (plain || !prefix) return soft(text);
        return t.dim(prefix) + soft(text.slice(prefix.length));
      }
      case 'project':
        return soft(fit(placeOf(a), c.width, 'left', t.ellipsis));
      case 'kind':
        return soft(fit(kindOf(a), c.width, 'left', t.ellipsis));
      case 'model':
        return soft(fit(shortModel(a.model), c.width, 'left', t.ellipsis));
      case 'effort': {
        // Ultracode as a + after the effort, or alone when none is known; the details spell it out.
        const text = fit(a.ultracode ? (a.effort ? `${a.effort}+` : 'ultra') : a.effort ?? '', c.width, 'left', t.ellipsis);
        return a.ultracode && !dim ? style(text, t.magenta) : soft(text);
      }
      case 'ctx':
        return soft(fit(tokens(a.ctx), c.width, 'right'));
      case 'activity':
        return activityCell(a, c.width, t, now, plain);
      case 'last':
        return soft(fit(a.lastActive ? ago(now - a.lastActive) : '', c.width, 'right'));
      case 'pid':
        return soft(fit(a.pid ? String(a.pid) : '', c.width, 'right', t.ellipsis));
      default:
        return '';
    }
  });
  return ' ' + cells.join(' ');
}

/**
 * What the PROJECT column says: a session's folder, a subagent's type, a workflow agent's phase.
 * @param {Agent} a
 */
function placeOf(a) {
  if (a.type === 'session') return a.project ?? '';
  if (a.type === 'workflow') return a.phase ?? '';
  if (a.type === 'agent') return a.phase ?? '';
  return a.agentType ?? '';
}

/** @param {Agent} a */
function kindOf(a) {
  if (a.type === 'session') return a.kind ?? '';
  if (a.type === 'workflow') return 'workflow';
  return a.background ? 'bg agent' : 'agent';
}

/**
 * The activity, colored by kind, after how far its task list has come and with how long it has
 * gone on for live work.
 * @param {Agent} a
 * @param {number} w
 * @param {Theme} t
 * @param {number} now
 * @param {boolean} plain
 */
function activityCell(a, w, t, now, plain) {
  const time = ongoing(a) ? ` ${elapsed(now - a.activityAt)}` : '';
  const steps = progress(a);
  const head = steps && w >= width(steps) + 8 ? `${steps} ` : '';
  const room = Math.max(0, w - width(time) - width(head));
  // An agent that ended says nothing more than its state, unless its last words were read.
  const words = a.activity || (a.type !== 'session' && over(a.state) ? a.state : '');
  const text = room > 0 ? fit(words, room, 'left', t.ellipsis) : '';
  const full = fit(head + text + time, w, 'left', t.ellipsis);
  if (plain) return full;
  const tail = full.slice(head.length + text.length);
  /** @type {(s: string) => string} */
  let paint = (s) => s;
  switch (a.activityKind) {
    case 'waiting':
    case 'blocked': paint = t.yellowBold; break;
    case 'error': paint = t.red; break;
    case 'agents': paint = t.green; break;
    case 'background': paint = t.cyan; break;
    case 'tool': if (a.inTool) paint = t.cyan; break;
    case 'thinking':
    case 'summary':
    case 'reply':
    case 'prompt':
    case 'job':
    case '':
      paint = t.dim; break;
  }
  // A session that ended, blocked, still waits on you.
  if (over(a.state) && a.activityKind !== 'blocked') paint = a.activityKind === 'error' ? t.red : t.dim;
  return t.green(head) + paint(text) + t.dim(tail);
}

/**
 * @typedef {[string, number, Part?]} Part a part of the header, and what it is worth its room (on
 *   a narrow screen the least worth go first); and the part it belongs to, if any, after which it
 *   comes with one space, and without which it goes
 */

/**
 * The counts in the header: sessions by the state their rows show, and agents at work.
 * @param {Snapshot} snap
 * @param {Theme} t
 * @returns {Part[]}
 */
function counts(snap, t) {
  /** @type {Partial<Record<Shown, number>>} */
  const n = {};
  let agents = 0;
  for (const r of snap.rows) {
    n[shown(r)] = (n[shown(r)] ?? 0) + 1;
    for (const c of r.children) {
      if (c.type === 'workflow') agents += c.children.filter((g) => g.state === 'running').length;
      else if (c.state === 'running') agents++;
    }
  }
  /** @type {Part[]} */
  const parts = [];
  if (n.working) parts.push([`${t.green(t.glyphs.working)} ${n.working} working`, 4]);
  if (n.tool) parts.push([`${t.green(t.glyphs.tool)} ${n.tool} in a tool`, 4]);
  if (n.waiting) parts.push([`${t.yellowBold(t.glyphs.waiting)} ${t.yellowBold(`${n.waiting} waiting`)}`, 5]);
  if (n.blocked) parts.push([`${t.yellowBold(t.glyphs.blocked)} ${t.yellowBold(`${n.blocked} blocked`)}`, 5]);
  if (n.unread) parts.push([`${t.blueBold(t.glyphs.unread)} ${n.unread} unread`, 4]);
  if (n.idle) parts.push([`${t.cyan(t.glyphs.idle)} ${n.idle} idle`, 3]);
  if (n.active) parts.push([`${t.blue(t.glyphs.active)} ${n.active} active`, 3]);
  if (n.ended) parts.push([t.dim(`${t.glyphs.ended} ${n.ended} ended`), 2]);
  if (agents) parts.push([`${t.green(String(agents))} agent${agents === 1 ? '' : 's'} at work`, 2]);
  return parts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The desktop app samples the usage about every 15 minutes: one older than this is not fresh. */
const USAGE_FRESH = 45 * MINUTE;

/**
 * The plan's usage in the header, as the desktop app last sampled it: how much of the session's
 * limit and of the week's is used, yellow from 75% and red from 90%, each with when it resets
 * where the samples tell that closely enough, and how long ago they were taken once that is no
 * longer fresh. The session's reset is shown when known within half an hour, to five minutes; the
 * week's to the minute when known within an hour and less than a day off, else by its day when
 * known within half a day. Each goes once it has surely reset since: without a reset known, the
 * session's after five hours and the week's after seven days.
 * @param {import('./usage.js').Usage | undefined} u
 * @param {number} now
 * @param {Theme} t
 * @returns {Part[]}
 */
export function usageParts(u, now, t) {
  if (!u) return [];
  const age = Math.max(0, now - u.at);
  const level = (/** @type {number} */ n) => (n >= 90 ? t.red(`${n}%`) : n >= 75 ? t.yellow(`${n}%`) : `${n}%`);
  /** @type {Part[]} */
  const parts = [];
  /** @param {string} label @param {number} n @param {string | false | undefined} resets */
  const add = (label, n, resets) => {
    /** @type {Part} */
    const part = [`${t.dim(label)} ${level(n)}`, 6];
    parts.push(part);
    if (resets) parts.push([`${t.dim('resets')} ${resets}`, 4, part]);
  };
  const s = u.sessionReset;
  if (u.session !== undefined && now < (s ? s.to : u.at + 5 * HOUR)) {
    add('session', u.session, s && s.to - s.from <= 30 * MINUTE && timeOfDay(Math.round(s.at / (5 * MINUTE)) * 5 * MINUTE));
  }
  const w = u.weekReset;
  if (u.week !== undefined && now < (w ? w.to : u.at + 7 * DAY)) {
    add('week', u.week, w && (w.to - w.from <= HOUR && w.at - now < DAY ? timeOfDay(w.at) : w.to - w.from <= 12 * HOUR && weekday(w.at)));
  }
  if (parts.length && age >= USAGE_FRESH) parts.push([t.dim(`${ago(age)} ago`), 6]);
  return parts;
}

/**
 * The first line of the list and of the table: the title and the sessions counted by state on
 * the left, the plan's usage and the time on the right. Where it is too narrow for all of them
 * the least worth go first: the time, the sessions that ended and the agents at work, the title
 * and the sessions idle or active, those at work and when the limits reset, those that wait for
 * you; the usage last. Of those left out, as many as the room left takes come back, the most
 * worth first. Narrower still, the left as it fits.
 * @param {Snapshot} snap
 * @param {number} cols
 * @param {number} now
 * @param {Theme} t
 * @param {boolean} [time] whether the time is in it
 */
function header(snap, cols, now, t, time = true) {
  /** @type {Part[]} */
  const left = [[t.bold('Claude agents'), 3], ...counts(snap, t)];
  /** @type {Part[]} */
  const right = [...usageParts(snap.usage, now, t), ...(time ? /** @type {Part[]} */ ([[t.dim(clock(now, now)), 1]]) : [])];
  const all = [...left, ...right];
  /** The line of these parts, when they fit. @param {Set<Part>} keep */
  const line = (keep) => {
    /** @param {Part[]} parts */
    const join = (parts) => parts
      .filter((p) => keep.has(p) && (!p[2] || keep.has(p[2])))
      .map(([s, , of], i) => (i ? (of ? ' ' : '  ') : '') + s)
      .join('');
    const l = ` ${join(left)}`;
    const r = join(right);
    return visibleWidth(l) + (r ? visibleWidth(r) + 3 : 0) <= cols ? spread(l, r && `${r} `, cols, t) : undefined;
  };
  for (let worth = 0; worth <= 5; worth++) {
    const keep = new Set(all.filter(([, w]) => w > worth));
    if (!line(keep)) continue;
    for (let w = worth; w >= 1; w--) {
      for (const p of all) if (p[1] === w && line(new Set([...keep, p]))) keep.add(p);
    }
    return /** @type {string} */ (line(keep));
  }
  return t.pad(` ${left.map(([s]) => s).join('  ')}`, cols);
}

/**
 * `left` and `right` on one line of `cols` columns; `right` goes when they do not both fit.
 * @param {string} left styled
 * @param {string} right styled
 * @param {number} cols
 * @param {Theme} t
 */
function spread(left, right, cols, t) {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + rw + 2 > cols) return t.pad(left, cols);
  return left + ' '.repeat(cols - lw - rw) + right;
}

const SGR = /\x1b\[[0-9;]*m/g;
/** @param {string} s */
function visibleWidth(s) {
  return width(s.replace(SGR, ''));
}

/**
 * A styled line cut or padded to `cols` (cutting drops its styles, to stay safe).
 * @param {string} s
 * @param {number} cols
 * @param {string} [ellipsis]
 */
export function padStyled(s, cols, ellipsis = '…') {
  const w = visibleWidth(s);
  if (w > cols) return truncate(s.replace(SGR, ''), cols, ellipsis);
  return s + ' '.repeat(cols - w);
}

/**
 * A styled line wrapped to lines of at most `cols` columns: broken at its spaces, the lines after
 * the first starting after `indent` columns (half the width at most), and a word wider than a
 * line cut where it reaches the end. A no-break space keeps the words on either side of it
 * together, and is drawn as a space. A style goes on across a break: each line closes it, and
 * the next opens it again.
 * @param {string} s styled as the theme styles: a code, the text, and a reset
 * @param {number} cols
 * @param {number} [indent]
 * @returns {string[]}
 */
export function wrapStyled(s, cols, indent = 0) {
  /** @typedef {{ g: string, w: number, code: string }} Cell a grapheme, its width, and its style */
  // The words, each with the spaces before it.
  /** @type {{ gap: Cell[], word: Cell[] }[]} */
  const words = [];
  /** @type {Cell[]} */
  let gap = [];
  /** @type {Cell[]} */
  let word = [];
  let code = '';
  s.split(/(\x1b\[[0-9;]*m)/).forEach((part, i) => {
    if (i % 2) {
      code = /^\x1b\[0?m$/.test(part) ? '' : part.slice(2, -1);
      return;
    }
    for (const [g, w] of graphemes(part)) {
      if (g !== ' ') word.push({ g: g === ' ' ? ' ' : g, w, code });
      else if (!word.length) gap.push({ g, w, code });
      else {
        words.push({ gap, word });
        gap = [{ g, w, code }];
        word = [];
      }
    }
  });
  if (word.length) words.push({ gap, word });
  const lead = Math.min(indent, Math.floor(cols / 2));
  /** @type {Cell[][]} */
  const lines = [];
  /** @type {Cell[]} */
  let line = [];
  let used = 0;
  let empty = true;
  const next = () => {
    lines.push(line);
    line = Array.from({ length: lead }, () => ({ g: ' ', w: 1, code: '' }));
    used = lead;
    empty = true;
  };
  const sum = (/** @type {Cell[]} */ cells) => cells.reduce((n, c) => n + c.w, 0);
  for (const { gap, word } of words) {
    if (!empty && used + sum(gap) + sum(word) > cols) next();
    // The spaces before a word that begins a line go, but for the first line's own.
    if (!empty || !lines.length) {
      line.push(...gap);
      used += sum(gap);
    }
    for (const c of word) {
      if (!empty && used + c.w > cols) next();
      line.push(c);
      used += c.w;
      empty = false;
    }
  }
  lines.push(line);
  const style = (/** @type {string} */ text, /** @type {string} */ code) => (code && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  return lines.map((cells) => {
    let out = '';
    let run = '';
    let at = '';
    for (const c of cells) {
      if (c.code !== at) {
        out += style(run, at);
        run = '';
        at = c.code;
      }
      run += c.g;
    }
    return out + style(run, at);
  });
}

/**
 * The list view: header, column titles, the rows, and the footer.
 * @param {Snapshot} snap
 * @param {Row[]} rows
 * @param {Ui} ui
 * @param {Screen} screen
 * @param {Theme} t
 * @param {Hit[]} [hits] gets where a click goes: the rows, the column titles, the keys
 * @returns {string[]}
 */
export function listLines(snap, rows, ui, { width: cols, height, now }, t, hits = []) {
  const lines = [header(snap, cols, now, t)];
  const cs = columns(cols);
  lines.push(t.dim(t.pad(' ' + cs.map((c) => fit(c.title, c.width, c.align, t.ellipsis)).join(' '), cols)));
  let x = 1;
  for (const c of cs) {
    const sort = COLUMN_SORTS[c.key];
    if (sort) hits.push({ y: 1, x0: x, x1: x + c.width, action: { sort } });
    x += c.width + 1;
  }
  const body = Math.max(0, height - 3);
  if (rows.length === 0) {
    const why = !snap.found
      ? `No Claude Code sessions found in ${snap.dir}.`
      : ui.filter
        ? `Nothing matches "${ui.filter}".`
        : `No Claude agents running or active in the last ${durationLabel(snap.windowMs)}.`;
    for (let i = 0; i < body; i++) lines.push(i === 1 ? t.pad(`   ${t.dim(why)}`, cols) : ' '.repeat(cols));
  }
  for (let i = 0; i < body && rows.length; i++) {
    const row = rows[ui.top + i];
    if (!row) {
      lines.push(' '.repeat(cols));
      continue;
    }
    const selected = ui.index === ui.top + i;
    const text = rowText(row, cs, t, now, selected && t.color);
    lines.push(selected && t.color ? t.inverse(t.pad(text, cols)) : t.pad(selected ? `>${text.slice(1)}` : text, cols));
    hits.push({ y: lines.length - 1, x0: 0, x1: cols, action: { select: row.agent.key } });
  }
  // The last line leaves the last column alone: writing there can scroll some terminals.
  const y = lines.length;
  lines.push(footer(ui, rows, t, cols - 1, now, (hit) => hits.push({ ...hit, y })));
  return lines.slice(0, height);
}

/**
 * Where a click on the footer's keys goes: each label from its column on, pressing its key.
 * @param {[string, string | undefined][]} parts each label and the key a click on it presses,
 *   with two columns between the labels
 * @param {number} x where the first label starts
 * @param {(hit: Omit<Hit, 'y'>) => void} onHit
 */
function keyHits(parts, x, onHit) {
  for (const [label, key] of parts) {
    if (key) onHit({ x0: x, x1: x + width(label), action: { key } });
    x += width(label) + 2;
  }
}

/**
 * The footer: the filter being typed, a message, or the filter in use and the keys, as many of
 * them as fit (the help lists them all).
 * @param {Ui} ui
 * @param {Row[]} rows
 * @param {Theme} t
 * @param {number} cols
 * @param {number} now
 * @param {(hit: Omit<Hit, 'y'>) => void} onHit gets where a click on a key goes
 */
function footer(ui, rows, t, cols, now, onHit) {
  if (ui.editingFilter) {
    // After ' /', the filter and the cursor.
    keyHits([[`${t.enter} keep`, 'enter'], ['esc clear', 'escape']], 2 + width(ui.filter) + 3, onHit);
    return t.pad(` ${t.bold('/')}${ui.filter}${t.inverse(' ')}  ${t.dim(`${t.enter} keep  esc clear`)}`, cols);
  }
  if (ui.message && now < ui.messageUntil) return t.pad(` ${t.yellow(ui.message)}`, cols);
  const pos = rows.length ? `${ui.index + 1}/${rows.length}` : '';
  const filter = ui.filter ? `${t.yellow(`filter "${ui.filter}"`)} ${t.dim('esc clears')}  ` : '';
  // Each key with what it is worth its room (on a narrow screen the least worth go first), and
  // the key a click on it presses. A phone has no keys but these, the filter among them.
  /** @type {[string, number, string | undefined][]} */
  const all = [
    [`${t.arrows} move`, 3, undefined], [`${t.enter} details`, 4, 'enter'], ['/ filter', 4, '/'], [`s sort:${ui.sort}`, 2, 's'],
    [`e ended:${ui.showEnded ? 'on' : 'off'}`, 2, 'e'], [`a agents:${ui.agents}`, 2, 'a'], ['w window', 1, 'w'],
    [`b bell:${ui.bell ? 'on' : 'off'}`, 1, 'b'], ['? help', 5, '?'],
  ];
  // A web page is closed, not quit.
  if (!t.web) all.push(['q quit', 5, 'q']);
  // A space before, two between the keys and the position, and one after it.
  const room = cols - visibleWidth(filter) - width(pos) - 4;
  let shown = all;
  for (let worth = 0; worth <= 5; worth++) {
    shown = all.filter(([, w]) => w > worth);
    if (width(shown.map(([k]) => k).join('  ')) <= room) break;
  }
  if (filter) onHit({ x0: 1, x1: 1 + visibleWidth(filter) - 2, action: { key: 'escape' } });
  keyHits(shown.map(([k, , key]) => [k, key]), 1 + visibleWidth(filter), onHit);
  return spread(` ${filter}${t.dim(shown.map(([k]) => k).join('  '))}`, `${t.dim(pos)} `, cols, t);
}

/**
 * The detail view of one agent: a title line, its fields, its agents, and its latest events,
 * the newest at the bottom (scrolled back by ui.logScroll). A workflow has no events of its
 * own: its agents take the room.
 * @param {Agent} a
 * @param {Snapshot} snap
 * @param {Ui} ui
 * @param {Screen} screen
 * @param {Theme} t
 * @param {Hit[]} [hits] gets where a click goes: its agents, the keys
 * @returns {string[]}
 */
export function detailLines(a, snap, ui, { width: cols, height, now }, t, hits = []) {
  const lines = [];
  // The category of the app's summary of the last turn, but for the usual one.
  const turn = a.turn && a.turn.category !== 'completed' && a.turn.category.replace(/_/g, ' ');
  const status = [a.inTool ? 'in a tool' : a.state, turn, a.unread && 'unread', ongoing(a) && elapsed(now - a.activityAt)].filter(Boolean).join(t.sep);
  lines.push(spread(` ${glyph(shown(a), t, now)} ${t.bold(truncate(a.title, Math.max(10, cols - width(status) - 6), t.ellipsis))}`, `${t.dim(status)} `, cols, t));
  lines.push(t.dim(t.rule.repeat(cols)));

  const body = Math.max(0, height - 3);
  const hasLog = a.type !== 'workflow';
  const top = [...fieldLines(a, now, t, cols)];
  if (a.plan) top.push('', ...planLines(a.plan, hasLog ? Math.max(3, Math.floor((height - 4) / 3)) : body, cols, t));
  /** @type {{ at: number, key: string }[]} the agents' lines in `top` */
  const kidLines = [];
  if (a.children.length) {
    const flows = a.children.filter((c) => c.type === 'workflow').length;
    const running = a.children.filter((c) => c.state === 'running').length;
    const count = (/** @type {number} */ n, /** @type {string} */ what) => (n ? `${n} ${what}${n === 1 ? '' : 's'}` : '');
    const parts = [count(a.children.length - flows, 'agent'), count(flows, 'workflow'), running ? `${running} running` : ''];
    top.push('', ` ${t.bold('Agents')}  ${t.dim(parts.filter(Boolean).join(t.sep))}`);
    const cs = columns(cols).filter((c) => !['pid', 'kind'].includes(c.key));
    // Room for the header and the 'and N more' line.
    const maxKids = hasLog ? Math.max(3, Math.floor((height - 4) / 3)) : Math.max(3, body - top.length - 1);
    const kids = a.children.length > maxKids ? a.children.slice(0, maxKids - 1) : a.children;
    for (const c of kids) {
      kidLines.push({ at: top.length, key: c.key });
      top.push(t.pad(rowText({ agent: c, depth: 1, prefix: '' }, cs, t, now, false), cols));
    }
    if (a.children.length > kids.length) top.push(t.dim(`   and ${a.children.length - kids.length} more`));
  }

  const logRows = hasLog ? Math.max(3, body - top.length - 2) : 0;
  const topRows = hasLog ? Math.max(0, body - logRows - 2) : body;
  for (const k of kidLines) if (k.at < topRows) hits.push({ y: lines.length + k.at, x0: 0, x1: cols, action: { open: k.key } });
  for (const line of top.slice(0, topRows)) lines.push(t.pad(line, cols));
  if (hasLog) {
    lines.push(' '.repeat(cols));
    const events = a.events;
    const maxScroll = Math.max(0, events.length - logRows);
    ui.logScroll = Math.max(0, Math.min(ui.logScroll, maxScroll));
    const end = events.length - ui.logScroll;
    const shown = events.slice(Math.max(0, end - logRows), end);
    const scrolled = ui.logScroll ? t.dim(` (${ui.logScroll} newer below)`) : '';
    const none = events.length ? '' : t.dim(a.transcript ? '  none read yet' : '  no transcript');
    lines.push(t.pad(` ${t.bold('Activity')}${none}${scrolled}`, cols));
    for (const e of shown) lines.push(eventLine(e, cols, now, t));
  }
  while (lines.length < height - 1) lines.push(' '.repeat(cols));
  /** @type {[string, string | undefined][]} */
  const keys = [['esc back', 'escape'], [`${t.arrows} scroll`, undefined], ['home/end', undefined], ['tab next', 'tab']];
  const y = lines.length;
  keyHits(keys, 1, (hit) => hits.push({ ...hit, y }));
  lines.push(t.pad(` ${t.dim(keys.map(([k]) => k).join('  '))}`, cols - 1));
  return lines.slice(0, height);
}

/**
 * A task list: how far it has come, and its steps in `room` lines below that: when they do not
 * all fit, from just before the first one not done, with a line for the steps above (all done)
 * and one for those below.
 * @param {import('./monitor.js').Plan} plan
 * @param {number} room
 * @param {number} cols
 * @param {Theme} t
 */
function planLines(plan, room, cols, t) {
  const steps = plan.steps;
  const n = steps.length;
  const done = steps.filter((s) => s.status === 'completed').length;
  const note = [`${done}/${n} done`, !plan.current && 'in an earlier turn'].filter(Boolean).join(t.sep);
  const lines = [` ${t.bold('Tasks')}  ${t.dim(note)}`];
  let from = 0;
  let to = n;
  if (n > room) {
    const above = (/** @type {number} */ f) => (f > 0 ? 1 : 0);
    const next = steps.findIndex((s) => s.status !== 'completed');
    from = Math.max(0, (next < 0 ? n : next) - 1);
    to = Math.min(n, from + Math.max(1, room - above(from)));
    if (to < n) to = Math.max(from + 1, to - 1);
    // Nothing below: the room left goes to the steps above.
    else while (from > 0 && above(from - 1) + n - from + 1 <= room) from--;
  }
  if (from > 0) lines.push(t.dim(`   ${t.steps.completed} ${from} more done`));
  for (const s of steps.slice(from, to)) {
    const g = t.steps[s.status];
    const text = truncate(s.text, Math.max(0, cols - 6), t.ellipsis);
    if (s.status === 'completed') lines.push(t.dim(`   ${g} ${text}`));
    else if (s.status === 'in_progress') lines.push(`   ${t.green(g)} ${t.bold(text)}`);
    else lines.push(`   ${t.dim(g)} ${text}`);
  }
  if (to < n) lines.push(t.dim(`   and ${n - to} more`));
  return lines;
}

/**
 * The detail view's fields, as ' Label  value' lines.
 * @param {Agent} a
 * @param {number} now
 * @param {Theme} t
 * @param {number} cols
 */
function* fieldLines(a, now, t, cols) {
  const field = (/** @type {string} */ label, /** @type {string | undefined} */ value) =>
    value ? t.pad(` ${t.dim(fit(label, 10))} ${truncate(value, Math.max(0, cols - 13), t.ellipsis)}`, cols) : null;
  const when = (/** @type {number | undefined} */ ts) => (ts ? `${clock(ts, now)} (${ago(now - ts)} ago)` : undefined);
  const join = (/** @type {(string | false | undefined)[]} */ parts) => parts.filter(Boolean).join(t.sep) || undefined;
  const waiting = a.state === 'waiting';
  const blocked = a.activityKind === 'blocked';
  // An activity of the background commands is said by the lines that list them.
  const background = a.activityKind === 'background';
  const lines = [
    field(waiting ? 'Waiting' : ongoing(a) ? 'Doing' : blocked ? 'Blocked' : a.unread ? 'Unread' : 'Last', a.activity && !background
      ? (waiting || blocked ? a.activity.replace(/^(?:waiting|blocked): /, '') : a.activity) + (ongoing(a) ? `  (${elapsed(now - a.activityAt)})` : '')
      : undefined),
    field('Summary', blocked && a.turn?.needs ? a.turn.detail : undefined),
  ];
  if (a.pending.length > 1) {
    for (const p of a.pending.slice(-5)) lines.push(field('', `${p.summary}  (${elapsed(now - p.ts)})`));
  }
  (a.commands ?? []).slice(-5).forEach((c, i) => lines.push(field(i ? '' : 'Background', `${c.summary}  (${elapsed(now - c.ts)})`)));
  if (a.type === 'session') {
    lines.push(
      field('Session', join([a.sessionId, a.kind, a.version && `Claude Code ${a.version}`])),
      field('Resume', a.sessionId && a.state === 'ended' ? `claude --resume ${a.sessionId}, in its folder` : undefined),
      field('Folder', join([a.cwd, a.branch && a.branch !== 'HEAD' && `branch ${a.branch}`])),
      field('Process', a.pid ? join([`pid ${a.pid}`, a.processStartedAt && `up ${elapsed(now - a.processStartedAt)}`, a.memKB && `${Math.round(a.memKB / 1024)} MB`]) : undefined),
      field('Model', join([a.model, a.effort && `effort ${a.effort}`, a.ultracode && 'ultracode', a.permissionMode && `permissions ${a.permissionMode}`])),
      field('Context', join([a.ctx && `${tokens(a.ctx)} tokens`, a.outTokens && `${tokens(a.outTokens)} output tokens in the part read`])),
      field('Totals', a.cost ? join([
        `$${a.cost.usd.toFixed(2)}`,
        `${tokens(a.cost.output)} out`,
        `${tokens(a.cost.input + a.cost.cacheRead + a.cost.cacheWrite)} in`,
        (a.cost.linesAdded || a.cost.linesRemoved) && `+${a.cost.linesAdded} -${a.cost.linesRemoved} lines`,
        'as Claude Code last saved them',
      ]) : undefined),
      field('Started', when(a.startedAt)),
      field('Last', when(a.lastActive)),
      field('Desktop', join([a.hostSessionId, a.openedAt && `last opened ${when(a.openedAt)}`, a.archived && 'archived'])),
      field('Job', a.job ? join([a.job.id, a.job.state, a.job.needs ?? a.job.detail]) : undefined),
    );
  } else {
    lines.push(
      field('Agent', join([a.agentId ?? a.runId, a.type === 'workflow' ? 'workflow' : a.agentType, a.background && 'background', a.phase && `phase ${a.phase}`])),
      field('Agents', a.counts ? join([`${a.counts.total} in all`, `${a.counts.running} running`, `${a.counts.done} done`, a.counts.failed && `${a.counts.failed} failed`]) : undefined),
      field('Model', join([a.model, a.effort && `effort ${a.effort}`])),
      field('Context', join([a.ctx && `${tokens(a.ctx)} tokens`, a.outTokens && `${tokens(a.outTokens)} output tokens`, a.tokens && `${tokens(a.tokens)} tokens in all`])),
      field('Started', when(a.startedAt)),
      field('Last', when(a.lastActive)),
      field('Took', a.durationMs ? elapsed(a.durationMs) : undefined),
    );
  }
  lines.push(field('Transcript', a.transcript && `${a.transcript}${a.transcriptSize ? ` · ${bytes(a.transcriptSize)}` : ''}`));
  for (const l of lines) if (l) yield l;
}

const EVENT_LABEL = { prompt: 'you', reply: 'claude', tool: 'tool', error: 'error', info: 'note' };

/**
 * @param {import('./transcript.js').Event} e
 * @param {number} cols
 * @param {number} now
 * @param {Theme} t
 */
function eventLine(e, cols, now, t) {
  const time = fit(e.ts ? clock(e.ts, now) : '', 12);
  const label = fit(EVENT_LABEL[e.kind] ?? e.kind, 6);
  const text = truncate(e.text, Math.max(0, cols - 22), t.ellipsis);
  const paint = e.kind === 'prompt' ? t.cyan : e.kind === 'error' ? t.red : e.kind === 'tool' ? t.dim : (/** @type {string} */ s) => s;
  return t.pad(` ${t.dim(time)} ${paint(label)} ${e.kind === 'prompt' ? t.bold(text) : text}`, cols);
}

/**
 * The help view: from ui.helpTop on when it is taller than the screen, with the keys that scroll
 * it, and how far down it is, on the last line. Its lines wrap to a screen narrower than 88
 * columns, a phone's, each under the start of what it says.
 * @param {Ui} ui
 * @param {Screen} screen
 * @param {Theme} t
 * @param {string} dir
 * @param {boolean} [mouse] whether the mouse is on
 */
export function helpLines(ui, { width: cols, height }, t, dir, mouse = true) {
  const g = t.glyphs;
  // No wider than 88 columns on a wide screen: two keys and what they do take 87.
  const measure = Math.min(cols, 88);
  const say = (/** @type {string} */ s, indent = 0) => wrapStyled(s, measure, indent);
  // A key and what it does, from column 17; under the key when the key is wider than that.
  const key = (/** @type {string} */ k, /** @type {string} */ what) => (width(k) <= 13
    ? say(`   ${fit(k, 13)} ${what}`, 17)
    : [...say(`   ${k}`, 3), ...say(`${' '.repeat(17)}${what}`, 17)]);
  // Two keys and what they do on one line, when it holds them.
  const pair = (/** @type {string} */ k, /** @type {string} */ what, /** @type {string} */ k2, /** @type {string} */ what2) =>
    (visibleWidth(k) <= 13 && visibleWidth(what) <= 15 && visibleWidth(k2) <= 20 && 54 + visibleWidth(what2) <= measure
      ? [`   ${fit(k, 13)} ${fit(what, 15)} ${fit(k2, 20)} ${what2}`]
      : [...key(k, what), ...key(k2, what2)]);
  // A state's glyph and name, and what it means from column 15.
  const state = (/** @type {string} */ glyph, /** @type {string} */ name, /** @type {string} */ what) => say(`   ${glyph} ${fit(name, 9)} ${what}`, 15);
  const [right, left] = t.ascii ? ['right', 'left'] : ['→', '←'];
  // A no-break space keeps a glyph with its word.
  const nb = ' ';
  const text = [
    ...say(` ${t.bold('agentmonitor')}  the Claude agents on this computer`, 15),
    '',
    ` ${t.bold('Keys')}`,
    ...pair(`${t.arrows} j k`, 'move', 'pgup pgdn home end', 'move by pages'),
    ...pair(`${t.enter} l ${right}`, 'details', `esc h ${left}`, 'back, or clear the filter'),
    ...pair('/', 'filter', 'tab', 'next agent, in details'),
    ...key('s', `sort: status, most recent, name, project${mouse ? ' (or click a title)' : ''}`),
    ...key('e', 'show or hide the sessions that ended'),
    ...key('a', 'agents under their session: running, all, none'),
    ...key('w', 'window for "recently active": 1h, 6h, 24h, 3d, 7d'),
    ...key('b', 'bell on or off: it rings when a session needs you or ends its turn'),
    ...(t.web ? key('r', 'read again') : pair('r', 'read again', 'q ctrl-c', 'quit (q in the details goes back)')),
    ...(mouse ? [
      ...pair('click', 'select a row', 'double-click', 'its details'),
      ...pair('wheel', 'move or scroll', t.web ? 'drag' : 'shift+drag', 'select text'),
      ...(t.web ? key('touch', 'a tap is a click; a drag moves or scrolls') : []),
    ] : []),
    '',
    ` ${t.bold('States')}`,
    ...state(t.green(g.working), 'working', `the session is at work, or ${t.green(g.running)}${nb}an agent runs`),
    ...state(t.green(g.tool), 'tool', 'it waits on a tool call it made: a command, a build, a download'),
    ...state(t.yellowBold(g.waiting), 'waiting', 'it needs you: a permission, a question, a plan to approve'),
    ...state(t.yellowBold(g.blocked), 'blocked', 'its turn ended on something only you can do, the desktop app says'),
    ...state(t.blueBold(g.unread), 'unread', "the desktop app's blue dot: it finished a turn you have not opened"),
    ...state(t.cyan(g.idle), 'idle', 'it runs, and waits for your next message'),
    ...state(t.blue(g.active), 'active', 'its transcript moved moments ago, but no process is known'),
    ...state(t.dim(g.ended), 'ended', `${t.dim(g.done)}${nb}done   ${t.red(g.failed)}${nb}failed   ${t.magenta(g.stopped)}${nb}stopped`),
    '',
    ` ${t.bold('Usage')}`,
    ...key('session', "how much of the plan's limit for five hours is used"),
    ...key('week', `and of its limit for the week: the desktop app's latest sample, taken every 15 minutes or so while it runs; ${t.yellow('yellow')} from 75%, ${t.red('red')} from 90%`),
    ...key('resets', "about when that limit resets, from the app's samples: the week's at the same time each week, the session's five hours after its first use"),
    '',
    ` ${t.bold('Columns')}`,
    ...key('CTX', 'the context of the last reply, in tokens'),
    ...key('EFFORT', `the effort it works at, and a${nb}${t.magenta('+')} when ultracode is on`),
    ...key('LAST', 'how long ago it last did anything'),
    ...key('ACTIVITY', 'what it is doing, with how many of its tasks are done (4/8) and how long the current step has taken'),
    '',
    ...say(` ${t.dim(`Reading ${dir}`)}`, 1),
    ...say(` ${t.dim(`${t.arrows} pgup pgdn home end${mouse ? ' and the wheel' : ''} scroll; any other key${mouse ? ' or a click' : ''} goes back.`)}`, 1),
  ];
  const room = Math.max(0, height - 1);
  ui.helpTop = Math.max(0, Math.min(ui.helpTop, text.length - room));
  const lines = text.slice(ui.helpTop, ui.helpTop + room).map((l) => t.pad(l, cols));
  while (lines.length < room) lines.push(' '.repeat(cols));
  const keys = t.dim(['esc back', `${t.arrows} scroll`, 'home/end'].join('  '));
  const pos = text.length > room ? t.dim(`${ui.helpTop + 1}-${ui.helpTop + room}/${text.length}`) : '';
  lines.push(spread(` ${keys}`, pos && `${pos} `, cols - 1, t));
  return lines.slice(0, height);
}

/**
 * The table --once prints: the same rows as the list, without a selection or footer.
 * @param {Snapshot} snap
 * @param {{ width: number, now: number, agents: AgentsShown, showEnded: boolean }} o
 * @param {Theme} t
 */
export function table(snap, { width: cols, now, agents, showEnded }, t) {
  const ui = { ...initialUi(), agents, showEnded };
  const rows = visibleRows(snap, ui, t);
  const cs = columns(cols);
  const lines = [
    header(snap, cols, now, t, false).trimEnd(),
    t.dim((' ' + cs.map((c) => fit(c.title, c.width, c.align, t.ellipsis)).join(' ')).trimEnd()),
  ];
  for (const row of rows) lines.push(rowText(row, cs, t, now, false).trimEnd());
  if (!rows.length) {
    lines.push(snap.found
      ? `   No Claude agents running or active in the last ${durationLabel(snap.windowMs)}.`
      : `   No Claude Code sessions found in ${snap.dir}.`);
  }
  return lines.join('\n') + '\n';
}
