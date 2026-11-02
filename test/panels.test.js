import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from '../src/canvas.js';
import { clock, timeOfDay, weekday, width } from '../src/format.js';
import { boardColumn, cut, laneOf, MOVED, VIEWS, viewOf } from '../src/panels.js';
import { helpLines, initialUi, listLines, makeTheme, settleSelection, visibleRows } from '../src/view.js';
import { Viewer } from '../src/viewer.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE, NOW } from './helpers/fixture.js';

const SECOND = 1000;
const DAY = 24 * HOUR;
const plain = makeTheme({ color: false, ascii: false, animate: false });
const color = makeTheme({ color: true, ascii: false, animate: false });
const ascii = makeTheme({ color: false, ascii: true, animate: true });
/** @param {string} s */
const visible = (s) => width(s.replace(/\x1b\[[0-9;]*m/g, ''));
/** Where a click goes. @param {import('../src/view.js').Hit[]} hits @param {number} x @param {number} y */
const clickAt = (hits, x, y) => hits.find((h) => h.y === y && x >= h.x0 && x < h.x1)?.action;

/**
 * A tool call made `s` seconds before NOW that took `took` seconds: none yet for 0.
 * @param {string} id @param {string} name @param {string} summary @param {number} s @param {number} took
 * @param {Partial<import('../src/transcript.js').Call>} [o]
 * @returns {import('../src/transcript.js').Call}
 */
const call = (id, name, summary, s, took, o = {}) => ({ id, name, summary, ts: NOW - s * SECOND, end: took ? NOW - (s - took) * SECOND : 0, error: false, ...o });

/**
 * Sessions as the views see them: one at work with an agent and a workflow, one in a tool, one
 * waiting on a question, one unread, one idle and one that ended.
 */
function sessions() {
  // Its agents listed out of the order they began, as the views must not take it.
  const flow = agent({
    key: 'w:1', type: 'workflow', title: 'review-changes', state: 'running', startedAt: NOW - 5 * MINUTE,
    counts: { running: 2, done: 3, failed: 1, total: 6 },
    children: /** @type {[string, string, string, number][]} */ ([
      ['bugs', 'Verify', 'done', 3], ['perf', 'Verify', 'running', 2], ['docs', 'Verify', 'running', 1],
      ['bugs', 'Review', 'done', 6], ['perf', 'Review', 'done', 5], ['docs', 'Review', 'failed', 4],
    ]).map(([x, phase, state, m]) => agent({ key: `a:${phase}:${x}`, type: 'agent', title: `${phase.toLowerCase()}:${x}`, phase, state, startedAt: NOW - m * MINUTE })),
  });
  const explore = agent({
    key: 'a:explore', type: 'subagent', title: 'Explore the parser', state: 'running', startedAt: NOW - 2 * MINUTE, lastActive: NOW - 5 * SECOND,
    calls: [call('c9', 'Grep', 'Grep: parse', 30, 1)],
  });
  return [
    agent({
      key: 's:work', title: 'Add the views', project: 'monitor', cwd: '/work/monitor', sessionId: 'sid-work', state: 'working',
      activity: 'Edit: src/panels.js', activityKind: 'tool', activityAt: NOW - 2 * SECOND, lastActive: NOW - 2 * SECOND,
      calls: [
        call('c1', 'Edit', 'Edit: src/panels.js', 600, 0.5, { file: '/work/monitor/src/panels.js' }),
        call('c2', 'Bash', 'Bash: Run the tests', 400, 12),
        call('c3', 'Write', 'Write: src/canvas.js', 300, 0.25, { file: '/work/monitor/src/canvas.js' }),
        call('c4', 'Bash', 'Bash: Lint', 200, 3, { error: true }),
        call('c5', 'Edit', 'Edit: README.md', 100, 0.5, { file: '/work/monitor/README.md' }),
        call('c6', 'Edit', 'Edit: src/panels.js', 2, 0, { file: '/work/monitor/src/panels.js' }),
      ],
      turns: [{ start: NOW - 25 * MINUTE, end: NOW - 15 * MINUTE }, { start: NOW - 11 * MINUTE, end: 0 }],
      events: [{ ts: NOW - 25 * MINUTE, kind: 'prompt', text: 'add the views' }, { ts: NOW - 11 * MINUTE, kind: 'prompt', text: 'and the keys' }],
      children: [explore, flow],
    }),
    agent({
      key: 's:tool', title: 'Build the site', project: 'site', cwd: '/work/site', sessionId: 'sid-tool', state: 'working', inTool: true,
      activity: 'Bash: npm run build', activityKind: 'tool', activityAt: NOW - 20 * SECOND, lastActive: NOW - 20 * SECOND,
      calls: [call('c7', 'Edit', 'Edit: README.md', 50, 1, { file: '/work/monitor/README.md' }), call('c8', 'Bash', 'Bash: npm run build', 20, 0)],
      turns: [{ start: NOW - MINUTE, end: 0 }],
    }),
    agent({
      key: 's:wait', title: 'Fix the login', project: 'auth', cwd: '/work/auth', sessionId: 'sid-wait', state: 'waiting',
      activity: 'waiting: a question: which database?', activityKind: 'waiting', activityAt: NOW - 3 * MINUTE, lastActive: NOW - 3 * MINUTE,
      calls: [call('c10', 'AskUserQuestion', 'AskUserQuestion: which database?', 180, 0, { asks: true })],
      turns: [{ start: NOW - 6 * MINUTE, end: 0 }],
    }),
    agent({ key: 's:read', title: 'Write the docs', project: 'docs', sessionId: 'sid-read', state: 'idle', unread: true, activity: 'The README is done.', lastActive: NOW - 8 * MINUTE }),
    agent({ key: 's:idle', title: 'Old idea', project: 'misc', sessionId: 'sid-idle', state: 'idle', lastActive: NOW - 40 * MINUTE }),
    agent({ key: 's:end', title: 'Gone home', project: 'misc', state: 'ended', live: false, lastActive: NOW - 3 * HOUR }),
  ];
}

/** @param {number} base @param {number} step @param {number[]} vs */
const points = (base, step, vs) => vs.map((v, i) => ({ t: base + i * step, v }));

/**
 * The plan's usage: the session at ~43% with two hours left, at 9 points an hour, its samples
 * rising from 0 over its window so far; the week at ~63% with two days left, at 0.4 points an
 * hour; what this computer's sessions used of each; and a reply written 16 seconds ago.
 * @type {import('../src/usage.js').Usage}
 */
const USAGE = {
  at: NOW - 10 * MINUTE, session: 40, week: 62,
  history: {
    session: points(NOW - 175 * MINUTE, 15 * MINUTE, [0, 2, 5, 9, 14, 20, 25, 30, 33, 36, 38, 40]),
    week: points(NOW - 5 * DAY, 6 * HOUR, Array.from({ length: 20 }, (_, i) => 30 + Math.round(i * 1.6))),
  },
  tracked: {
    at: NOW, session: 43, sessionReset: { at: NOW + 2 * HOUR, from: NOW + 2 * HOUR, to: NOW + 2 * HOUR }, sessionPace: 9,
    week: 63, weekReset: { at: NOW + 2 * DAY, from: NOW + 2 * DAY, to: NOW + 2 * DAY }, weekPace: 0.4,
  },
  split: {
    session: { from: NOW - 3 * HOUR, to: NOW, sessions: [['sid-work', 20], ['sid-wait', 8.5], ['zz', 0.4]], models: [['claude-opus-5-5', 28.5], ['claude-haiku-5-5', 0.4]] },
    week: { from: NOW - 5 * DAY, to: NOW, sessions: [['sid-work', 22], ['sid-wait', 12]], models: [['claude-opus-5-5', 34]] },
  },
  drops: [{ t: NOW - 16 * SECOND, seen: NOW - 10 * SECOND, limit: 'session', v: 0.2, session: 'sid-work' }],
};

const MIDNIGHT = new Date(NOW).setHours(0, 0, 0, 0);
/** @type {import('../src/ledger.js').Day} */
const TODAY = {
  from: MIDNIGHT, sessions: 4, agents: 7, prompts: 23, replies: 412, out: 512_000, in: 48_000_000, waitedMs: 14 * MINUTE,
  tools: [['Bash', 120], ['Read', 90], ['Edit', 61], ['mcp__ccd_turn__update_plan', 12]], models: [['claude-opus-5-5', 900], ['claude-haiku-5-5', 100]],
  hours: [0, 4, 8, 0, 2],
};

/** @param {Partial<import('../src/monitor.js').Snapshot>} [o] */
const fullSnapshot = (o = {}) => snapshot(sessions(), { usage: USAGE, today: TODAY, cwds: new Map([['zz', '/work/scripts']]), ...o });

/**
 * A view below the rows of the sessions (their agents not listed), at a size: the screen's lines,
 * where a click goes, and the view's own lines, from the blank one that begins it, trimmed.
 * @param {string} name
 * @param {{ width?: number, height?: number, now?: number, t?: import('../src/view.js').Theme, index?: number,
 *   snap?: import('../src/monitor.js').Snapshot, ui?: Partial<import('../src/view.js').Ui> }} [o]
 */
function draw(name, { width: cols = 100, height = 40, now = NOW, t = plain, index = -1, snap = fullSnapshot(), ui: more = {} } = {}) {
  const ui = { ...initialUi(), panel: name, agents: /** @type {const} */ ('none'), index, ...more };
  const rows = visibleRows(snap, ui, t);
  if (ui.index >= 0) settleSelection(ui, rows, height - 3);
  /** @type {import('../src/view.js').Hit[]} */
  const hits = [];
  const lines = listLines(snap, rows, ui, { width: cols, height, now }, t, hits, viewOf(name).lines);
  const top = 2 + rows.length;
  return { lines, hits, top, view: lines.slice(top, -1).map((l) => l.trimEnd()) };
}

test('a canvas: text put clipped to it, a wide character in its two cells, dots in Braille, or with --ascii as marks', () => {
  const c = new Canvas(6, 2);
  assert.equal(c.put(4, 0, 'abc'), 7, 'the column after it');
  c.put(-1, 1, 'xyz');
  assert.deepEqual(c.lines(), ['    ab', 'yz    ']);
  c.put(2, 1, '日');
  c.put(5, 1, '本');
  assert.equal(c.lines()[1], 'yz日  ', 'a wide character only where both its cells are');
  assert.equal(c.textAt(0, 1, 3), 'yz日');
  assert.equal(c.free(4, 1, 2), true);
  assert.equal(c.free(3, 1, 1), false, 'half of a wide one');
  assert.equal(c.free(5, 1, 2), false, 'past the edge');
  c.put(3, 1, 'k');
  assert.equal(c.lines()[1], 'yz k  ', 'a wide one half covered leaves a space');
  // Two dots in the first cell, at its top left and bottom right; one in the second.
  const d = new Canvas(2, 1);
  d.dot(0, 0);
  d.dot(1, 3);
  d.dot(2, 1);
  assert.deepEqual(d.lines(), ['\u2881\u2802']);
  assert.deepEqual(d.lines(true), [":'"], 'top and bottom, top');
  assert.equal(d.free(0, 0, 2), true, 'dots are no text');
  const l = new Canvas(3, 1);
  l.line(0, 0, 5, 0);
  assert.deepEqual(l.lines(), ['⠉⠉⠉']);
  const dotted = new Canvas(3, 1);
  dotted.line(0, 0, 5, 0, undefined, 2);
  assert.deepEqual(dotted.lines(), ['⠁⠁⠁'], 'every second dot');
  // Each run of one style is styled once.
  const s = new Canvas(5, 1);
  const tag = (/** @type {string} */ x) => `<${x}>`;
  s.put(0, 0, 'ab', tag);
  s.put(2, 0, 'c', tag);
  s.put(4, 0, 'd');
  assert.deepEqual(s.lines(), ['<abc> d']);
});

test('cut: a styled line cut to a width keeps its styles, closes the one it cuts, and ends with an ellipsis', () => {
  assert.equal(cut(`${color.red('abc')}def`, 4, color), '\x1b[31mabc\x1b[0m…');
  assert.equal(cut(color.red('abcdef'), 4, color), '\x1b[31mabc\x1b[0m…');
  assert.equal(cut(`ab${color.bold('cd')}`, 6, color), `ab${color.bold('cd')}  `, 'shorter: padded');
  assert.equal(cut('ab日本', 4, plain), 'ab …', 'a wide character that does not fit leaves a space');
  assert.equal(cut('abcdef', 4, ascii), 'abc~');
  assert.equal(cut('abc', 0, plain), '');
});

test('the views, the overview first, as v steps through them; those that move of themselves', () => {
  assert.deepEqual(VIEWS.map((v) => v.name), ['overview', 'floor', 'board', 'lanes', 'ticker', 'pipeline', 'files', 'chart', 'share', 'today', 'tank', 'radar', 'spark']);
  assert.deepEqual(VIEWS.filter((v) => v.animated).map((v) => v.name), ['floor', 'pipeline', 'tank', 'radar', 'spark']);
  assert.equal(viewOf('radar').name, 'radar');
  assert.equal(viewOf('nope'), VIEWS[0]);
  assert.equal(VIEWS[0].lines, undefined, 'src/view.js draws the overview');
});

test('every view fills the room below the rows: a line for each of it, each as wide as the screen, nothing but ASCII with --ascii', () => {
  const empty = snapshot([]);
  const bare = snapshot(sessions());
  for (const t of [plain, color, ascii]) {
    for (const [cols, height] of [[120, 50], [100, 30], [72, 24], [60, 20], [43, 40], [30, 12], [20, 6]]) {
      for (const v of VIEWS.slice(1)) {
        for (const snap of [fullSnapshot(), bare, empty]) {
          for (const now of [NOW, NOW + 777]) {
            const { lines } = draw(v.name, { width: cols, height, now, t, snap, index: 0, ui: { agents: 'all' } });
            const at = `${v.name} at ${cols}x${height}${t.ascii ? ' in ASCII' : ''}`;
            assert.equal(lines.length, height, at);
            lines.forEach((l, y) => {
              assert.equal(visible(l), y === height - 1 ? visible(l) : cols, `${at}, line ${y}: ${JSON.stringify(l)}`);
              assert.ok(visible(l) <= cols - (y === height - 1 ? 1 : 0), `${at}, line ${y}`);
              if (t.ascii) assert.match(l, /^[\x20-\x7e]*$/, `${at}, line ${y}`);
            });
          }
        }
      }
    }
  }
});

test('the floor: each session that runs a figure posed by what it does, its agents beside it, those that ended named below', () => {
  const { view, hits, top } = draw('floor', { height: 30 });
  assert.match(view[1], /^ ─ Floor ─+ 2 at work · 2 for you · 1 idle ─$/);
  // Over each head what it waits for, did, runs; then the figure; then its name.
  assert.equal(view[2], '  ? a question: whi…  • The README is d…  Edit: src/panels.…  >_ npm run build');
  assert.match(view[3], /^ {3}(\\o\/|_o_) {18}o \[\] {16}o {4}/, 'waving; holding up a reply');
  assert.match(view[4], /^ {4}\| {18}\/\|\/ {17}\/\|[-_]\[\]/, 'at its keys');
  assert.equal(view[6], '  ◆ Fix the login     • Write the docs    ● Add the views     ◐ Build the site');
  // Beside the one at work, its workflow's agents in a crowd with how far it has come, and its agent walking.
  assert.match(view[3].slice(49, 55), /^[oO]{2} 4\/6$/);
  assert.match(view[4].slice(49, 60), /o/);
  assert.match(view[5].slice(49, 60), /[Λ|]/);
  // Idle: asleep, in the second row.
  assert.match(view[11], /^ {2}___o$/);
  assert.equal(view[12], '  ○ Old idea');
  assert.equal(view[14], '   · ended: Gone home 3h ago');
  for (let y = top + 2; y <= top + 6; y++) {
    assert.deepEqual(clickAt(hits, 5, y), { open: 's:wait' });
    assert.deepEqual(clickAt(hits, 45, y), { open: 's:work' });
  }
  assert.deepEqual(clickAt(hits, 85, top + 4), { unselect: true }, 'no figure there');
  assert.deepEqual(clickAt(hits, 5, top + 14), { unselect: true }, 'the line of those that ended');
  // The selected one: > before its name, without color; inverse with it.
  assert.equal(draw('floor', { height: 30, index: 2 }).view[6], '  ◆ Fix the login     • Write the docs   >● Add the views     ◐ Build the site');
  assert.ok(draw('floor', { height: 30, index: 2, t: color }).lines[top + 6].includes(color.inverse('Add the views   ')));
  // No room for figures: the sessions on one line.
  assert.deepEqual(draw('floor', { height: 14 }).view.slice(1), [
    view[1],
    ' ◆ Fix the login  • Write the docs  ● Add the views  ◐ Build the site  ○ Old idea',
    '   · ended: Gone home 3h ago',
    '',
  ]);
  const gone = snapshot([sessions()[5]]);
  assert.deepEqual(draw('floor', { snap: gone, height: 10 }).view.slice(2, 4), ['   No session runs now.', '   · ended: Gone home 3h ago']);
});

test('the board: the sessions in columns by state; a card that moved stands out for a while, with a ghost where it was; one column under another on a phone', () => {
  const { view, hits, top } = draw('board', { height: 24, index: 1 });
  assert.match(view[1], /^ ─ Board ─+ 2 at work · 2 for you · 1 idle ─$/);
  assert.equal(view[2], ' Needs you 2         Working 2           Background 0        Idle 1              Ended 1');
  assert.deepEqual(view.slice(4, 9), [
    '  ◆ Fix the login     ● Add the views                         ○ Old idea          · Gone home',
    '    waiting: a ques…    Edit: src/panel…                        idle                ended',
    '',
    ' >• Write the docs    ◐ Build the site',
    '    The README is d…    Bash: npm run b…',
  ]);
  assert.deepEqual(clickAt(hits, 5, top + 7), { open: 's:read' });
  assert.deepEqual(clickAt(hits, 25, top + 8), { open: 's:tool' });
  assert.deepEqual(clickAt(hits, 45, top + 4), { unselect: true });
  // Without room for the ended ones' column, they are counted.
  assert.match(draw('board', { width: 90, height: 24 }).view[1], /2 at work · 2 for you · 1 idle · 1 ended ─$/);
  // A card that just moved: marked, where from, and a ghost in its old column.
  const moves = new Map([['s:wait', { from: 'Working', to: 'Needs you', at: NOW - SECOND }]]);
  const moved = draw('board', { height: 24, ui: { moves } }).view;
  assert.equal(moved[4].slice(0, 20).trimEnd(), ' ▸◆ Fix the login');
  assert.equal(moved[5].slice(0, 20).trimEnd(), '    from Working');
  assert.equal(moved[10], '                      ┄ Fix the login');
  const later = draw('board', { height: 24, now: NOW - SECOND + MOVED, ui: { moves } }).view;
  assert.equal(later[5].slice(0, 20), '    waiting: a ques…', `after ${MOVED / SECOND}s, as any other`);
  assert.equal(later[10], '');
  // As narrow as a phone: the columns one under another, those that ended counted where the
  // heading has room.
  assert.match(draw('board', { width: 60, height: 26 }).view[1], /1 ended ─$/);
  const narrow = draw('board', { width: 43, height: 26 }).view;
  assert.deepEqual(narrow.slice(2, 11).map((l) => l.replace(/(\S) {2,}\S.*$/, '$1')), [
    ' Needs you 2', '  ◆ Fix the login', '  • Write the docs', ' Working 2', '  ● Add the views', '  ◐ Build the site', ' Idle 1', '  ○ Old idea', '',
  ]);
  assert.equal(boardColumn(sessions()[2]), 'Needs you');
  assert.equal(boardColumn(agent({ state: 'idle', commands: [{ summary: 'Bash: serve', ts: NOW }] })), 'Background');
});

test('a lane: for each column of time, the most worth of what its session did then', () => {
  const at = (/** @type {Partial<import('../src/monitor.js').Agent>} */ o) => [...laneOf(agent({ lastActive: NOW, ...o }), NOW - 10 * MINUTE, MINUTE, 10, NOW)];
  // Nothing known, idle, at work, in a tool, waiting on you, your prompt.
  assert.deepEqual(at({
    state: 'working',
    turns: [{ start: NOW - 9 * MINUTE, end: NOW - 7 * MINUTE }, { start: NOW - 4 * MINUTE, end: 0 }],
    calls: [
      call('a', 'Bash', 'Bash: build', 180, 60),
      call('b', 'Read', 'Read: a.js', 150, 1),
      call('c', 'Agent', 'Agent: look', 240, 30),
      call('d', 'AskUserQuestion', 'AskUserQuestion: which?', 60, 0, { asks: true }),
    ],
    events: [{ ts: NOW - 9 * MINUTE, kind: 'prompt', text: 'go' }, { ts: NOW - 4 * MINUTE, kind: 'prompt', text: 'more' }],
  }), [0, 5, 2, 2, 1, 1, 5, 3, 3, 4], 'a call of a second, or one that starts an agent, is no wait on a tool');
  assert.deepEqual(at({ state: 'idle', lastActive: NOW - 5 * MINUTE, turns: [{ start: NOW - 8 * MINUTE, end: 0 }] }), [0, 0, 2, 2, 2, 2, 1, 1, 1, 1], 'a turn cut off ends with its last record');
  assert.deepEqual(at({ state: 'ended', live: false, lastActive: NOW - 5 * MINUTE, turns: [{ start: NOW - 8 * MINUTE, end: NOW - 6 * MINUTE }] }), [0, 0, 2, 2, 2, 1, 0, 0, 0, 0], 'over: nothing after its last record');
  assert.deepEqual(at({ state: 'waiting', activityAt: NOW - 2 * MINUTE, turns: [{ start: NOW - 3 * MINUTE, end: 0 }] }), [0, 0, 0, 0, 0, 0, 0, 2, 4, 4], 'waiting now, on what no file says');
});

test('the lanes: what each session did over the last half hour or more, and the times below', () => {
  const { view, hits, top } = draw('lanes', { height: 22 });
  assert.match(view[1], /^ ─ Lanes ─+ █ at work {2}▒ in a tool {2}\? waits on you {2}▲ you {2}each 30s ─$/);
  // 81 columns of 30 seconds, the last one now's.
  assert.equal(view[2], ` ◆ Fix the login  ${' '.repeat(68)}${'█'.repeat(6)}${'?'.repeat(7)}`);
  assert.equal(view[3], ' • Write the docs', 'nothing known');
  assert.equal(view[4], ` ● Add the views  ${' '.repeat(30)}▲${'█'.repeat(20)}${'·'.repeat(7)}▲${'█'.repeat(7)}▒▒${'█'.repeat(5)}▒${'█'.repeat(7)}`);
  assert.equal(view[5], ` ◐ Build the site ${' '.repeat(78)}█▒▒`);
  const tick = (/** @type {number} */ m) => `╵${timeOfDay(NOW - m * MINUTE)}`;
  assert.equal(view[8], `${' '.repeat(18)}${tick(40)}${' '.repeat(14)}${tick(30)}${' '.repeat(14)}${tick(20)}${' '.repeat(14)}${tick(10)}${' '.repeat(12)}now`);
  assert.deepEqual(clickAt(hits, 60, top + 4), { open: 's:work' });
  assert.deepEqual(clickAt(hits, 60, top + 8), { unselect: true });
  // Narrower: columns of a minute, and no room for the key.
  assert.match(draw('lanes', { width: 72, height: 22 }).view[1], /^ ─ Lanes ─+ each 1m ─$/);
  // The selected one, without color.
  assert.match(draw('lanes', { height: 22, index: 2 }).view[4], /^>● Add the views/);
});

test('the tool calls: those open first, the oldest at the top, then the others, the latest first; each with how long it took', () => {
  const extra = agent({
    key: 's:cut', title: 'Cut off', state: 'idle', lastActive: NOW - 5 * MINUTE,
    calls: [call('cx', 'Bash', 'Bash: hang', 400, 0), call('cy', 'mcp__Claude_Browser__navigate', 'Claude_Browser:navigate: http://localhost:3000/', 700, 1)],
  });
  const snap = fullSnapshot({ rows: [...sessions(), extra] });
  const { view, hits, top } = draw('ticker', { height: 24, snap });
  assert.match(view[1], /^ ─ Tool calls ─+ 3 open · 7 in the last 10m ─$/);
  const fields = (/** @type {string} */ l) => [l.slice(1, 10), l.slice(11, 29), l.slice(30, 42), l.slice(43, 88), l.slice(89)].map((s) => s.trim());
  const ago = (/** @type {number} */ s) => clock(NOW - s * SECOND, NOW);
  assert.deepEqual(view.slice(2, 13).map(fields), [
    [ago(180), 'Fix the login', 'AskUserQues…', 'which database?', '◆ 3m00s'],
    [ago(20), 'Build the site', 'Bash', 'npm run build', '◐ 20s'],
    [ago(2), 'Add the views', 'Edit', 'src/panels.js', '◐ 2s'],
    [ago(30), '↳ Explore the par…', 'Grep', 'parse', '✓ 1.0s'],
    [ago(50), 'Build the site', 'Edit', 'README.md', '✓ 1.0s'],
    [ago(100), 'Add the views', 'Edit', 'README.md', '✓ 0.5s'],
    [ago(200), 'Add the views', 'Bash', 'Lint', '✗ 3.0s'],
    [ago(300), 'Add the views', 'Write', 'src/canvas.js', '✓ 0.3s'],
    [ago(400), 'Add the views', 'Bash', 'Run the tests', '✓ 12s'],
    [ago(600), 'Add the views', 'Edit', 'src/panels.js', '✓ 0.5s'],
    [ago(700), 'Cut off', 'navigate', 'http://localhost:3000/', '✓ 1.0s'],
  ], 'the call of a session not at work that has no result was cut off: left out; an MCP tool without its server, where both do not fit');
  assert.deepEqual(clickAt(hits, 50, top + 2), { open: 's:wait' });
  assert.deepEqual(clickAt(hits, 50, top + 5), { open: 'a:explore' }, "an agent's call opens the agent");
  assert.match(draw('ticker', { snap: snapshot([sessions()[4]]) }).view[2], /No tool calls in what was read of the sessions listed\./);
});

test("the pipeline: each workflow's phases in the order they began, an agent a mark; the sessions' own agents", () => {
  const done = agent({
    key: 'w:2', type: 'workflow', title: 'docs-pass', state: 'done', durationMs: 2 * MINUTE, lastActive: NOW - 50 * MINUTE,
    counts: { running: 0, done: 4, failed: 0, total: 4 },
    children: [1, 2, 3, 4].map((i) => agent({ key: `a:w:${i}`, type: 'agent', title: `write:${i}`, phase: 'Write', state: 'done', startedAt: NOW - (60 - i) * MINUTE })),
  });
  const rows = sessions();
  rows[4].children = [done];
  const { view, hits, top } = draw('pipeline', { snap: fullSnapshot({ rows }), height: 24 });
  assert.match(view[1], /^ ─ Pipeline ─+ 2 workflows · 1 running ─$/);
  assert.equal(view[2], ' ● review-changes  3/6 done · 2 running · 1 failed · 5m00s  Add the views');
  assert.equal(view[3], '    Review         ✓✓✗    2 done, 1 failed');
  assert.match(view[4], /^ {4}Verify {9}✓[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]{2} {4}2 running, 1 done$/);
  assert.equal(view[5], ' ✓ docs-pass  4/4 done · 2m00s  Old idea');
  assert.equal(view[6], '    Write          ✓✓✓✓   4 done');
  assert.equal(view[7], '');
  assert.equal(view[8], ' Agents');
  assert.match(view[9], /^ {4}Add the views {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] {6}Explore the parser$/);
  assert.deepEqual(clickAt(hits, 50, top + 3), { open: 'w:1' });
  assert.deepEqual(clickAt(hits, 50, top + 9), { open: 'a:explore' }, 'the agent at work');
  assert.match(draw('pipeline', { snap: snapshot([sessions()[4]]) }).view[2], /No workflows or agents in the sessions listed\./);
});

test('the files changed in the last hour: the latest first, one being changed marked, one two sessions changed flagged', () => {
  const rows = sessions();
  rows[0].calls?.push(
    call('c11', 'Edit', 'Edit: src/old.js', 2 * 3600, 1, { file: '/work/monitor/src/old.js' }),
    call('c12', 'Edit', 'Edit: src/bad.js', 90, 1, { file: '/work/monitor/src/bad.js', error: true }),
  );
  // A path written another way on Windows is the same file.
  const win = agent({ key: 's:win', title: 'On Windows', state: 'idle', cwd: 'C:\\work\\app', calls: [call('w1', 'Edit', 'Edit: a.js', 30, 1, { file: 'C:\\work\\app\\src\\a.js' })] });
  const win2 = agent({ key: 's:win2', title: 'Also there', state: 'idle', cwd: 'c:/work', calls: [call('w2', 'Write', 'Write: a.js', 20, 1, { file: 'c:/work/app/src/A.js' })] });
  const { view, hits, top } = draw('files', { snap: fullSnapshot({ rows: [...rows, win, win2] }), height: 24 });
  assert.match(view[1], /^ ─ Files changed in the last hour ─+ 4 files · by 4 sessions · 2 by more than one ─$/);
  assert.deepEqual(view.slice(2, 7).map((l) => l.replace(/ {2,}/g, '|')), [
    ' ✎ src/panels.js|Add the views|1 edit|2s',
    ' ! src\\a.js|2 sessions|2 edits|19s|On Windows, Also t…',
    ' ! README.md|2 sessions|2 edits|49s|Add the views, Bui…',
    '|src/canvas.js|Add the views|1 edit|4m',
    '',
  ], 'the failed edit and the one more than an hour ago left out');
  assert.deepEqual(clickAt(hits, 10, top + 3), { open: 's:win2' }, 'the session that changed it last');
});

test("the chart: the session's window and the week, as sampled, carried on to now and on at its pace; when in the day it was used", () => {
  const { view } = draw('chart', { height: 48 });
  assert.match(view[1], new RegExp(`^ ─ Usage ─+ sampled ${clock(NOW - 10 * MINUTE, NOW)} ─$`));
  assert.equal(view[2], ` session ~43%   resets ${timeOfDay(NOW + 2 * HOUR)}, in 2h00m · +9%/h`);
  assert.match(view[3], /^100% ⠁⠈ ⠁⠈ /, 'a dotted line at 100%');
  assert.match(view[8], /^ 50% /);
  assert.match(view[12], /^ {2}0% {2}⢀⣀/, 'its samples from 0, on the left');
  assert.match(view[13], new RegExp(`^ {5}${timeOfDay(NOW - 3 * HOUR)} +▴now +${timeOfDay(NOW + 2 * HOUR)}$`), 'its window: three hours gone, two to go');
  assert.equal(view[14], ` week    ~63%   resets ${weekday(NOW + 2 * DAY)} ${timeOfDay(NOW + 2 * DAY)} · +13%/d`);
  const changed = draw('chart', { snap: fullSnapshot({ usage: { ...USAGE, changed: { t: NOW - 2 * DAY, v: 43 } } }), height: 48 }).view;
  assert.equal(changed[14], ` week    ~63%   resets ${weekday(NOW + 2 * DAY)} ${timeOfDay(NOW + 2 * DAY)} · +10%/d`, 'since the plan changed: 20 points in two days');
  const weekOnly = { ...USAGE, session: undefined, tracked: { at: NOW, week: 63, weekReset: USAGE.tracked.weekReset } };
  assert.equal(draw('chart', { snap: fullSnapshot({ usage: weekOnly }), height: 48 }).view[2], ` session${' '.repeat(8)}not in the last check`, 'the last check without it');
  assert.match(view[25], /▴now/);
  assert.equal(view[27], ' hour 0           6           12          18');
  const days = view.slice(28, 35);
  assert.deepEqual(days.map((l) => l.slice(1, 4)), Array.from({ length: 7 }, (_, i) => weekday(NOW - (6 - i) * DAY)));
  // Today's hours to come are blank; the hours when the samples rose shaded.
  const hour = new Date(NOW).getHours();
  assert.ok(days[6].length > 6 + 2 * hour && days[6].length <= 6 + 2 * (hour + 1), days[6]);
  assert.match(days[6], /[░▒▓█]/);
  assert.match(days[0], /^ \w{3} {2}(· ){23}·$/);
  // Shorter: the session alone, then no hours.
  assert.ok(!draw('chart', { height: 20 }).view.some((l) => l.startsWith(' week')));
  assert.ok(!draw('chart', { height: 30 }).view.some((l) => l.startsWith(' hour')));
  assert.match(draw('chart', { snap: fullSnapshot({ usage: undefined }) }).view[2], /No usage known: the desktop app samples it while it runs\./);
});

test("who used the limits: each session's points as a bar of the whole, what the replies read leave out, and by model", () => {
  const { view, hits, top } = draw('share', { height: 26 });
  const bar = (/** @type {number} */ n) => `${'█'.repeat(n)}${'░'.repeat(30 - n)}`;
  assert.deepEqual(view.slice(2, 14), [
    ` session ~43%  this computer: 29 points since ${timeOfDay(NOW - 3 * HOUR)}`,
    `   ${'Add the views'.padEnd(24)} ${bar(6)}    20`,
    `   ${'Fix the login'.padEnd(24)} ${bar(3)}   8.5`,
    `   ${'scripts'.padEnd(24)} ${bar(0)}   0.4`,
    `   ${'elsewhere'.padEnd(24)} ${bar(4)}    14  not in the replies read here`,
    `   ${'by model'.padEnd(24)} opus 5.5 29 · haiku 5.5 0.4`,
    '',
    ` week    ~63%  this computer: 34 points since ${clock(NOW - 5 * DAY, NOW)}`,
    `   ${'Add the views'.padEnd(24)} ${bar(7)}    22`,
    `   ${'Fix the login'.padEnd(24)} ${bar(4)}    12`,
    `   ${'elsewhere'.padEnd(24)} ${bar(9)}    29  not in the replies read here`,
    `   ${'by model'.padEnd(24)} opus 5.5 34`,
  ]);
  assert.deepEqual(clickAt(hits, 10, top + 3), { open: 's:work' });
  assert.deepEqual(clickAt(hits, 10, top + 5), { unselect: true }, 'a session not listed');
  assert.match(draw('share', { snap: fullSnapshot({ usage: { ...USAGE, split: undefined } }) }).view[2], /Not known yet/);
});

test('today: the counts, the time waited on you, the tokens, the models, the replies hour by hour, and the tools', () => {
  const { view } = draw('today', { height: 26 });
  assert.match(view[1], /^ ─ Today ─+ since midnight ─$/);
  assert.deepEqual(view.slice(2, 14), [
    '   4 sessions · 7 agents · 23 prompts · 412 replies · waited on you 17m',
    '   tokens   512k out · 48M in',
    '   models   opus 5.5 90% · haiku 5.5 10%',
    '   replies  ·  ▄▄▄███·  ▂▂▂',
    '            0                 6                 12                18',
    '   tools',
    `     Bash          ${'█'.repeat(72)} 120`,
    `     Read          ${'█'.repeat(54)} 90`,
    `     Edit          ${'█'.repeat(37)} 61`,
    `     update_plan   ${'█'.repeat(7)} 12`,
    '',
    '',
  ], 'the time waited: 14 minutes over, and the 3 the session waiting has waited so far');
  assert.match(draw('today', { snap: fullSnapshot({ today: undefined }) }).view[2], /Reading today's transcripts/);
  // Wide, with little room: the tools in two columns.
  const many = { ...TODAY, tools: /** @type {[string, number][]} */ (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((x, i) => [x, 80 - i])) };
  const wide = draw('today', { width: 120, height: 22, snap: fullSnapshot({ today: many }) }).view;
  assert.match(wide.find((l) => l.startsWith('     A ')) ?? '', /^ {5}A .* 80 +B .* 79$/);
});

test('the tank: as full as the session\'s percent, each reply falling in some seconds after it was written; the week\'s beside it, which the replies fall into where the session\'s points for them are not known', () => {
  const { view } = draw('tank', { height: 30 });
  assert.match(view[1], /^ ─ Tank ─+ 1 reply in the last 30s ─$/);
  assert.equal(view[2].slice(0, 28), `  ┌${'─'.repeat(24)}┐`);
  const inside = view.slice(3, 17).map((l) => l.slice(3, 27));
  // 43% of 14 lines: 6 full, the surface above them.
  assert.equal(inside.filter((l) => l === '█'.repeat(24)).length, 6);
  assert.match(inside[7], /^(≈~)+$|^(~≈)+$/);
  assert.equal(view[10].slice(28).trim().split(/ {2,}/)[0], '~43%');
  assert.equal(view[11].slice(28, 36), ' +9%/h  ');
  assert.equal(view[12].slice(28, 41), ` resets ${timeOfDay(NOW + 2 * HOUR)}`);
  assert.equal(view[3].slice(28, 33), ' 100%');
  assert.equal(view[18].trim().split(/ {2,}/).join('|'), 'session|week');
  assert.match(view[7], /~63%/, "the week's at its own surface");
  assert.deepEqual([view[8].slice(71), view[9].slice(71)], ['+0.4%/h', `resets ${weekday(NOW + 2 * DAY)}`], 'with its own pace, in tenths below one, and its reset');
  // The reply written 16 seconds ago and read 10 seconds ago falls in now; it fell before it was read, and is in a moment after.
  /** The drops falling in a tank, its inside from column `x`. @param {string[]} v @param {number} x */
  const fallingIn = (v, x) => v.slice(3, 10).map((l) => l.slice(x, x + 24)).join('').replace(/[ ≈~█]/g, '');
  /** The drops falling in the session's tank, at a time. @param {number} now */
  const drops = (now) => fallingIn(draw('tank', { height: 30, now }).view, 3);
  assert.equal(drops(NOW), '•');
  assert.equal(drops(NOW - 1500), '', 'not yet');
  assert.equal(drops(NOW + 600), '', 'fallen in');
  // Where the session's points for the replies are not known, they fall into the week's tank, as big as their points of it.
  const toWeek = USAGE.drops?.map((d) => ({ ...d, limit: /** @type {const} */ ('week'), v: 0.04 }));
  const both = draw('tank', { height: 30, snap: fullSnapshot({ usage: { ...USAGE, drops: toWeek } }) }).view;
  assert.deepEqual([fallingIn(both, 3), fallingIn(both, 45)], ['', '·']);
  // No session's percent at all, as after a change of plan: the week's tank alone, where the session's was.
  const weekOnly = { ...USAGE, session: undefined, tracked: { at: NOW, week: 63, weekReset: USAGE.tracked?.weekReset, weekPace: 4.2 }, drops: toWeek };
  const alone = draw('tank', { height: 30, snap: fullSnapshot({ usage: weekOnly }) }).view;
  assert.match(alone[1], /^ ─ Tank ─+ 1 reply in the last 30s ─$/);
  assert.equal(alone[18].trim(), 'week');
  assert.deepEqual(alone.slice(7, 10).map((l) => l.slice(29)), ['~63%', '+4%/h', `resets ${weekday(NOW + 2 * DAY)}`]);
  assert.equal(fallingIn(alone, 3), '·');
  assert.match(draw('tank', { snap: fullSnapshot({ usage: { ...USAGE, drops: [] } }) }).view[1], /each reply a drop ─$/);
  assert.match(draw('tank', { snap: fullSnapshot({ usage: undefined }) }).view[2], /No usage known/);
});

test('the radar: a blip for each session, nearer the middle the more lately it did something; the sweep goes round', () => {
  const { view, hits, top } = draw('radar', { height: 26, index: 2 });
  assert.match(view[1], /^ ─ Radar ─+ nearer the middle, the more lately ─$/);
  assert.deepEqual(view.slice(2, 8).map((l) => l.slice(32)), [
    `>● ${'Add the views'.padEnd(30)}   2s`,
    ` ◐ ${'Build the site'.padEnd(30)}  20s`,
    ` ◆ ${'Fix the login'.padEnd(30)}   3m`,
    ` • ${'Write the docs'.padEnd(30)}   8m`,
    ` ○ ${'Old idea'.padEnd(30)}  40m`,
    ` · ${'Gone home'.padEnd(30)}   3h`,
  ], 'the latest first, the selected one marked');
  assert.equal(view[16].slice(33), 'rings: 1m, 10m, 1h, 24h');
  // Two seconds ago: in the middle, with its name beside it where nothing is.
  assert.equal(view[9].slice(15, 27), '● Add the v…');
  assert.deepEqual(clickAt(hits, 15, top + 9), { open: 's:work' });
  assert.deepEqual(clickAt(hits, 50, top + 4), { open: 's:wait' });
  // With sessions that did nothing lately, which stay where they are.
  const still = snapshot(sessions().slice(3));
  const radar = (/** @type {number} */ now) => draw('radar', { snap: still, height: 26, now }).view.map((l) => l.slice(0, 31)).join('\n');
  assert.notEqual(radar(NOW), radar(NOW + SECOND), 'the sweep moves');
  assert.equal(radar(NOW), radar(NOW + 4 * SECOND), 'round in four seconds');
});

test('the spark: asleep when none works, turning when some do, waving when one needs you, yellow then red near a limit', () => {
  const idle = snapshot([sessions()[4]]);
  const asleep = draw('spark', { snap: idle, height: 20 }).view;
  assert.ok(asleep.some((l) => /^ {11}·/.test(l)), 'its middle alone');
  assert.ok(asleep.some((l) => /[zZ]/.test(l)), 'and its z');
  assert.ok(asleep.some((l) => l.endsWith('asleep: none at work')));
  const { view } = draw('spark', { height: 20 });
  const middle = view.findIndex((l) => l.includes('2 at work'));
  assert.match(view[middle], /^ {3}─{8}.─{8} - {3}2 at work · 1 for you · 1 unread$|^ {3}─{8}.─{8} {5}2 at work · 1 for you · 1 unread$/);
  assert.equal(view[middle + 1], `${' '.repeat(11)}|${' '.repeat(13)}session ~43%  week ~63%`, 'a ray down');
  assert.ok(view.some((l) => l.includes('?')), 'it asks');
  // Its color: yellow, then bold yellow from 75%, red from 90%, dim asleep.
  /** The style of its middle with the session at `v` percent. @param {number} v @param {import('../src/monitor.js').Snapshot} [snap] */
  const styleAt = (v, snap = fullSnapshot({ usage: { ...USAGE, tracked: { ...USAGE.tracked, session: v } } })) => {
    const { lines, top } = draw('spark', { snap, height: 20, t: color });
    return /\x1b\[([0-9;]+)m─*[·✢✳✶✻✽]/.exec(lines.slice(top).join('\n'))?.[1];
  };
  assert.deepEqual([styleAt(43), styleAt(80), styleAt(92), styleAt(92, snapshot([sessions()[4]], { usage: USAGE }))], ['33', '1;33', '31', '2']);
});

test('the views that move do so with the time they are drawn for, though nothing is at work', () => {
  const still = snapshot(sessions().slice(3), { usage: USAGE });
  for (const name of ['floor', 'tank', 'radar', 'spark']) {
    const at = (/** @type {number} */ now) => draw(name, { snap: still, now, height: 30 }).view.join('\n');
    assert.ok([300, 500, 700, 1100].some((ms) => at(NOW) !== at(NOW + ms)), name);
  }
  // The pipeline's agents at work turn.
  const at = (/** @type {number} */ now) => draw('pipeline', { now }).view.join('\n');
  assert.notEqual(at(NOW), at(NOW + 100));
});

test('the board below the list at first; v and V step through the views, round and round, saying which; --view starts with another', () => {
  const monitor = { dir: '/home/me/.claude', windowMs: DAY };
  const viewer = new Viewer({ monitor, t: plain, agents: 'running', showEnded: true });
  assert.equal(viewer.ui.panel, 'board');
  viewer.key({ name: 'V' });
  assert.equal(viewer.ui.panel, 'floor');
  assert.match(viewer.ui.message, /^floor: each session as a figure/);
  viewer.key({ name: 'V' });
  viewer.key({ name: 'V' });
  assert.equal(viewer.ui.panel, 'spark', 'before the first, the last');
  for (const _ of VIEWS) viewer.key({ name: 'v' });
  assert.equal(viewer.ui.panel, 'spark', 'round');
  assert.equal(new Viewer({ monitor, t: plain, agents: 'running', showEnded: true, view: 'radar' }).ui.panel, 'radar');
  assert.equal(new Viewer({ monitor, t: plain, agents: 'running', showEnded: true, view: 'nope' }).ui.panel, 'overview');
  // In the filter, v is typed.
  viewer.key({ name: '/' });
  viewer.key({ name: 'v', ch: 'v' });
  assert.deepEqual([viewer.ui.panel, viewer.ui.filter], ['spark', 'v']);
});

test('the screen is drawn often while a view that moves of itself is shown, where there is room for it', () => {
  const viewer = new Viewer({ monitor: { dir: '/home/me/.claude', windowMs: DAY }, t: plain, agents: 'running', showEnded: true, view: 'radar' });
  const snap = snapshot([agent({ key: 's:i', title: 'Idle', state: 'idle' })]);
  viewer.lines(snap, { width: 100, height: 30, now: NOW });
  assert.deepEqual([viewer.animating, viewer.spinning], [true, true], 'though nothing is at work');
  viewer.lines(snap, { width: 100, height: 4, now: NOW });
  assert.deepEqual([viewer.animating, viewer.spinning], [false, false], 'no room for it below the row');
  viewer.key({ name: 'V' });
  viewer.lines(snap, { width: 100, height: 30, now: NOW });
  assert.deepEqual([viewer.ui.panel, viewer.animating], ['tank', true]);
  viewer.key({ name: 'V' });
  viewer.lines(snap, { width: 100, height: 30, now: NOW });
  assert.deepEqual([viewer.ui.panel, viewer.animating], ['today', false]);
  viewer.key({ name: 'v' });
  viewer.key({ name: '?' });
  viewer.lines(snap, { width: 100, height: 30, now: NOW });
  assert.deepEqual([viewer.animating, viewer.spinning], [false, false], 'in the help');
});

test("the board's moves are kept whatever view is shown, each for a while", () => {
  const viewer = new Viewer({ monitor: { dir: '/home/me/.claude', windowMs: DAY }, t: plain, agents: 'running', showEnded: true, view: 'overview' });
  const at = (/** @type {import('../src/monitor.js').State} */ state) => snapshot([agent({ key: 's:a', title: 'Some session', state }), agent({ key: 's:b', title: 'Other', state: 'idle' })]);
  const screen = (/** @type {number} */ now) => ({ width: 100, height: 30, now });
  viewer.lines(at('working'), screen(NOW));
  assert.equal(viewer.ui.moves.size, 0, 'nothing to move from at first');
  viewer.lines(at('waiting'), screen(NOW + SECOND));
  assert.deepEqual([...viewer.ui.moves], [['s:a', { from: 'Working', to: 'Needs you', at: NOW + SECOND }]]);
  viewer.key({ name: 'v' });
  viewer.key({ name: 'v' });
  const board = viewer.lines(at('waiting'), screen(NOW + 2 * SECOND));
  assert.ok(board.some((l) => l.includes('from Working')), board.join('\n'));
  assert.ok(board.some((l) => l.includes('┄ Some session')));
  viewer.lines(at('waiting'), screen(NOW + SECOND + MOVED));
  assert.equal(viewer.ui.moves.size, 0, `gone after ${MOVED / SECOND}s`);
});

test('the help lists the views below the list, which v and V step through, the one shown marked', () => {
  const ui = { ...initialUi(), panel: 'tank' };
  const text = helpLines(ui, { width: 100, height: 200, now: NOW }, plain, '/home/me/.claude', true, VIEWS).map((l) => l.trimEnd());
  assert.ok(text.includes('   v V           the next view below the list, or the one before'));
  assert.ok(text.includes(' The overview, one of the views below the list, where there is room'));
  const at = text.indexOf(' Views below the list, which v and V step through');
  assert.ok(at > 0);
  const listed = text.slice(at + 1).filter((l) => /^ {3}\S/.test(l));
  assert.deepEqual(listed.map((l) => l.trim().split(' ')[0]), VIEWS.map((v) => v.name));
  assert.match(text.slice(at).join('\n'), /tank {10}the session's limit as a tank the replies drip into, and the week's\s+\(shown\)/);
  // Given none, neither the key nor the list: what is below the list is the overview.
  const alone = helpLines(initialUi(), { width: 100, height: 200, now: NOW }, plain, '/home/me/.claude').map((l) => l.trimEnd());
  assert.doesNotMatch(alone.join('\n'), /v V|Views below/);
  assert.ok(alone.includes(' Below the list, where there is room'));
});
