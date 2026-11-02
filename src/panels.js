// The views of the room below the list's rows that v steps through after the overview: the
// sessions as figures on a floor, as cards on a board, on lanes over the last half hour; their
// tool calls as they come, their workflows' phases, the files they changed; the plan's usage as a
// chart, who used it, what today came to, the session's limit as a tank the replies drip into;
// the sessions on a radar, and one spark for them all. Pure functions of a snapshot and the
// screen's state, as src/view.js's are: those that move do so with the time they are drawn for.
import { Canvas } from './canvas.js';
import { ago, clock, durationLabel, elapsed, fit, graphemes, lastPart, relativeTo, shortModel, timeOfDay, tokens, toolName, truncate, weekday, width } from './format.js';
import { bar, glyph, glyphChar, heading, levelOf, limitsOf, paintOf, placeOf, rate, sessionEnd, shown, statusOf, till, visibleWidth, weekPace } from './view.js';

/**
 * @typedef {import('./monitor.js').Agent} Agent
 * @typedef {import('./monitor.js').Snapshot} Snapshot
 * @typedef {import('./transcript.js').Call} Call
 * @typedef {import('./usage.js').Point} Point
 * @typedef {import('./usage.js').Drop} Drop
 * @typedef {import('./view.js').Ui} Ui
 * @typedef {import('./view.js').Row} Row
 * @typedef {import('./view.js').Screen} Screen
 * @typedef {import('./view.js').Theme} Theme
 * @typedef {import('./view.js').Shown} Shown
 * @typedef {import('./view.js').Limit} Limit
 * @typedef {import('./view.js').Panel} Panel
 * @typedef {import('./view.js').PanelLine} PanelLine
 * @typedef {import('./view.js').Action} Action
 * @typedef {import('./view.js').Spot} Spot
 * @typedef {import('./canvas.js').Style} Style
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SESSION = 5 * HOUR;
/** The states of what is over. */
const OVER = new Set(['ended', 'done', 'failed', 'stopped']);
/** The tools that start an agent: their calls last as long as the agent. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** A tool call that has run this long is waited on (ms), as the list's "in a tool" is. */
const TOOL_WAIT = 3000;
/** A click on a line of a view that names no agent selects none, as one below the rows does. */
const NONE = /** @type {Action} */ ({ unselect: true });
/** An SGR escape, as the theme writes them; and the one that ends a style. */
const SGR = /(\x1b\[[0-9;]*m)/;
const RESET = '\x1b[0m';

/**
 * @typedef {object} View one of the views of the room below the list's rows
 * @property {string} name as v, the footer, the help and --view say it
 * @property {string} what what it shows, as the help says it
 * @property {boolean} animated whether it moves of itself, and so is drawn often
 * @property {Panel} [lines] its lines; none for the overview, which src/view.js draws
 */

/**
 * A view's lines: a blank one first (a click there selects none, as below the rows), its heading,
 * and its body, in `height` lines: cut to them, or with blank lines after.
 * @param {string} title
 * @param {string} right styled, at the heading's end
 * @param {PanelLine[]} body
 * @param {Screen} screen
 * @param {Theme} t
 * @returns {PanelLine[]}
 */
function frame(title, right, body, { width: cols, height }, t) {
  if (height <= 0) return [];
  const blank = { text: ' '.repeat(cols), action: NONE };
  /** @type {PanelLine[]} */
  const out = [blank];
  if (height > 1) out.push({ text: heading(t.bold(title), right, cols, t), action: NONE });
  out.push(...body.slice(0, height - out.length));
  while (out.length < height) out.push(blank);
  return out;
}

/**
 * A styled line in `cols` columns: padded to them, or cut where it reaches them, with an
 * ellipsis, its styles kept (src/view.js's padStyled drops them) and closed where it is cut.
 * The only escapes in it are the theme's: text from the files went through clean().
 * @param {string} s
 * @param {number} cols
 * @param {Theme} t
 */
export function cut(s, cols, t) {
  const w = visibleWidth(s);
  if (w <= cols) return s + ' '.repeat(cols - w);
  const dots = width(t.ellipsis) <= cols ? t.ellipsis : '';
  const room = cols - width(dots);
  let out = '';
  let used = 0;
  let open = false;
  for (const part of s.split(SGR)) {
    if (SGR.test(part)) {
      out += part;
      open = part !== RESET;
      continue;
    }
    for (const [g, gw] of graphemes(part)) {
      if (used + gw > room) return `${out}${open ? RESET : ''}${' '.repeat(room - used)}${dots}`;
      out += g;
      used += gw;
    }
  }
  return out;
}

/**
 * A line of a view in the screen's width, and where a click on it goes.
 * @param {string} text styled
 * @param {number} cols
 * @param {Theme} t
 * @param {Action} [action]
 * @param {Spot[]} [cells]
 * @returns {PanelLine}
 */
function line(text, cols, t, action = NONE, cells) {
  return { text: cut(text, cols, t), action, ...(cells?.length ? { cells } : {}) };
}

/**
 * A canvas's lines as a view's, each with the parts of it a click opens an agent from.
 * @param {Canvas} c
 * @param {Theme} t
 * @param {Map<number, Spot[]>} [spots] by line
 * @returns {PanelLine[]}
 */
function canvasLines(c, t, spots = new Map()) {
  return c.lines(t.ascii).map((text, y) => {
    const cells = spots.get(y);
    return { text, action: NONE, ...(cells?.length ? { cells } : {}) };
  });
}

/**
 * Adds a part of line `y` that a click acts on.
 * @param {Map<number, Spot[]>} spots
 * @param {number} y
 * @param {Spot} s
 */
function spot(spots, y, s) {
  const list = spots.get(y);
  if (list) list.push(s);
  else spots.set(y, [s]);
}

/**
 * The sessions listed, in the list's order.
 * @param {Row[]} rows
 */
const sessionsOf = (rows) => rows.filter((r) => r.depth === 0).map((r) => r.agent);

/**
 * The key of the selected row's session: the row's own, or that of the session it is under.
 * @param {Row[]} rows
 * @param {Ui} ui
 */
function selectedOf(rows, ui) {
  for (let i = Math.min(ui.index, rows.length - 1); i >= 0; i--) if (rows[i].depth === 0) return rows[i].agent.key;
  return undefined;
}

/**
 * A session, its agents, and its workflows' agents.
 * @param {Agent} a
 * @returns {Agent[]}
 */
const everyone = (a) => [a, ...a.children, ...a.children.flatMap((c) => c.children)];

/**
 * What an agent is called in a view: its title, else where it is.
 * @param {Agent} a
 */
const nameOf = (a) => a.title || placeOf(a);

/**
 * Whether an agent is at work: a call of its that has no result yet runs still (in one that is
 * not, it was cut off).
 * @param {Agent} a
 */
const busy = (a) => ['working', 'waiting', 'running', 'active'].includes(a.state);

/**
 * A number for `s`, the same each time: where a figure is in its moves, a blip's bearing.
 * @param {string} s
 */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * '1 file', '3 files'.
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * How long ago, as a phrase: '5m ago', 'just now'.
 * @param {number} ms
 */
const since = (ms) => (ms < SECOND ? 'just now' : `${ago(ms)} ago`);

/**
 * A moment to the minute: 'HH:MM' on the day of `now`, else 'Mon DD HH:MM'.
 * @param {number} ts
 * @param {number} now
 */
const minute = (ts, now) => (new Date(ts).toDateString() === new Date(now).toDateString() ? timeOfDay(ts) : clock(ts, now));

/**
 * `s` in at most `cols` columns, cut at its start: the end of a path says most.
 * @param {string} s
 * @param {number} cols
 * @param {string} ellipsis
 */
function tail(s, cols, ellipsis) {
  if (width(s) <= cols) return s;
  const room = cols - width(ellipsis);
  if (room <= 0) return truncate(s, cols, ellipsis);
  const gs = graphemes(s);
  let out = '';
  let used = 0;
  for (let i = gs.length - 1; i >= 0 && used + gs[i][1] <= room; i--) {
    out = gs[i][0] + out;
    used += gs[i][1];
  }
  return ellipsis + out;
}

/**
 * A tool's short name in at most `cols` columns: an MCP tool's ('server:tool') without its server
 * where both don't fit, as the tools of one server would all be cut alike.
 * @param {string} name
 * @param {number} cols
 * @param {string} ellipsis
 */
function toolIn(name, cols, ellipsis) {
  const s = toolName(name);
  const at = s.indexOf(':');
  return truncate(width(s) > cols && at >= 0 ? s.slice(at + 1) : s, cols, ellipsis);
}

/**
 * How long a tool call took: to a tenth of a second under ten seconds.
 * @param {number} ms
 */
const took = (ms) => (ms < 10 * SECOND ? `${(Math.max(0, ms) / SECOND).toFixed(1)}s` : elapsed(ms));

/**
 * The style of a limit used `v` percent, as levelOf colors it: none under 75.
 * @param {number} v
 * @param {Theme} t
 * @returns {Style | undefined}
 */
const levelStyle = (v, t) => (v >= 90 ? t.red : v >= 75 ? t.yellow : undefined);

/**
 * How many of the sessions are at work, wait for you, and are idle, for a heading; and more.
 * @param {Agent[]} sessions
 * @param {Theme} t
 * @param {(string | false | 0)[]} [more]
 */
function tally(sessions, t, more = []) {
  const n = { work: 0, you: 0, idle: 0 };
  for (const a of sessions) {
    const s = shown(a);
    if (['working', 'running', 'tool', 'active'].includes(s)) n.work++;
    else if (['waiting', 'blocked', 'unread'].includes(s)) n.you++;
    else if (s === 'idle' || s === 'background') n.idle++;
  }
  return t.dim([n.work && `${n.work} at work`, n.you && `${n.you} for you`, n.idle && `${n.idle} idle`, ...more].filter(Boolean).join(t.sep));
}

// The floor ---------------------------------------------------------------------------------

/** The poses of a figure on the floor: frames of three lines of seven columns. */
const POSES = /** @type {Record<string, string[][]>} */ ({
  working: [['   o   ', '  /|_[]', '  / \\  '], ['   o   ', '  /|-[]', '  / \\  ']],
  tool: [['   o   ', '  /|\\  ', '  / \\  '], ['   o   ', '  /|\\  ', '  / |  ']],
  waiting: [['  \\o/  ', '   |   ', '  / \\  '], ['  _o_  ', '   |   ', '  / \\  ']],
  blocked: [['  \\o/  ', '   |   ', '  / \\  ']],
  unread: [['   o []', '  /|/  ', '  / \\  ']],
  background: [['   o   ', '  <|>  ', '  / \\  ']],
  idle: [['       ', '    z  ', ' ___o  '], ['     Z ', '    z  ', ' ___o  '], ['     Z ', '       ', ' ___o  ']],
  active: [['   o   ', '  /|\\  ', '  / \\  ']],
});
/** The pose of each state a row shows. */
const POSE = /** @type {Record<string, string>} */ ({ working: 'working', running: 'working', tool: 'tool', waiting: 'waiting', blocked: 'blocked', unread: 'unread', background: 'background', idle: 'idle', active: 'active' });
/** A figure's lines: what is over its head, itself, its name. */
const FIGURE_LINES = 5;

/**
 * What is over a figure's head: what it runs, waits for, did; dots while it thinks.
 * @param {Agent} a
 * @param {Shown} state
 * @param {number} now
 * @param {Theme} t
 * @returns {{ text: string, style: Style }}
 */
function bubbleOf(a, state, now, t) {
  const what = a.activity.replace(/^(?:waiting|blocked|background): /, '');
  switch (state) {
    case 'working':
    case 'running':
      if (a.activityKind === 'thinking' || !what) return { text: '.'.repeat(1 + (Math.floor(now / 400) % 3)), style: t.dim };
      return { text: what, style: t.dim };
    case 'tool':
      return { text: /^(?:Bash|PowerShell): /.test(what) ? `>_ ${what.replace(/^\w+: /, '')}` : what, style: t.cyan };
    case 'waiting': return { text: `? ${what}`, style: t.yellowBold };
    case 'blocked': return { text: `! ${what}`, style: t.yellowBold };
    case 'unread': return { text: `${t.glyphs.unread} ${what}`, style: t.blueBold };
    case 'background': return { text: `${t.glyphs.background} ${what}`, style: t.cyan };
    case 'active': return { text: '?', style: t.blue };
    default: return { text: '', style: t.dim };
  }
}

/**
 * A session's figure at (x, y), in a cell `w` columns wide: what is over its head, the figure,
 * the agents it started walking beside it and a workflow's in a crowd, and its name.
 * @param {Canvas} c
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {Agent} a
 * @param {boolean} selected
 * @param {number} now
 * @param {Theme} t
 */
function drawFigure(c, x, y, w, a, selected, now, t) {
  const state = shown(a);
  const paint = paintOf(state, t);
  const frames = POSES[POSE[state] ?? 'active'];
  const f = frames[(Math.floor(now / 450) + (hash(a.key) % 5)) % frames.length];
  f.forEach((s, i) => c.put(x, y + 1 + i, s, paint));
  const b = bubbleOf(a, state, now, t);
  if (b.text) c.put(x + 1, y, truncate(b.text, w - 2, t.ellipsis), b.style);
  const kids = a.children.filter((k) => k.state === 'running');
  const walkers = kids.filter((k) => k.type !== 'workflow');
  const flow = kids.find((k) => k.type === 'workflow');
  // The columns beside the figure, from its eighth on.
  const span = w - 10;
  if (span >= 2) {
    // Its agents walk to and fro there, each from where its key puts it.
    for (const k of walkers.slice(0, 3)) {
      const step = Math.floor(now / 250) + (hash(k.key) % (2 * span));
      const p = step % (2 * span);
      const at = x + 8 + (p < span ? p : 2 * span - 1 - p);
      c.put(at, y + 2, 'o', t.green);
      c.put(at, y + 3, step % 2 ? (t.ascii ? '^' : 'Λ') : '|', t.green);
    }
    // A workflow's agents at work stand in a crowd, with how far it has come.
    if (flow?.counts) {
      const k = flow.counts;
      const done = `${k.done + k.failed}/${k.total}`;
      const heads = Math.min(k.running, span - done.length - 1);
      if (heads >= 1) {
        const crowd = Array.from({ length: heads }, (_, i) => ((Math.floor(now / 300) + i) % 3 ? 'o' : 'O')).join('');
        c.put(c.put(x + 8, y + 1, crowd, t.green) + 1, y + 1, done, t.dim);
      } else if (done.length <= span) {
        c.put(x + 8, y + 1, done, t.green);
      }
    } else if (walkers.length > 3) {
      c.put(x + 8, y + 1, `+${walkers.length - 3}`, t.green);
    }
  }
  c.put(x + 1, y + 4, glyphChar(state, t, now), paint);
  c.put(x + 3, y + 4, fit(nameOf(a), w - 4, 'left', t.ellipsis), selected && t.color ? t.inverse : undefined);
  // Without color, the selected one is marked as the list marks its row.
  if (selected && !t.color) c.put(x, y + 4, '>');
}

/**
 * The floor: each session that runs as a figure, posed by what it does: at its keys while it
 * works, tapping its foot with what it runs over its head while a tool call takes a while,
 * waving when it waits for you, holding up a reply you have not read, asleep while idle. The
 * agents it started walk to and fro beside it, and a workflow's agents at work stand in a crowd.
 * Those that ended are named below. A click on a figure opens its details.
 * @type {Panel}
 */
function floorLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const sessions = sessionsOf(rows);
  const live = sessions.filter((a) => !OVER.has(a.state));
  const ended = sessions.filter((a) => OVER.has(a.state));
  const selected = selectedOf(rows, ui);
  const room = Math.max(0, height - 2);
  const w = cols >= 100 ? 20 : cols >= 72 ? 18 : 14;
  const across = Math.max(1, Math.floor((cols - 1) / w));
  // Rows of figures, a line between them.
  const down = Math.floor((room + 1) / (FIGURE_LINES + 1));
  const c = new Canvas(cols, room);
  /** @type {Map<number, Spot[]>} */
  const spots = new Map();
  let y = 0;
  if (down) {
    const fits = across * down;
    const drawn = live.length > fits ? live.slice(0, fits - 1) : live;
    drawn.forEach((a, i) => {
      const x = 1 + (i % across) * w;
      const top = Math.floor(i / across) * (FIGURE_LINES + 1);
      drawFigure(c, x, top, w, a, a.key === selected, now, t);
      for (let k = 0; k < FIGURE_LINES; k++) spot(spots, top + k, { x0: x, x1: x + w, action: { open: a.key } });
    });
    if (drawn.length < live.length) {
      const i = drawn.length;
      c.put(3 + (i % across) * w, Math.floor(i / across) * (FIGURE_LINES + 1) + 2, `+${live.length - i} more`, t.dim);
    }
    y = Math.ceil(Math.min(live.length, fits) / across) * (FIGURE_LINES + 1);
  } else {
    // No room for figures: the sessions on one line.
    let x = 1;
    for (const a of live) {
      const s = shown(a);
      const name = truncate(nameOf(a), 16, t.ellipsis);
      if (x + width(name) + 3 > cols) break;
      c.put(x, 0, glyphChar(s, t, now), paintOf(s, t));
      const end = c.put(x + 2, 0, name, a.key === selected ? t.bold : undefined);
      spot(spots, 0, { x0: x, x1: end, action: { open: a.key } });
      x = end + 2;
    }
    y = live.length ? 1 : 0;
  }
  if (!live.length) {
    c.put(3, 0, 'No session runs now.', t.dim);
    y = 1;
  }
  if (ended.length && y < room) {
    const names = ended.map((a) => `${nameOf(a)} ${since(now - a.lastActive)}`).join(', ');
    c.put(3, y, truncate(`${t.glyphs.ended} ended: ${names}`, cols - 4, t.ellipsis), t.dim);
  }
  return frame('Floor', tally(sessions, t), canvasLines(c, t, spots), screen, t);
}

// The board ---------------------------------------------------------------------------------

/** The board's columns, and the states each takes. */
const BOARD = [
  { name: 'Needs you', states: ['waiting', 'blocked', 'unread'] },
  { name: 'Working', states: ['working', 'running', 'tool', 'active'] },
  { name: 'Background', states: ['background'] },
  { name: 'Idle', states: ['idle'] },
  { name: 'Ended', states: ['ended', 'done', 'failed', 'stopped'] },
];
/** How long a card that moved stands out in its new column, and leaves a ghost in its old (ms). */
export const MOVED = 4000;

/**
 * The column of the board a session is in, by the state its row shows.
 * @param {Agent} a
 */
export function boardColumn(a) {
  const s = shown(a);
  return (BOARD.find((c) => c.states.includes(s)) ?? BOARD[3]).name;
}

/**
 * The board: the sessions as cards in columns: what needs you, what works, what waits on what it
 * left running, what is idle, and on a wide screen what ended. A card that moved lately stands
 * out, with where it came from, and leaves a ghost where it was. On a narrow screen the columns
 * are one under another. A click on a card opens its details.
 * @type {Panel}
 */
function boardLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const sessions = sessionsOf(rows);
  const selected = selectedOf(rows, ui);
  const room = Math.max(0, height - 2);
  const ended = sessions.filter((a) => boardColumn(a) === 'Ended').length;
  const columns = BOARD.filter((c) => c.name !== 'Ended' || (ended && cols >= 100));
  const listed = new Map(sessions.map((a) => [a.key, a]));
  /** Where a card moved from lately, if it did. @param {Agent} a */
  const moved = (a) => {
    const m = ui.moves.get(a.key);
    return m && now - m.at < MOVED && m.to === boardColumn(a) ? m : undefined;
  };
  /** The cards that left a column lately. @param {string} name @returns {Agent[]} */
  const ghosts = (name) => [...ui.moves].flatMap(([k, m]) => {
    const a = m.from === name && now - m.at < MOVED ? listed.get(k) : undefined;
    return a ? [a] : [];
  });
  const ghost = t.ascii ? '~' : '┄';
  const right = tally(sessions, t, [ended > 0 && !columns.some((c) => c.name === 'Ended') && `${ended} ended`]);
  if (cols < 64) {
    // The columns one under another.
    /** @type {PanelLine[]} */
    const body = [];
    for (const col of columns) {
      const cards = sessions.filter((a) => boardColumn(a) === col.name);
      const gone = ghosts(col.name);
      if (!cards.length && !gone.length) continue;
      body.push(line(` ${t.bold(col.name)} ${t.dim(String(cards.length))}`, cols, t));
      for (const a of cards) {
        const s = shown(a);
        const m = moved(a);
        const what = m ? `from ${m.from}` : statusOf(a, now, t);
        const title = truncate(nameOf(a), Math.max(8, cols - width(what) - 7), t.ellipsis);
        const text = a.key === selected && t.color
          ? t.inverse(cut(`  ${glyphChar(s, t, now)} ${title}  ${what}`, cols, t))
          : `${a.key === selected ? '>' : ' '} ${glyph(s, t, now)} ${m ? t.bold(title) : title}  ${m ? t.yellow(what) : t.dim(what)}`;
        body.push(line(text, cols, t, { open: a.key }));
      }
      for (const a of gone) body.push(line(t.dim(`  ${ghost} ${nameOf(a)}`), cols, t));
    }
    if (!body.length) body.push(line(t.dim('   No sessions listed.'), cols, t));
    return frame('Board', right, body, screen, t);
  }
  const n = columns.length;
  const cw = Math.floor((cols - 1 - (n - 1)) / n);
  const c = new Canvas(cols, room);
  /** @type {Map<number, Spot[]>} */
  const spots = new Map();
  columns.forEach((col, j) => {
    const x = 1 + j * (cw + 1);
    const cards = sessions.filter((a) => boardColumn(a) === col.name);
    const gone = ghosts(col.name);
    c.put(c.put(x, 0, truncate(col.name, cw - 3, t.ellipsis), t.bold) + 1, 0, String(cards.length), t.dim);
    c.put(x, 1, t.rule.repeat(cw), t.dim);
    // A line between the cards when they all fit with one.
    const gap = 2 + 3 * cards.length + gone.length <= room ? 1 : 0;
    let y = 2;
    let i = 0;
    for (; i < cards.length; i++) {
      // Room for the card, and for '+N more' when cards are left after it.
      if (y + 2 + (i < cards.length - 1 ? 1 : 0) > room) break;
      const a = cards[i];
      const s = shown(a);
      const m = moved(a);
      const chosen = a.key === selected;
      // Without color, the selected card is marked as the list marks its row.
      c.put(x, y, chosen && !t.color ? '>' : m ? (t.ascii ? '>' : '▸') : ' ', t.yellow);
      c.put(x + 1, y, glyphChar(s, t, now), paintOf(s, t));
      c.put(x + 3, y, fit(nameOf(a), cw - 3, 'left', t.ellipsis), chosen && t.color ? t.inverse : m ? t.bold : undefined);
      c.put(x + 3, y + 1, truncate(m ? `from ${m.from}` : a.activity || statusOf(a, now, t), cw - 3, t.ellipsis), m ? t.yellow : t.dim);
      spot(spots, y, { x0: x, x1: x + cw, action: { open: a.key } });
      spot(spots, y + 1, { x0: x, x1: x + cw, action: { open: a.key } });
      y += 2 + gap;
    }
    if (i < cards.length && y < room) c.put(x + 3, y++, `+${cards.length - i} more`, t.dim);
    for (const a of gone) if (y < room) c.put(x + 1, y++, truncate(`${ghost} ${nameOf(a)}`, cw - 1, t.ellipsis), t.dim);
  });
  return frame('Board', right, canvasLines(c, t, spots), screen, t);
}

// The lanes ---------------------------------------------------------------------------------

/** The time of a lane's column: the shortest of these that shows half an hour at least. */
const LANE_STEPS = [10, 30, 60, 120, 300, 600].map((s) => s * SECOND);
/** The times marked under the lanes: the shortest of these a dozen columns apart at least. */
const LANE_TICKS = [5, 10, 15, 30, 60, 120, 240].map((m) => m * MINUTE);
/**
 * What a column of a lane shows, the larger the more it is worth: nothing known, idle, at work,
 * in a tool, waiting on you, your prompt.
 */
const LANE = { none: 0, idle: 1, work: 2, tool: 3, wait: 4, you: 5 };

/**
 * What each of a lane's `n` columns of `step` from `start` shows (LANE): the most worth of what
 * its session did then.
 * @param {Agent} a
 * @param {number} start
 * @param {number} step
 * @param {number} n
 * @param {number} now
 */
export function laneOf(a, start, step, n, now) {
  const kinds = new Uint8Array(n);
  /** @param {number} from @param {number} to @param {number} kind */
  const mark = (from, to, kind) => {
    const i0 = Math.max(0, Math.floor((from - start) / step));
    const i1 = Math.min(n - 1, Math.floor((Math.min(to, now) - start) / step));
    for (let i = i0; i <= i1; i++) if (kinds[i] < kind) kinds[i] = kind;
  };
  // What is open goes on till now; in a session not at work, it ended with its last record.
  const last = busy(a) ? now : a.lastActive;
  const known = Math.min(a.turns?.[0]?.start ?? Infinity, a.calls?.[0]?.ts ?? Infinity, a.events[0]?.ts || Infinity);
  if (known < Infinity) mark(known, a.live ? now : a.lastActive, LANE.idle);
  for (const s of a.turns ?? []) mark(s.start, s.end || last, LANE.work);
  for (const c of a.calls ?? []) {
    const end = c.end || last;
    if (c.asks) mark(c.ts, end, LANE.wait);
    else if (!AGENT_TOOLS.has(c.name) && end - c.ts >= TOOL_WAIT) mark(c.ts, end, LANE.tool);
  }
  if (a.state === 'waiting') mark(a.activityAt || a.lastActive, now, LANE.wait);
  for (const e of a.events) if (e.kind === 'prompt' && e.ts) mark(e.ts, e.ts, LANE.you);
  return kinds;
}

/**
 * The lanes: one for each session listed, over the last half hour or more, a column for each 10
 * seconds to 10 minutes as the width takes: when it was at work (its turns), in a tool (a call
 * that ran 3 seconds or more), waiting on you (a question, a plan, a session offered; the
 * desktop app's permission prompts are in no file, but a session waiting now is), and your
 * prompts; the times below. A click on a lane opens its session's details.
 * @type {Panel}
 */
function lanesLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const sessions = sessionsOf(rows);
  const selected = selectedOf(rows, ui);
  const room = Math.max(0, height - 2);
  const label = cols >= 72 ? 18 : 12;
  const n = Math.max(1, cols - label - 1);
  const step = LANE_STEPS.find((s) => s * n >= 30 * MINUTE) ?? LANE_STEPS[LANE_STEPS.length - 1];
  const end = (Math.floor(now / step) + 1) * step;
  const start = end - n * step;
  const glyphs = t.ascii ? [' ', '.', '#', '%', '?', '^'] : [' ', '·', '█', '▒', '?', '▲'];
  /** @type {(Style | undefined)[]} */
  const styles = [undefined, t.dim, t.green, t.cyan, t.yellowBold, t.bold];
  // A line left for the times.
  const lanes = sessions.slice(0, Math.max(0, room - 1));
  /** @type {PanelLine[]} */
  const body = lanes.map((a) => {
    const kinds = laneOf(a, start, step, n, now);
    let text = '';
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && kinds[j] === kinds[i]) j++;
      const run = glyphs[kinds[i]].repeat(j - i);
      const style = styles[kinds[i]];
      text += style ? style(run) : run;
      i = j;
    }
    const name = fit(nameOf(a), label - 4, 'left', t.ellipsis);
    const chosen = a.key === selected;
    const head = `${chosen && !t.color ? '>' : ' '}${glyph(shown(a), t, now)} ${chosen && t.color ? t.inverse(name) : name} `;
    return line(head + text, cols, t, { open: a.key });
  });
  if (!sessions.length) body.push(line(t.dim('   No sessions listed.'), cols, t));
  else {
    // The times on the marks, and now at the end, which goes first.
    const tick = LANE_TICKS.find((k) => k / step >= 12) ?? LANE_TICKS[LANE_TICKS.length - 1];
    const axis = new Canvas(cols, 1);
    const nowX = Math.max(label, label + Math.floor((now - start) / step) - 2);
    axis.put(nowX, 0, 'now', t.dim);
    let free = nowX - 1;
    for (let at = Math.floor(now / tick) * tick; at >= start; at -= tick) {
      const x = label + Math.floor((at - start) / step);
      const text = timeOfDay(at);
      if (x < label || x + text.length >= free) continue;
      axis.put(x, 0, t.ascii ? '|' : '╵', t.dim);
      axis.put(x + 1, 0, text, t.dim);
      free = x - 1;
    }
    if (sessions.length > lanes.length) axis.put(1, 0, `+${sessions.length - lanes.length} more`, t.dim);
    body.push({ text: axis.lines(t.ascii)[0], action: NONE });
  }
  /** @param {number} k @param {string} what */
  const key = (k, what) => `${/** @type {Style} */ (styles[k])(glyphs[k])} ${t.dim(what)}`;
  const every = t.dim(`each ${durationLabel(step)}`);
  const legend = [key(LANE.work, 'at work'), key(LANE.tool, 'in a tool'), key(LANE.wait, 'waits on you'), key(LANE.you, 'you')].join('  ');
  return frame('Lanes', cols >= 90 ? `${legend}  ${every}` : every, body, screen, t);
}

// The ticker --------------------------------------------------------------------------------

/**
 * The tool calls: every one the sessions listed and their agents made, as it comes: the open ones
 * first, the oldest at the top, with how long they have run; then the others, the latest first,
 * with how long they took and whether they failed. A click on one opens the session or the agent
 * that made it.
 * @type {Panel}
 */
function tickerLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  /** @type {{ s: Agent, a: Agent, c: Call }[]} */
  const items = [];
  for (const s of sessionsOf(rows)) for (const a of everyone(s)) for (const c of a.calls ?? []) items.push({ s, a, c });
  const open = items.filter((i) => !i.c.end && busy(i.a)).sort((x, y) => x.c.ts - y.c.ts);
  const done = items.filter((i) => i.c.end).sort((x, y) => y.c.end - x.c.end);
  const recent = done.filter((i) => i.c.end >= now - 10 * MINUTE).length;
  const today = new Date(now).toDateString();
  const tw = cols >= 60 ? 10 : 0;
  const where = cols >= 100 ? 18 : cols >= 72 ? 14 : 10;
  const name = cols >= 72 ? 12 : 8;
  const statusW = 10;
  // The columns left for what a call works on: a space before each part, and one at the end.
  const rest = Math.max(0, cols - 1 - tw - where - name - statusW - 4);
  /** @type {PanelLine[]} */
  const body = [...open, ...done].slice(0, room).map(({ s, a, c }) => {
    const tool = toolName(c.name);
    const what = c.summary.startsWith(`${tool}: `) ? c.summary.slice(tool.length + 2) : c.summary;
    const place = a === s ? nameOf(s) : `${t.ascii ? '>' : '↳'} ${nameOf(a)}`;
    const status = !c.end
      ? c.asks ? t.yellowBold(`${t.glyphs.waiting} ${elapsed(now - c.ts)}`) : t.green(`${glyphChar('tool', t, now)} ${elapsed(now - c.ts)}`)
      : c.error ? t.red(`${t.glyphs.failed} ${took(c.end - c.ts)}`) : t.dim(`${t.glyphs.done} ${took(c.end - c.ts)}`);
    const when = new Date(c.ts).toDateString() === today ? clock(c.ts, now) : `${weekday(c.ts)} ${timeOfDay(c.ts)}`;
    const time = tw ? `${t.dim(fit(when, tw - 1))} ` : '';
    const text = ` ${time}${fit(place, where, 'left', t.ellipsis)} ${t.bold(fit(toolIn(c.name, name, t.ellipsis), name))} ${fit(what, rest, 'left', t.ellipsis)} ${status}`;
    return line(text, cols, t, { open: a.key });
  });
  if (!body.length) body.push(line(t.dim('   No tool calls in what was read of the sessions listed.'), cols, t));
  const right = [open.length && `${open.length} open`, `${recent} in the last 10m`].filter(Boolean).join(t.sep);
  return frame('Tool calls', t.dim(right), body, screen, t);
}

// The pipeline ------------------------------------------------------------------------------

/**
 * An agent's mark in a pipeline: a spinner while it runs (each a step on from the one before),
 * else done, failed, stopped or ended.
 * @param {Agent} a
 * @param {number} i
 * @param {number} now
 * @param {Theme} t
 */
function markOf(a, i, now, t) {
  if (a.state === 'running') return t.green(t.spinner[(Math.floor(now / 100) + i) % t.spinner.length]);
  return paintOf(a.state, t)(t.glyphs[a.state] ?? t.glyphs.ended);
}

/**
 * Agents as marks, the earliest first, in `room` columns: those left out counted at the end.
 * @param {Agent[]} agents
 * @param {number} room
 * @param {number} now
 * @param {Theme} t
 */
function marks(agents, room, now, t) {
  const sorted = [...agents].sort((a, b) => (a.startedAt ?? a.lastActive) - (b.startedAt ?? b.lastActive));
  const listed = sorted.length > room ? sorted.slice(0, Math.max(0, room - 5)) : sorted;
  const more = sorted.length - listed.length;
  return cut(listed.map((a, i) => markOf(a, i, now, t)).join('') + (more ? t.dim(` +${more}`) : ''), room, t);
}

/**
 * How many of a workflow's or a phase's agents run, are done and failed, colored.
 * @param {Agent[]} agents
 * @param {Theme} t
 */
function counted(agents, t) {
  const n = (/** @type {string} */ state) => agents.filter((a) => a.state === state).length;
  return [n('running') && t.green(`${n('running')} running`), n('done') && t.dim(`${n('done')} done`), n('failed') && t.red(`${n('failed')} failed`)].filter(Boolean).join(t.dim(', '));
}

/**
 * The pipeline: each workflow the sessions listed ran, those at work first, with its phases in
 * the order they began, each agent in them a mark: at work, done, failed; and how many and how
 * long. Below, the sessions' own agents. A click on a workflow's lines opens it; on an agent's
 * line, the one at work, else its session.
 * @type {Panel}
 */
function pipelineLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const sessions = sessionsOf(rows);
  const flows = sessions
    .flatMap((s) => s.children.filter((c) => c.type === 'workflow').map((w) => ({ s, w })))
    .sort((x, y) => Number(y.w.state === 'running') - Number(x.w.state === 'running') || y.w.lastActive - x.w.lastActive);
  const agents = sessions.map((s) => ({ s, kids: s.children.filter((c) => c.type === 'subagent') })).filter((x) => x.kids.length);
  const label = cols >= 72 ? 14 : 10;
  // The marks' columns: as many as the most agents in a phase or a session, as the width allows.
  const most = Math.max(1, ...flows.flatMap(({ w }) => [...Map.groupBy(w.children, (a) => a.phase ?? '').values()].map((l) => l.length)), ...agents.map((x) => x.kids.length));
  const room = Math.max(6, Math.min(most + 1, Math.floor(cols / 2) - label));
  /** @type {PanelLine[]} */
  const body = [];
  for (const { s, w } of flows) {
    const k = w.counts ?? { running: 0, done: 0, failed: 0, total: w.children.length };
    const time = w.state === 'running' ? (w.startedAt ? elapsed(now - w.startedAt) : '') : w.durationMs ? elapsed(w.durationMs) : '';
    const parts = [`${k.done}/${k.total} done`, k.running && t.green(`${k.running} running`), k.failed && t.red(`${k.failed} failed`), time && t.dim(time)].filter(Boolean);
    const title = truncate(w.title, Math.max(12, Math.floor(cols / 3)), t.ellipsis);
    body.push(line(` ${glyph(w.state, t, now)} ${t.bold(title)}  ${parts.join(t.dim(t.sep))}  ${t.dim(nameOf(s))}`, cols, t, { open: w.key }));
    const first = (/** @type {Agent[]} */ list) => Math.min(...list.map((a) => a.startedAt ?? a.lastActive));
    const phases = [...Map.groupBy(w.children, (a) => a.phase ?? '')].sort((x, y) => first(x[1]) - first(y[1]));
    for (const [phase, list] of phases) {
      body.push(line(`    ${t.dim(fit(phase || 'agents', label, 'left', t.ellipsis))} ${marks(list, room, now, t)} ${counted(list, t)}`, cols, t, { open: w.key }));
    }
  }
  if (agents.length) {
    if (body.length) body.push(line('', cols, t));
    body.push(line(` ${t.bold('Agents')}`, cols, t));
    for (const { s, kids } of agents) {
      const at = kids.filter((k) => k.state === 'running');
      const what = at.length ? at.map((k) => k.title).join(', ') : `the last ${since(now - Math.max(...kids.map((k) => k.lastActive)))}`;
      body.push(line(`    ${fit(nameOf(s), label, 'left', t.ellipsis)} ${marks(kids, room, now, t)} ${t.dim(what)}`, cols, t, { open: at[0]?.key ?? s.key }));
    }
  }
  if (!body.length) body.push(line(t.dim('   No workflows or agents in the sessions listed.'), cols, t));
  const running = flows.filter((f) => f.w.state === 'running').length;
  return frame('Pipeline', t.dim([count(flows.length, 'workflow'), running && `${running} running`].filter(Boolean).join(t.sep)), body, screen, t);
}

// The files ---------------------------------------------------------------------------------

/**
 * A path as paths are compared: a Windows one in one case, its separators made one.
 * @param {string} p
 */
const pathKey = (p) => (/^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') ? p.replace(/\\/g, '/').toLowerCase() : p);

/**
 * The files: those the sessions listed and their agents changed in the last hour (an edit, a
 * write), the latest first, with how often, by which session and when; one being changed now
 * marked, and one that two sessions or more changed flagged, with their names. A click on a file
 * opens the session that changed it last.
 * @type {Panel}
 */
function filesLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  /** @type {Map<string, { shownAs: string, n: number, last: number, open: boolean, by: Map<string, Agent>, lastBy: Agent }>} */
  const files = new Map();
  for (const s of sessionsOf(rows)) {
    for (const a of everyone(s)) {
      for (const c of a.calls ?? []) {
        if (!c.file || (c.end && c.error) || (c.end || now) < now - HOUR || (!c.end && !busy(a))) continue;
        const key = pathKey(c.file);
        let f = files.get(key);
        if (!f) files.set(key, (f = { shownAs: relativeTo(c.file, s.cwd), n: 0, last: 0, open: false, by: new Map(), lastBy: s }));
        if (c.end) f.n++;
        else f.open = true;
        if ((c.end || c.ts) >= f.last) {
          f.last = c.end || c.ts;
          f.lastBy = s;
        }
        f.by.set(s.key, s);
      }
    }
  }
  const list = [...files.values()].sort((a, b) => b.last - a.last);
  const shared = list.filter((f) => f.by.size > 1).length;
  const ww = cols >= 100 ? 18 : 12;
  // The path's columns, leaving room after the others for the sessions when two changed a file.
  const pw = Math.max(12, Math.min(48, cols - ww - 40));
  const room2 = cols - pw - ww - 21;
  /** @type {PanelLine[]} */
  const body = list.slice(0, room).map((f) => {
    const many = f.by.size > 1;
    const mark = many ? t.yellowBold('!') : f.open ? t.green(t.ascii ? '*' : '✎') : ' ';
    const who = many ? t.yellow(fit(`${f.by.size} sessions`, ww)) : fit(nameOf(f.lastBy), ww, 'left', t.ellipsis);
    const n = f.n ? count(f.n, 'edit') : 'editing';
    const also = many && room2 > 4 ? `  ${t.yellow(truncate([...f.by.values()].map(nameOf).join(', '), room2, t.ellipsis))}` : '';
    return line(` ${mark} ${fit(tail(f.shownAs, pw, t.ellipsis), pw)} ${who} ${t.dim(fit(n, 8))} ${t.dim(fit(ago(now - f.last), 4, 'right'))}${also}`, cols, t, { open: f.lastBy.key });
  });
  if (!body.length) body.push(line(t.dim('   No file changed in the last hour, in what was read of the sessions listed.'), cols, t));
  const sessions = new Set(list.flatMap((f) => [...f.by.keys()])).size;
  const right = [count(list.length, 'file'), sessions && `by ${count(sessions, 'session')}`, shared && t.yellow(`${shared} by more than one`)].filter(Boolean).join(t.dim(t.sep));
  return frame('Files changed in the last hour', t.dim(right), body, screen, t);
}

// The chart ---------------------------------------------------------------------------------

/**
 * A limit's percent from `from` to `to`, on `h` lines of a canvas from line `y`: its samples as
 * a line (broken where the app did not sample), carried on from the last to now (dotted), and on
 * from now at its pace (more dotted, yellow when it reaches 100% first), under a line at 100%;
 * the percents on the left, and the times on the line below.
 * @param {Canvas} c
 * @param {number} y
 * @param {number} h
 * @param {Point[]} points
 * @param {{ from: number, to: number, now: number, v?: number, pace?: number, unit: number, days: boolean }} o
 * @param {Theme} t
 */
function plot(c, y, h, points, { from, to, now, v, pace, unit, days }, t) {
  const left = 5;
  const w = Math.max(2, c.w - left - 1);
  const X = (/** @type {number} */ time) => 2 * left + ((Math.max(from, Math.min(to, time)) - from) / (to - from)) * (2 * w - 1);
  const Y = (/** @type {number} */ p) => 4 * y + (1 - Math.max(0, Math.min(100, p)) / 100) * (4 * h - 1);
  c.line(X(from), Y(100), X(to), Y(100), t.dim, 3);
  /** @type {[number, number] | undefined} */
  let prev;
  let prevT = 0;
  for (const p of points) {
    if (p.t < from || p.t > now) continue;
    /** @type {[number, number]} */
    const at = [X(p.t), Y(p.v)];
    const style = levelStyle(p.v, t);
    if (prev && p.t - prevT <= 45 * MINUTE) c.line(prev[0], prev[1], at[0], at[1], style);
    else c.dot(at[0], at[1], style);
    prev = at;
    prevT = p.t;
  }
  if (v !== undefined) {
    if (prev) c.line(prev[0], prev[1], X(now), Y(v), t.cyan, 2);
    else c.dot(X(now), Y(v), t.cyan);
    if (pace !== undefined && pace > 0 && to > now) {
      const full = now + ((100 - v) / pace) * unit;
      const end = Math.min(to, full);
      c.line(X(now), Y(v), X(end), Y(v + (pace * (end - now)) / unit), full <= to ? t.yellow : t.dim, 3);
    }
  }
  c.put(0, y, '100%', t.dim);
  if (h >= 3) c.put(0, y + Math.round((h - 1) / 2), ' 50%', t.dim);
  c.put(0, y + h - 1, '  0%', t.dim);
  // The times below: each day's start, or the start and the end; now first, the others where
  // they fit.
  const ty = y + h;
  const xs = (/** @type {number} */ time) => Math.floor(X(time) / 2);
  /** @type {[number, string][]} */
  const marks = [];
  if (days) {
    const tick = t.ascii ? '|' : '╵';
    for (let d = new Date(from).setHours(24, 0, 0, 0); d < to; d = new Date(d).setHours(24, 0, 0, 0)) marks.push([xs(d), `${tick}${weekday(d)}`]);
  } else {
    marks.push([left, timeOfDay(from)], [c.w - 6, timeOfDay(to)]);
  }
  const nowX = now > from && now < to ? Math.min(c.w - 5, Math.max(left, xs(now))) : -1;
  if (nowX >= 0) c.put(nowX, ty, `${t.ascii ? '^' : '▴'}now`, t.cyan);
  let free = 0;
  for (const [x, text] of marks) {
    if (x < free || (nowX >= 0 && x <= nowX + 4 && x + width(text) >= nowX)) continue;
    free = c.put(x, ty, text, t.dim) + 1;
  }
}

/**
 * When in the day the session's limit was used over the last seven days: a line for each, a
 * column for each hour, shaded by how many points the samples rose in it.
 * @param {Canvas} c
 * @param {number} y
 * @param {Point[]} points
 * @param {number} now
 * @param {Theme} t
 */
function heat(c, y, points, now, t) {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - 6 + i);
    return d.getTime();
  });
  const sums = days.map(() => new Array(24).fill(0));
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (b.v <= a.v || b.t - a.t > 30 * MINUTE || b.t < days[0] || b.t > now) continue;
    const d = days.findLastIndex((s) => s <= b.t);
    if (d >= 0) sums[d][new Date(b.t).getHours()] += b.v - a.v;
  }
  const most = Math.max(1, ...sums.flat());
  const shades = t.ascii ? [' ', '.', ':', '+', '#'] : [' ', '░', '▒', '▓', '█'];
  const hw = c.w >= 60 ? 2 : 1;
  const hour = new Date(now).getHours();
  c.put(1, y, 'hour', t.dim);
  for (const h of [0, 6, 12, 18]) c.put(6 + h * hw, y, String(h), t.dim);
  days.forEach((d, i) => {
    c.put(1, y + 1 + i, weekday(d), d === today ? t.bold : t.dim);
    // Today's hours to come are left blank.
    for (let h = 0; h < (d === today ? hour + 1 : 24); h++) {
      const v = sums[i][h];
      const k = v ? Math.max(1, Math.min(4, Math.ceil((v / most) * 4))) : 0;
      if (k) c.put(6 + h * hw, y + 1 + i, shades[k].repeat(hw), t.green);
      else c.put(6 + h * hw, y + 1 + i, t.ascii ? '.' : '·', t.dim);
    }
  });
}

/**
 * The chart: the session's limit over its window of five hours and the week's over its seven
 * days, each with its samples, carried on to now, and at its pace on to its reset; on a tall
 * screen, when in the day the session's was used over the last week.
 * @type {Panel}
 */
function chartLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const u = snap.usage;
  if (!u?.history) return frame('Usage', '', [line(t.dim('   No usage known: the desktop app samples it while it runs.'), cols, t)], screen, t);
  const { session, week } = limitsOf(u, now);
  const c = new Canvas(cols, room);
  // Each chart a title, its lines and its times; and below them the hours, where it is tall.
  const withHeat = room >= 26;
  const both = room >= 12;
  const h = Math.max(2, Math.min(10, Math.floor(((withHeat ? room - 9 : room) - (both ? 4 : 2)) / (both ? 2 : 1))));
  let y = 0;
  /** @param {string} label @param {Limit | undefined} l @param {string} said */
  const title = (label, l, said) => {
    c.put(1, y, label, t.bold);
    if (l) c.put(9, y, `${l.near ? '~' : ''}${l.v}%`, levelStyle(l.v, t));
    if (said) c.put(16, y, said, t.dim);
    y++;
  };
  const sEnd = sessionEnd(session?.reset) ?? session?.reset?.at;
  const sFrom = sEnd ? sEnd - SESSION : now - 4 * HOUR;
  const sTo = sEnd ?? now + HOUR;
  // A plan can have no session's limit: the app's checks leave it out then.
  const sSaid = u.session === undefined ? ['not in the last check'] : [sEnd && `resets ${timeOfDay(sEnd)}, in ${till(Math.max(0, sEnd - now))}`, session?.pace !== undefined && rate(session.pace, 'h')];
  title('session', session, sSaid.filter(Boolean).join(t.sep));
  plot(c, y, h, u.history.session, { from: sFrom, to: sTo, now, v: session?.v, pace: session?.pace, unit: HOUR, days: false }, t);
  y += h + 1;
  if (both) {
    const r = week?.reset;
    const wEnd = r && r.to - r.from <= 12 * HOUR ? r.at : undefined;
    const wFrom = wEnd ? wEnd - WEEK : now - 6 * DAY;
    const pace = week && wEnd ? weekPace(u, week, wEnd, now) : undefined;
    title('week', week, [wEnd && `resets ${weekday(wEnd)} ${timeOfDay(wEnd)}`, pace !== undefined && rate(pace, 'd')].filter(Boolean).join(t.sep));
    plot(c, y, h, u.history.week, { from: wFrom, to: wEnd ?? now + DAY, now, v: week?.v, pace, unit: DAY, days: true }, t);
    y += h + 1;
  }
  if (withHeat && y + 9 <= room) heat(c, y + 1, u.history.session, now, t);
  return frame('Usage', t.dim(`sampled ${clock(u.at, now)}`), canvasLines(c, t), screen, t);
}

// The share ---------------------------------------------------------------------------------

/**
 * Who used the limits: of the session's in its window and of the week's since its reset, the
 * points each session on this computer used, as bars of the whole limit, the most first; what
 * the rest came to (other computers, or use before the replies read); and the points by model.
 * A click on a session opens it.
 * @type {Panel}
 */
function shareLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const u = snap.usage;
  const limits = u ? limitsOf(u, now) : {};
  const bySession = new Map(snap.rows.filter((a) => a.sessionId).map((a) => [a.sessionId, a]));
  /** @param {string} id */
  const named = (id) => {
    const a = bySession.get(id);
    return a ? nameOf(a) : lastPart(snap.cwds?.get(id) ?? '') || (id ? id.slice(0, 8) : 'other');
  };
  const nw = cols >= 100 ? 24 : cols >= 72 ? 16 : 12;
  const bw = cols >= 100 ? 30 : cols >= 72 ? 20 : 10;
  /** @param {number} v */
  const pts = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  const shares = /** @type {[string, Limit | undefined, import('./usage.js').Share | undefined][]} */ ([
    ['session', limits.session, u?.split?.session],
    ['week', limits.week, u?.split?.week],
  ]).filter(([, l, share]) => l && share);
  // The lines for each, with one between them.
  const each = shares.length ? Math.floor((room + 1) / shares.length) : 0;
  /** @type {PanelLine[]} */
  const body = [];
  for (const [i, [label, l, share]] of shares.entries()) {
    if (!l || !share) continue;
    const start = body.length;
    if (i) body.push(line('', cols, t));
    const mine = share.sessions.reduce((n, [, v]) => n + v, 0);
    body.push(line(` ${t.bold(fit(label, 7))} ${levelOf(l.v, `${l.near ? '~' : ''}${l.v}%`, t)}  ${t.dim(`this computer: ${pts(mine)} points since ${minute(share.from, now)}`)}`, cols, t));
    const list = share.sessions.filter(([, v]) => v >= 0.05);
    const rest = l.v - mine;
    const models = share.models.filter(([, v]) => v >= 0.05).map(([m, v]) => `${shortModel(m) || m || 'other'} ${pts(v)}`).join(t.dim(t.sep));
    const fits = Math.max(1, each - (body.length - start) - (rest >= 1 ? 1 : 0) - (models ? 1 : 0));
    const listed = list.length > fits ? list.slice(0, fits - 1) : list;
    for (const [id, v] of listed) {
      const a = bySession.get(id);
      body.push(line(`   ${fit(named(id), nw, 'left', t.ellipsis)} ${bar(v, undefined, bw, t)} ${fit(pts(v), 5, 'right')}`, cols, t, a ? { open: a.key } : NONE));
    }
    if (list.length > listed.length) body.push(line(t.dim(`   and ${list.length - listed.length} more`), cols, t));
    if (rest >= 1) {
      const used = Math.round((Math.min(100, rest) / 100) * bw);
      const gray = t.dim(t.bar.full.repeat(used) + t.bar.empty.repeat(bw - used));
      body.push(line(`   ${t.dim(fit('elsewhere', nw))} ${gray} ${fit(pts(rest), 5, 'right')}  ${t.dim('not in the replies read here')}`, cols, t));
    }
    if (models) body.push(line(`   ${t.dim(fit('by model', nw))} ${models}`, cols, t));
  }
  if (!body.length) body.push(line(t.dim("   Not known yet: it needs the desktop app's samples of the usage, and this computer's replies read."), cols, t));
  return frame('Who used the limits', t.dim('in points of each limit'), body, screen, t);
}

// Today -------------------------------------------------------------------------------------

/**
 * Today: what the sessions on this computer did since midnight: how many sessions, agents,
 * prompts and replies, how long they waited on you, the tokens, the models' shares, the replies
 * hour by hour, and the tools called, the most first, as bars.
 * @type {Panel}
 */
function todayLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const d = snap.today;
  if (!d) return frame('Today', '', [line(t.dim("   Reading today's transcripts..."), cols, t)], screen, t);
  // The waits that ended, and those that go on.
  const waiting = snap.rows.filter((a) => a.state === 'waiting').reduce((n, a) => n + Math.max(0, now - Math.max(d.from, a.activityAt || a.lastActive)), 0);
  const waited = d.waitedMs + waiting;
  const sep = t.dim(t.sep);
  /** @type {PanelLine[]} */
  const body = [];
  const facts = [count(d.sessions, 'session'), count(d.agents, 'agent'), count(d.prompts, 'prompt'), count(d.replies, 'reply', 'replies'), `waited on you ${waited >= MINUTE ? till(waited) : `${Math.round(waited / SECOND)}s`}`];
  if (width(facts.join(t.sep)) + 3 <= cols) body.push(line(`   ${facts.join(sep)}`, cols, t));
  else body.push(line(`   ${facts.slice(0, 3).join(sep)}`, cols, t), line(`   ${facts.slice(3).join(sep)}`, cols, t));
  body.push(line(`   ${t.dim(fit('tokens', 9))}${tokens(d.out) || '0'} out${sep}${tokens(d.in) || '0'} in`, cols, t));
  const total = d.models.reduce((n, [, x]) => n + x, 0);
  const models = d.models.filter(([, x]) => total && x / total >= 0.005).map(([m, x]) => `${shortModel(m) || m} ${Math.round((100 * x) / total)}%`).join(sep);
  if (models) body.push(line(`   ${t.dim(fit('models', 9))}${models}`, cols, t));
  // The replies hour by hour: an hour gone by with none a dot, those to come blank.
  const hw = Math.max(1, Math.min(3, Math.floor((cols - 14) / 24)));
  const levels = t.ascii ? [' ', '_', '.', '-', '~', '=', '*', '#'] : [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const most = Math.max(1, ...d.hours);
  let spark = '';
  for (let h = 0; h < 24; h++) {
    const n = d.hours[h];
    if (n === undefined) spark += ' '.repeat(hw);
    else if (!n) spark += t.dim((t.ascii ? '.' : '·').padEnd(hw));
    else spark += t.green(levels[Math.max(1, Math.round((n / most) * (levels.length - 1)))].repeat(hw));
  }
  body.push(line(`   ${t.dim(fit('replies', 9))}${spark}`, cols, t));
  let ticks = '';
  for (const h of [0, 6, 12, 18]) ticks = ticks.padEnd(h * hw) + h;
  body.push(line(`   ${' '.repeat(9)}${t.dim(ticks)}`, cols, t));
  // The tools as bars, in two columns on a wide screen when one does not hold them.
  const left = room - body.length - 1;
  if (d.tools.length && left > 0) {
    body.push(line(`   ${t.dim('tools')}`, cols, t));
    const indent = 5;
    const per = cols >= 110 && d.tools.length > left ? 2 : 1;
    const cw = Math.floor((cols - indent - 1) / per);
    const top = d.tools[0][1];
    const nw = 14;
    const bw = Math.max(4, cw - nw - 8);
    const cell = (/** @type {[string, number]} */ [name, n]) => `${fit(toolIn(name, nw - 1, t.ellipsis), nw - 1)} ${t.green((t.ascii ? '#' : '█').repeat(Math.max(1, Math.round((n / top) * bw))))} ${t.dim(String(n))}`;
    const all = d.tools.length;
    const listed = d.tools.slice(0, all <= left * per ? all : Math.max(0, (left - 1) * per));
    for (let i = 0; i < listed.length; i += per) {
      const second = per > 1 && listed[i + 1] ? cell(listed[i + 1]) : '';
      body.push(line(`${' '.repeat(indent)}${cut(cell(listed[i]), cw, t)}${second}`, cols, t));
    }
    if (all > listed.length) body.push(line(t.dim(`${' '.repeat(indent)}and ${all - listed.length} more`), cols, t));
  }
  return frame('Today', t.dim('since midnight'), body, screen, t);
}

// The tank ----------------------------------------------------------------------------------

/**
 * When a reply drops into the tank, after it was written (it is read some seconds after, and so
 * they drop in the order they came, as far apart), and how long it falls (ms).
 */
const DROP_AFTER = 15_000;
const FALL = 1500;

/**
 * A tank at (x, y), `w` columns wide and `h` lines high inside, filled to `v` percent under a
 * surface that moves; the drops falling in, each at the column its time puts it, as big as its
 * points.
 * @param {Canvas} c
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} v
 * @param {Drop[]} drops
 * @param {number} now
 * @param {Theme} t
 */
function tank(c, x, y, w, h, v, drops, now, t) {
  const [tl, tr, bl, br, side, flat] = t.ascii ? ['+', '+', '+', '+', '|', '-'] : ['┌', '┐', '└', '┘', '│', '─'];
  c.put(x, y, tl + flat.repeat(w) + tr, t.dim);
  for (let i = 1; i <= h; i++) {
    c.put(x, y + i, side, t.dim);
    c.put(x + w + 1, y + i, side, t.dim);
  }
  c.put(x, y + h + 1, bl + flat.repeat(w) + br, t.dim);
  const level = Math.round((Math.max(0, Math.min(100, v)) / 100) * h);
  const fill = v >= 90 ? t.red : v >= 75 ? t.yellow : t.green;
  for (let i = 0; i < level; i++) c.put(x + 1, y + h - i, (t.ascii ? '#' : '█').repeat(w), fill);
  const surface = y + h - level;
  if (level < h) {
    const waves = t.ascii ? ['~', '-'] : ['≈', '~'];
    let s = '';
    for (let i = 0; i < w; i++) s += waves[(i + Math.floor(now / 300)) % 2];
    c.put(x + 1, surface, s, t.cyan);
  }
  const top = y + 1;
  for (const d of drops) {
    const f = (now - Math.max(d.seen, d.t + DROP_AFTER)) / FALL;
    if (f < 0 || f >= 1) continue;
    const row = top + Math.floor(f * (surface - top));
    if (row >= surface) continue;
    const g = t.ascii ? (d.v < 0.05 ? '.' : d.v < 0.3 ? 'o' : 'O') : d.v < 0.05 ? '·' : d.v < 0.3 ? '•' : '●';
    c.put(x + 1 + (hash(String(d.t)) % w), row, g, t.cyan);
  }
}

/**
 * The tank: the session's limit as a tank the replies drip into, as full as its percent, each
 * reply a drop as big as its points, some seconds after it was written; with its pace and its
 * reset. The week's beside it, with its own; the replies drip into it instead where the session's
 * points for them are not known (its percent left out of the desktop app's samples, as after a
 * change of plan, or not carried on yet).
 * @type {Panel}
 */
function tankLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const u = snap.usage;
  const { session, week } = u ? limitsOf(u, now) : {};
  if (!session && !week) return frame('Tank', '', [line(t.dim('   No usage known: the desktop app samples it while it runs.'), cols, t)], screen, t);
  const c = new Canvas(cols, room);
  const h = Math.max(1, Math.min(14, room - 3));
  const w = Math.max(6, Math.min(24, Math.floor((cols - 40) / 2)));
  const drops = u?.drops ?? [];
  let x = 2;
  /** @param {Drop['limit']} limit @param {Limit} l @param {string} [resets] */
  const draw = (limit, l, resets) => {
    tank(c, x, 0, w, h, l.v, drops.filter((d) => d.limit === limit), now, t);
    // Beside it, its percent at its surface (100% at its top, where there is room), and the rest.
    const at = Math.max(1, h - Math.round((Math.max(0, Math.min(100, l.v)) / 100) * h));
    if (at > 2) c.put(x + w + 3, 1, '100%', t.dim);
    c.put(x + w + 3, at, `${l.near ? '~' : ''}${l.v}%`, levelStyle(l.v, t) ?? t.bold);
    [l.pace === undefined ? '' : rate(l.pace, 'h'), resets ?? ''].filter(Boolean).forEach((s, i) => c.put(x + w + 3, at + 1 + i, s, t.dim));
    c.put(x + 1, h + 2, limit, t.bold);
    x += w + 18;
  };
  if (session) {
    const end = sessionEnd(session.reset);
    draw('session', session, end === undefined ? undefined : `resets ${timeOfDay(end)}`);
  }
  if (week && x + w + 16 <= cols) {
    const r = week.reset;
    draw('week', week, r && r.to - r.from <= 12 * HOUR ? `resets ${weekday(r.at)}` : undefined);
  }
  const lately = drops.filter((d) => d.t >= now - 30 * SECOND).length;
  return frame('Tank', t.dim(lately ? `${count(lately, 'reply', 'replies')} in the last 30s` : 'each reply a drop'), canvasLines(c, t), screen, t);
}

// The radar ---------------------------------------------------------------------------------

/** How long the radar's sweep takes to go round (ms). */
const SWEEP = 4000;

/**
 * The radar: each session listed as a blip, as far from the middle as it is long since it did
 * anything (from moments to the window's length, on a log scale), at a bearing its key gives it;
 * rings at a minute, ten, an hour and the window. The sweep goes round, and lights a blip that
 * did something since it last went by. Beside it the sessions, the latest first. A click on one
 * opens its details.
 * @type {Panel}
 */
function radarLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const sessions = sessionsOf(rows);
  const selected = selectedOf(rows, ui);
  const c = new Canvas(cols, room);
  /** @type {Map<number, Spot[]>} */
  const spots = new Map();
  // Twice as wide as high in cells, as round as the cells allow.
  const ry = Math.max(1, Math.floor((room - 1) / 2));
  const rx = 2 * ry;
  const cx = 1 + rx;
  const cy = ry;
  const far = Math.max(HOUR, snap.windowMs);
  const dist = (/** @type {number} */ age) => Math.min(1, Math.log1p(Math.max(0, age) / (10 * SECOND)) / Math.log1p(far / (10 * SECOND)));
  // In dots, two to a cell across and four down: the radius, and the middle.
  const R = 4 * ry;
  const ox = 2 * cx + 1;
  const oy = 4 * cy + 2;
  for (const age of [MINUTE, 10 * MINUTE, HOUR, far]) {
    const r = dist(age) * R;
    const n = Math.max(12, Math.round(r * 2.5));
    for (let k = 0; k < n; k++) c.dot(ox + Math.cos((2 * Math.PI * k) / n) * r, oy + Math.sin((2 * Math.PI * k) / n) * r, t.dim);
  }
  const angle = ((now % SWEEP) / SWEEP) * 2 * Math.PI;
  for (const [back, style] of /** @type {[number, Style][]} */ ([[0.3, t.dim], [0.15, t.dim], [0, t.green]])) {
    c.line(ox, oy, ox + Math.cos(angle - back) * R, oy + Math.sin(angle - back) * R, style);
  }
  c.put(cx, cy, '+', t.dim);
  // The blips, then their names where they cover nothing, the latest first.
  const blips = [...sessions].sort((a, b) => b.lastActive - a.lastActive).map((a) => {
    const s = shown(a);
    const bearing = ((hash(a.key) % 3600) / 3600) * 2 * Math.PI;
    const r = dist(now - a.lastActive);
    const x = Math.round(cx + Math.cos(bearing) * r * rx);
    const y = Math.round(cy + Math.sin(bearing) * r * ry);
    // Lit as the sweep goes by, when it did something since the sweep last did.
    const behind = (((angle - bearing) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const lit = behind < 0.6 && now - a.lastActive < SWEEP;
    const paint = paintOf(s, t);
    c.put(x, y, glyphChar(s, t, now), lit && t.color ? (z) => t.inverse(paint(z)) : paint);
    return { a, x, y, lit };
  });
  for (const { a, x, y, lit } of blips) {
    const name = ` ${truncate(nameOf(a), 10, t.ellipsis)}`;
    const end = x + 1 + width(name) <= 2 * rx + 3 && c.free(x + 1, y, width(name) + 1) ? c.put(x + 1, y, name, lit ? t.bold : t.dim) : x + 1;
    spot(spots, y, { x0: x, x1: end, action: { open: a.key } });
  }
  const lx = 2 * rx + 5;
  if (cols - lx >= 16) {
    const list = [...sessions].sort((a, b) => b.lastActive - a.lastActive).slice(0, Math.max(0, room - 1));
    list.forEach((a, i) => {
      const s = shown(a);
      const chosen = a.key === selected;
      if (chosen && !t.color) c.put(lx - 1, i, '>');
      c.put(lx, i, glyphChar(s, t, now), paintOf(s, t));
      const end = c.put(lx + 2, i, fit(nameOf(a), Math.min(30, cols - lx - 9), 'left', t.ellipsis), chosen && t.color ? t.inverse : undefined);
      c.put(end + 1, i, fit(ago(now - a.lastActive), 4, 'right'), t.dim);
      spot(spots, i, { x0: lx, x1: cols, action: { open: a.key } });
    });
    const rings = [...new Set(['1m', '10m', '1h', durationLabel(far)])].join(', ');
    if (room > 1) c.put(lx, room - 1, truncate(`rings: ${rings}`, cols - lx - 1, t.ellipsis), t.dim);
  }
  if (!sessions.length) c.put(Math.max(1, Math.min(lx, cols - 20)), 0, 'No sessions listed.', t.dim);
  return frame('Radar', t.dim('nearer the middle, the more lately'), canvasLines(c, t, spots), screen, t);
}

// The spark ---------------------------------------------------------------------------------

/** The spark's middle as it turns; and its rays, each way from the middle, and what draws it. */
const SPARK = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const SPARK_ASCII = ['.', '+', 'x', '*', 'X', '*', 'x', '+'];
const RAYS = /** @type {[number, number, string][]} */ ([[1, 0, '-'], [1, 1, '\\'], [0, 1, '|'], [-1, 1, '/'], [-1, 0, '-'], [-1, -1, '\\'], [0, -1, '|'], [1, -1, '/']]);

/**
 * The spark: one for all the sessions listed. It turns the faster the more of them work, waves
 * when one needs you, sleeps when none works, and goes yellow then red as a limit nears; what it
 * stands for beside it.
 * @type {Panel}
 */
function sparkLines(snap, rows, ui, screen, t) {
  const { width: cols, height, now } = screen;
  const room = Math.max(0, height - 2);
  const sessions = sessionsOf(rows);
  const states = sessions.map(shown);
  const working = states.filter((s) => ['working', 'running', 'tool'].includes(s)).length;
  const needs = states.filter((s) => s === 'waiting' || s === 'blocked').length;
  const unread = states.filter((s) => s === 'unread').length;
  const { session, week } = snap.usage ? limitsOf(snap.usage, now) : {};
  const top = Math.max(session?.v ?? 0, week?.v ?? 0);
  const asleep = !working && !needs;
  const paint = asleep ? t.dim : top >= 90 ? t.red : top >= 75 ? t.yellowBold : t.yellow;
  // Its rays' length, as the room allows; the middle; and where the words begin.
  const L = Math.max(0, Math.min(4, Math.floor((room - 1) / 2)));
  const cy = Math.max(0, Math.floor((room - 1) / 2));
  const cx = 2 * L + 3;
  const tx = cx + 2 * L + 6;
  const c = new Canvas(Math.min(cols, tx), room);
  const middle = t.ascii ? SPARK_ASCII : SPARK;
  // A step the shorter the more sessions work.
  const step = Math.floor(now / (600 / (1 + working)));
  if (asleep) {
    c.put(cx, cy, middle[0], t.dim);
    const z = Math.floor(now / 700) % 3;
    c.put(cx + 1 + z, cy - 1 - z, z === 2 ? 'Z' : 'z', t.dim);
  } else {
    c.put(cx, cy, middle[step % middle.length], paint);
    // The rays, the straight ones and the slanted ones in turn.
    RAYS.forEach(([dx, dy, ch], i) => {
      if ((i + step) % 2) return;
      const g = ch === '-' && !t.ascii ? '─' : ch;
      for (let k = 1; k <= L; k++) {
        c.put(cx + dx * 2 * k, cy + dy * k, g, paint);
        if (!dy) c.put(cx + dx * (2 * k - 1), cy, g, paint);
      }
    });
    if (needs) {
      // An arm up and down, and what it asks.
      const up = Math.floor(now / 400) % 2;
      c.put(cx + 2 * L + 2, cy - up, up ? '/' : '-', t.yellowBold);
      c.put(cx + 2 * L + 3, cy - 1 - up, '?', t.yellowBold);
    }
  }
  const said = [
    [working && t.green(`${working} at work`), needs && t.yellowBold(`${needs} for you`), unread && t.blueBold(`${unread} unread`)].filter(Boolean).join(t.dim(t.sep))
      || t.dim(sessions.length ? 'asleep: none at work' : 'no sessions listed'),
    [session && `${t.dim('session')} ${levelOf(session.v, `${session.near ? '~' : ''}${session.v}%`, t)}`, week && `${t.dim('week')} ${levelOf(week.v, `${week.near ? '~' : ''}${week.v}%`, t)}`].filter(Boolean).join('  '),
  ].filter(Boolean);
  const first = Math.max(0, cy - Math.floor((said.length - 1) / 2));
  const lines = c.lines(t.ascii).map((text, y) => line(y >= first && y - first < said.length ? text + said[y - first] : text, cols, t));
  return frame('Spark', '', lines, screen, t);
}

/** @type {View[]} the overview first, then as v steps through them */
export const VIEWS = [
  { name: 'overview', what: 'the selected session, what needs you, the latest messages, and the usage at its pace', animated: false },
  { name: 'floor', what: 'each session as a figure: at its keys while it works, waving when it needs you, asleep when idle; its agents walk beside it', animated: true, lines: floorLines },
  { name: 'board', what: 'the sessions as cards in columns: needs you, working, background, idle; a card that moved stands out', animated: false, lines: boardLines },
  { name: 'lanes', what: 'a lane for each session over the last half hour or more: at work, in a tool, waiting on you, your prompts', animated: false, lines: lanesLines },
  { name: 'ticker', what: 'the tool calls as they come: how long the open ones have run, how long the others took', animated: false, lines: tickerLines },
  { name: 'pipeline', what: "the workflows' phases, each agent at work, done or failed; the sessions' own agents", animated: true, lines: pipelineLines },
  { name: 'files', what: 'the files changed in the last hour, and those two sessions changed', animated: false, lines: filesLines },
  { name: 'chart', what: "the session's usage over its window and the week's, at its pace on to the reset; when in the day it was used", animated: false, lines: chartLines },
  { name: 'share', what: "what each session and model on this computer used of the session's limit and the week's", animated: false, lines: shareLines },
  { name: 'today', what: 'what today came to: sessions, agents, prompts, replies, tokens, models, hours, tools, the time waited on you', animated: false, lines: todayLines },
  { name: 'tank', what: "the session's limit as a tank the replies drip into, and the week's", animated: true, lines: tankLines },
  { name: 'radar', what: 'the sessions as blips, nearer the middle the more lately they did something; the sweep lights what just did', animated: true, lines: radarLines },
  { name: 'spark', what: 'one spark for them all: it turns faster the more work, waves when one needs you, sleeps when none works, reddens near a limit', animated: true, lines: sparkLines },
];

/**
 * A view by its name; the overview for a name not known.
 * @param {string} name
 */
export function viewOf(name) {
  return VIEWS.find((v) => v.name === name) ?? VIEWS[0];
}
