import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeOfDay, weekday, width } from '../src/format.js';
import { columns, detailLines, helpLines, initialUi, listLines, makeTheme, settleSelection, table, visibleRows, wrapStyled } from '../src/view.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE, NOW } from './helpers/fixture.js';

const plain = makeTheme({ color: false, ascii: false, animate: false });
/** @param {string} s */
const visible = (s) => width(s.replace(/\x1b\[[0-9;]*m/g, ''));

/** A session at work with its agents: a subagent at work and one done, and a workflow with an agent at work and one done. */
function busySession() {
  return agent({
    key: 's:busy', title: 'Busy session', state: 'working', project: 'demo', lastActive: NOW - 5 * MINUTE,
    children: [
      agent({ key: 'a:1', type: 'subagent', title: 'find the parser', state: 'running', agentType: 'Explore', activity: 'Grep: parse', activityKind: 'tool', activityAt: NOW - 20_000 }),
      agent({ key: 'a:2', type: 'subagent', title: 'write tests', state: 'done', live: false }),
      agent({
        key: 'w:1', type: 'workflow', title: 'review-changes', state: 'running', phase: 'Review',
        children: [
          agent({ key: 'a:3', type: 'agent', title: 'review:bugs', state: 'running', phase: 'Review' }),
          agent({ key: 'a:4', type: 'agent', title: 'review:perf', state: 'done', live: false, phase: 'Review' }),
        ],
      }),
    ],
  });
}

function sessions() {
  return [
    agent({ key: 's:idle', title: 'Idle session', state: 'idle', project: 'zeta', lastActive: NOW - MINUTE }),
    busySession(),
    agent({
      key: 's:wait', title: 'Waiting session', state: 'waiting', project: 'alpha', lastActive: NOW - 10 * MINUTE,
      activity: 'waiting: permission: Bash', activityKind: 'waiting', activityAt: NOW - 10 * MINUTE,
    }),
    agent({ key: 's:end', title: 'Ended session', state: 'ended', live: false, project: 'beta', lastActive: NOW - HOUR }),
    agent({ key: 's:act', title: 'Active session', state: 'active', live: false, project: 'gamma', lastActive: NOW - 30_000 }),
  ];
}

test('sessions are listed by state, each with its agents at work under it', () => {
  const rows = visibleRows(snapshot(sessions()), initialUi(), plain);
  assert.deepEqual(rows.map((r) => r.prefix + r.agent.title), [
    'Waiting session',
    'Busy session',
    '├─ find the parser',
    '└─ review-changes',
    '   └─ review:bugs',
    'Active session',
    'Idle session',
    'Ended session',
  ]);
});

test('every agent, or none; and the sessions that ended hidden', () => {
  const all = visibleRows(snapshot([busySession()]), { ...initialUi(), agents: 'all' }, plain);
  assert.deepEqual(all.map((r) => r.prefix + r.agent.title), [
    'Busy session', '├─ find the parser', '├─ write tests', '└─ review-changes', '   ├─ review:bugs', '   └─ review:perf',
  ]);
  const none = visibleRows(snapshot(sessions()), { ...initialUi(), agents: 'none', showEnded: false }, plain);
  assert.deepEqual(none.map((r) => r.agent.title), ['Waiting session', 'Busy session', 'Active session', 'Idle session']);
});

test('the filter keeps the sessions it matches, and those with an agent it matches', () => {
  const titles = (/** @type {string} */ filter) => visibleRows(snapshot(sessions()), { ...initialUi(), filter }, plain).map((r) => r.agent.title);
  assert.deepEqual(titles('PARSER'), ['Busy session', 'find the parser', 'review-changes', 'review:bugs']);
  assert.deepEqual(titles('alpha'), ['Waiting session']);
  assert.deepEqual(titles('nothing like it'), []);
});

test('the sorts: most recent, name, project', () => {
  const titles = (/** @type {import('../src/view.js').Sort} */ sort) =>
    visibleRows(snapshot(sessions()), { ...initialUi(), sort, agents: 'none' }, plain).map((r) => r.agent.title);
  assert.deepEqual(titles('recent'), ['Active session', 'Idle session', 'Busy session', 'Waiting session', 'Ended session']);
  assert.deepEqual(titles('name'), ['Active session', 'Busy session', 'Ended session', 'Idle session', 'Waiting session']);
  assert.deepEqual(titles('project'), ['Waiting session', 'Ended session', 'Busy session', 'Active session', 'Idle session']);
});

test('a session the desktop app shows unread: its dot, counted, and listed after those waiting', () => {
  const snap = snapshot([
    ...sessions(),
    agent({ key: 's:new', title: 'Unread session', state: 'idle', project: 'delta', lastActive: NOW - 20 * MINUTE, unread: true }),
    agent({ key: 's:old', title: 'Unread and ended', state: 'ended', live: false, project: 'eta', lastActive: NOW - 2 * HOUR, unread: true }),
  ]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('none') };
  const rows = visibleRows(snap, ui, plain);
  assert.deepEqual(rows.map((r) => r.agent.title), [
    'Waiting session', 'Unread session', 'Unread and ended', 'Busy session', 'Active session', 'Idle session', 'Ended session',
  ]);
  const lines = listLines(snap, rows, ui, { width: 120, height: 12, now: NOW }, plain);
  assert.match(lines[0], /◆ 1 waiting {2}• 2 unread {2}○ 1 idle {2}◌ 1 active {2}· 1 ended /);
  assert.match(lines[3], /^ • delta +Unread session /);
  const ascii = makeTheme({ color: false, ascii: true, animate: false });
  assert.match(listLines(snap, rows, ui, { width: 120, height: 12, now: NOW }, ascii)[3], /^ @ delta +Unread session /);
});

/**
 * A session whose last turn ended blocked on you, as the desktop app's summary says.
 * @param {Partial<import('../src/monitor.js').Agent>} o
 */
const blockedSession = (o) => agent({
  state: 'idle', blocked: true, activityKind: 'blocked', activityAt: NOW - 30 * MINUTE,
  turn: { category: 'blocked', detail: 'Stutter: picture or sound?', needs: 'say whether the stutter was picture or sound' },
  activity: 'blocked: say whether the stutter was picture or sound', ...o,
});

test('a session whose last turn ended blocked on you: its mark, counted, listed with those waiting, not dimmed', () => {
  const snap = snapshot([
    ...sessions(),
    blockedSession({ key: 's:blk', title: 'Blocked session', project: 'theta', lastActive: NOW - 30 * MINUTE, unread: true }),
    blockedSession({ key: 's:gone', title: 'Blocked and ended', state: 'ended', live: false, project: 'iota', lastActive: NOW - 3 * HOUR }),
  ]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('none') };
  const rows = visibleRows(snap, ui, plain);
  assert.deepEqual(rows.map((r) => r.agent.title), [
    'Waiting session', 'Blocked session', 'Blocked and ended', 'Busy session', 'Active session', 'Idle session', 'Ended session',
  ]);
  const lines = listLines(snap, rows, ui, { width: 160, height: 12, now: NOW }, plain);
  assert.match(lines[0], /◆ 1 waiting {2}◇ 2 blocked {2}○ 1 idle/);
  assert.doesNotMatch(lines[0], /unread/, 'blocked shows before unread');
  assert.match(lines[3], /^ ◇ theta +Blocked session +blocked: say whether the stutter was picture or sound +30m/);
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const ended = listLines(snap, visibleRows(snap, ui, color), ui, { width: 160, height: 12, now: NOW }, color)[4];
  assert.ok(ended.includes('\x1b[1;33mblocked: say whether'), `a session that ended, blocked, still waits on you: ${JSON.stringify(ended)}`);
});

test('the selection stays on its row as rows move, and at its place when its row goes', () => {
  const rows = (/** @type {string[]} */ keys) => keys.map((key) => ({ agent: agent({ key, title: key }), depth: 0, prefix: '' }));
  const ui = initialUi();
  const ten = rows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  settleSelection(ui, ten, 4);
  assert.equal(ui.selected, 'a');
  ui.selected = 'h';
  settleSelection(ui, ten, 4);
  assert.equal(ui.index, 7);
  assert.equal(ui.top, 4, 'the selected row is on screen');
  settleSelection(ui, rows(['h', 'a', 'b']), 4);
  assert.equal(ui.index, 0);
  assert.equal(ui.top, 0);
  Object.assign(ui, { index: 2, selected: 'b' });
  settleSelection(ui, rows(['h', 'a']), 4);
  assert.equal(ui.index, 1);
  assert.equal(ui.selected, 'a');
  settleSelection(ui, [], 4);
  assert.equal(ui.index, 0);
  assert.equal(ui.selected, undefined);
});

test('the columns fill the width; a narrow screen drops the least needed', () => {
  for (const cols of [20, 40, 72, 80, 100, 120, 160, 200]) {
    assert.equal(columns(cols).reduce((n, c) => n + c.width + 1, 0), cols, `${cols} columns`);
  }
  assert.deepEqual(columns(80).map((c) => c.key), ['state', 'project', 'title', 'activity', 'last']);
  assert.deepEqual(columns(109).map((c) => c.key), ['state', 'project', 'title', 'model', 'ctx', 'activity', 'last']);
  assert.deepEqual(columns(110).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'activity', 'last']);
  assert.deepEqual(columns(118).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'activity', 'last', 'kind']);
  assert.deepEqual(columns(160).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'activity', 'last', 'pid', 'kind']);
});

test("the effort each one works at: a column after the model, and in an agent's details", () => {
  const busy = busySession();
  busy.effort = 'max';
  busy.model = 'claude-opus-5-5';
  const explorer = /** @type {import('../src/monitor.js').Agent} */ (busy.children[0]);
  Object.assign(explorer, { model: 'claude-haiku-4-5', effort: 'medium' });
  const snap = snapshot([busy, agent({ key: 's:old', title: 'Old session', state: 'idle', model: 'claude-sonnet-5-5' })]);
  const ui = initialUi();
  const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 120, height: 10, now: NOW }, plain);
  assert.match(lines[1], /^ {3}PROJECT +NAME +MODEL +EFFORT +CTX +ACTIVITY +LAST +KIND +$/);
  assert.match(lines.find((l) => l.includes('Busy session')) ?? '', /opus 5\.5 +max +/);
  assert.match(lines.find((l) => l.includes('find the parser')) ?? '', /haiku 4\.5 +medium +/);
  assert.match(lines.find((l) => l.includes('Old session')) ?? '', /sonnet 5\.5 {8}/, 'none known: the cell is empty');
  const filtered = (/** @type {string} */ filter) => visibleRows(snap, { ...ui, filter, agents: 'none' }, plain).map((r) => r.agent.title);
  assert.deepEqual(filtered('max'), ['Busy session']);
  assert.deepEqual(filtered('medium'), ['Busy session'], 'by an agent of it');
  const details = detailLines(explorer, snap, ui, { width: 100, height: 20, now: NOW }, plain).join('\n');
  assert.match(details, /Model {6}claude-haiku-4-5 · effort medium/);
});

test('ultracode: a + after the effort, magenta, and spelled out in the details', () => {
  const busy = busySession();
  Object.assign(busy, { model: 'claude-opus-5-5', effort: 'max', ultracode: true });
  const old = agent({ key: 's:old', title: 'Old session', state: 'ended', live: false, model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true });
  const snap = snapshot([
    busy,
    agent({ key: 's:x', title: 'Other session', state: 'idle', model: 'claude-opus-5-5', effort: 'xhigh' }),
    agent({ key: 's:m', title: 'Medium session', state: 'idle', model: 'claude-opus-5-5', effort: 'medium', ultracode: true }),
    agent({ key: 's:n', title: 'New session', state: 'idle', ultracode: true }),
    old,
  ]);
  const ui = { ...initialUi(), showEnded: true };
  const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 120, height: 12, now: NOW }, plain);
  const line = (/** @type {string} */ title) => lines.find((l) => l.includes(title)) ?? '';
  assert.match(line('Busy session'), /opus 5\.5 +max\+ +/);
  assert.match(line('Other session'), /opus 5\.5 +xhigh +/);
  assert.match(line('Medium session'), /opus 5\.5 +medium\+ +/, 'the longest fits');
  assert.match(line('New session'), / {12}ultra +/, 'no effort known: the word');
  assert.deepEqual(visibleRows(snap, { ...ui, filter: 'ultracode', agents: 'none' }, plain).map((r) => r.agent.title), ['Busy session', 'Medium session', 'New session', 'Old session']);
  const details = detailLines(busy, snap, ui, { width: 100, height: 30, now: NOW }, plain).join('\n');
  assert.match(details, /Model {6}claude-opus-5-5 · effort max · ultracode/);
  // In color, with another row selected: the selected one is drawn plain, inverted.
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const other = { ...ui, selected: 's:x' };
  const rows = visibleRows(snap, other, color);
  settleSelection(other, rows, 8);
  const colored = listLines(snap, rows, other, { width: 120, height: 12, now: NOW }, color);
  assert.match(colored.find((l) => l.includes('Busy session')) ?? '', /\x1b\[35mmax\+ +\x1b\[0m/);
  assert.match(colored.find((l) => l.includes('Old session')) ?? '', /\x1b\[2mxhigh\+ +\x1b\[0m/, 'dim, as the rest of a row that ended');
});

test('the list fills the screen: each line as wide as it, the last one column less', () => {
  const snap = snapshot(sessions());
  for (const cols of [30, 80, 160]) {
    const ui = initialUi();
    const rows = visibleRows(snap, ui, plain);
    settleSelection(ui, rows, 17);
    const lines = listLines(snap, rows, ui, { width: cols, height: 20, now: NOW }, plain);
    assert.equal(lines.length, 20);
    lines.slice(0, -1).forEach((l, i) => assert.equal(visible(l), cols, `line ${i} at ${cols} columns: ${l}`));
    assert.equal(visible(lines[19]), cols - 1);
  }
});

test('the header counts the sessions by state, and the agents at work', () => {
  const snap = snapshot(sessions());
  const ui = initialUi();
  const [header] = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 160, height: 10, now: NOW }, plain);
  assert.match(header, /^ Claude agents {2}● 1 working {2}◆ 1 waiting {2}○ 1 idle {2}◌ 1 active {2}· 1 ended {2}2 agents at work +\d\d:\d\d:\d\d $/);
});

test('the plan\'s usage at the top, before the time: how old once it is, and what is over left out', () => {
  /** The header with this usage. @param {import('../src/usage.js').Usage} usage @param {number} [cols] @param {ReturnType<typeof makeTheme>} [t] */
  const top = (usage, cols = 160, t = plain) => {
    const snap = snapshot(sessions(), { usage });
    const ui = initialUi();
    return listLines(snap, visibleRows(snap, ui, t), ui, { width: cols, height: 10, now: NOW }, t)[0];
  };
  const fresh = { at: NOW - 10 * MINUTE, session: 64, week: 29 };
  assert.match(top(fresh), /^ Claude agents {2}● 1 working .* 2 agents at work +session 64% {2}week 29% {2}\d\d:\d\d:\d\d $/);
  assert.match(top({ ...fresh, at: NOW - 2 * HOUR }), /at work +session 64% {2}week 29% {2}2h ago {2}\d\d:\d\d:\d\d $/);
  assert.match(top({ ...fresh, at: NOW - 6 * HOUR }), /at work +week 29% {2}6h ago {2}\d\d:\d\d:\d\d $/, 'the session\'s five hours are over');
  assert.match(top({ ...fresh, at: NOW - 8 * 24 * HOUR }), /at work +\d\d:\d\d:\d\d $/, 'and the week');
  assert.match(top({ at: NOW, week: 100 }), /at work +week 100% {2}\d\d:\d\d:\d\d $/);
  // Yellow from 75%, red from 90%.
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const high = top({ at: NOW, session: 92, week: 75 }, 160, color);
  assert.ok(high.includes('\x1b[2msession\x1b[0m \x1b[31m92%\x1b[0m  \x1b[2mweek\x1b[0m \x1b[33m75%\x1b[0m'), JSON.stringify(high));
  assert.ok(top({ at: NOW, session: 74, week: 0 }, 160, color).includes('\x1b[2msession\x1b[0m 74%  \x1b[2mweek\x1b[0m 0%'));
  // Narrower, the least worth go first: the time, the sessions that ended and the agents at work,
  // the title and those idle or active, those at work, those waiting; the usage last. Then of
  // those, as many as fit come back, the most worth first.
  assert.match(top(fresh, 80), /^ Claude agents {2}● 1 working {2}◆ 1 waiting {2}○ 1 idle +session 64% {2}week 29% $/);
  assert.match(top(fresh, 52), /^ ● 1 working {2}◆ 1 waiting +session 64% {2}week 29% $/);
  assert.match(top(fresh, 43), /^ ◆ 1 waiting +session 64% {2}week 29% $/);
  assert.match(top(fresh, 30), /^ +session 64% {2}week 29% $/);
  assert.equal(top(fresh, 20), ' Claude agents  ● 1…');
  for (const cols of [160, 80, 52, 43, 30, 20]) assert.equal(visible(top(fresh, cols)), cols);
  // Without it, the same: what goes, goes whole, not cut.
  assert.match(top(undefined, 80), /^ Claude agents {2}● 1 working {2}◆ 1 waiting {2}○ 1 idle {2}◌ 1 active {2}· 1 ended +$/);
  assert.match(top(undefined, 43), /^ Claude agents {2}● 1 working {2}◆ 1 waiting +$/);
});

test('when the limits reset, after their percent where the samples tell it closely enough; the percent gone once it surely reset', () => {
  /** The header with this usage. @param {import('../src/usage.js').Usage} usage @param {number} [cols] @param {ReturnType<typeof makeTheme>} [t] */
  const top = (usage, cols = 160, t = plain) => {
    const snap = snapshot(sessions(), { usage });
    const ui = initialUi();
    return listLines(snap, visibleRows(snap, ui, t), ui, { width: cols, height: 10, now: NOW }, t)[0];
  };
  /** A reset likeliest at `at`, from and to so many minutes off it. @param {number} at @param {number} from @param {number} to */
  const reset = (at, from, to) => ({ at, from: at + from * MINUTE, to: at + to * MINUTE });
  const S = NOW + 2 * HOUR + 7 * MINUTE;
  const W = NOW + 3 * 24 * HOUR;
  const u = { at: NOW - 10 * MINUTE, session: 64, week: 29, sessionReset: reset(S, -10, 5), weekReset: reset(W, -9, 5) };
  const sessionAt = timeOfDay(NOW + 2 * HOUR + 5 * MINUTE);
  assert.match(top(u), new RegExp(`at work +session 64% resets ${sessionAt} {2}week 29% resets ${weekday(W)} {2}\\d\\d:\\d\\d:\\d\\d $`), 'the session\'s to five minutes; the week\'s day, more than a day off');
  const soon = NOW + 5 * HOUR;
  assert.match(top({ ...u, weekReset: reset(soon, -9, 5) }), new RegExp(`week 29% resets ${timeOfDay(soon)} {2}\\d`), 'less than a day off: its time');
  assert.match(top({ ...u, weekReset: reset(soon, -60, 60) }), new RegExp(`week 29% resets ${weekday(soon)} {2}\\d`), 'but known only within two hours: its day');
  assert.match(top({ ...u, sessionReset: reset(S, -40, 0), weekReset: reset(W, -13 * 60, 0) }), /at work +session 64% {2}week 29% {2}\d/, 'not known closely enough');
  assert.match(top({ ...u, sessionReset: reset(NOW - 20 * MINUTE, -10, -1) }), /at work +week 29% resets \w{3} {2}\d/, 'the session surely reset since');
  assert.match(top({ ...u, weekReset: reset(NOW - 2 * MINUTE, -9, -1) }), new RegExp(`at work +session 64% resets ${sessionAt} {2}\\d`), 'and the week');
  const color = makeTheme({ color: true, ascii: false, animate: false });
  assert.ok(top(u, 160, color).includes(`\x1b[2msession\x1b[0m 64% \x1b[2mresets\x1b[0m ${sessionAt}`));
  // Narrower, the resets go with those at work, before those waiting and the usage; then of those
  // gone, the most worth first, as many as fit come back.
  assert.match(top(u, 80), new RegExp(`^ ● 1 working {2}◆ 1 waiting +session 64% resets ${sessionAt} {2}week 29% resets ${weekday(W)} $`));
  assert.match(top(u, 60), new RegExp(`^ ● 1 working {2}◆ 1 waiting +session 64% {2}week 29% resets ${weekday(W)} $`));
  assert.match(top(u, 43), /^ ◆ 1 waiting +session 64% {2}week 29% $/);
  for (const cols of [160, 80, 60, 43]) assert.equal(visible(top(u, cols)), cols);
});

test('the usage carried on to now with this computer\'s replies, marked ~; how long ago only for what is sampled', () => {
  /** The header with this usage. @param {import('../src/usage.js').Usage} usage @param {ReturnType<typeof makeTheme>} [t] */
  const top = (usage, t = plain) => {
    const snap = snapshot(sessions(), { usage });
    const ui = initialUi();
    return listLines(snap, visibleRows(snap, ui, t), ui, { width: 160, height: 10, now: NOW }, t)[0];
  };
  /** A reset likeliest at `at`, from and to so many minutes off it. @param {number} at @param {number} from @param {number} to */
  const reset = (at, from, to) => ({ at, from: at + from * MINUTE, to: at + to * MINUTE });
  const W = NOW + 3 * 24 * HOUR;
  const sample = { at: NOW - 6 * HOUR, session: 10, week: 36, weekReset: reset(W, -9, 5) };
  const session = { session: 54, sessionReset: reset(NOW + 3 * HOUR + 2 * MINUTE, -10, 0) };
  const sessionAt = timeOfDay(NOW + 3 * HOUR);
  assert.match(
    top({ ...sample, tracked: { at: NOW, ...session, week: 43, weekReset: reset(W, -9, 5) } }),
    new RegExp(`at work +session ~54% resets ${sessionAt} {2}week ~43% resets ${weekday(W)} {2}\\d\\d:\\d\\d:\\d\\d $`),
  );
  assert.match(top({ ...sample, tracked: { at: NOW, ...session } }), new RegExp(`at work +session ~54% resets ${sessionAt} {2}week 36% resets ${weekday(W)} {2}6h ago {2}\\d`), 'the week as sampled');
  assert.match(top({ ...sample, tracked: { at: NOW, session: 0 } }), /at work +session ~0% {2}week 36% resets \w{3} {2}6h ago {2}\d/, 'no window: no reset');
  const color = makeTheme({ color: true, ascii: false, animate: false });
  assert.ok(top({ ...sample, tracked: { at: NOW, ...session, session: 92 } }, color).includes('\x1b[2msession\x1b[0m \x1b[31m~92%\x1b[0m'));
});

test('the selected row: marked with > without color, inverse with color', () => {
  const snap = snapshot(sessions());
  const ui = { ...initialUi(), selected: 's:idle' };
  const rows = visibleRows(snap, ui, plain);
  settleSelection(ui, rows, 17);
  const marked = listLines(snap, rows, ui, { width: 100, height: 20, now: NOW }, plain).filter((l) => l.startsWith('>'));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /Idle session/);
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const inverse = listLines(snap, visibleRows(snap, ui, color), ui, { width: 100, height: 20, now: NOW }, color).filter((l) => l.startsWith('\x1b[7m'));
  assert.equal(inverse.length, 1);
  assert.match(inverse[0], /Idle session/);
});

test('the footer: the filter in use first, as many keys as fit, and where the selection is', () => {
  const snap = snapshot(sessions());
  const footer = (/** @type {number} */ cols, filter = '') => {
    const ui = { ...initialUi(), filter };
    const rows = visibleRows(snap, ui, plain);
    settleSelection(ui, rows, 17);
    return listLines(snap, rows, ui, { width: cols, height: 20, now: NOW }, plain)[19];
  };
  assert.match(footer(160), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}s sort:status {2}e ended:on {2}a agents:running {2}w window {2}b bell:off {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(100), /^ ↑↓ move .*e ended:on {2}a agents:running {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(60), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}\? help {2}q quit +1\/8 $/);
  // As wide as a phone: the keys a tap can press.
  assert.match(footer(43), /^ ⏎ details {2}\/ filter {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(100, 'parser'), /^ filter "parser" esc clears {2}↑↓ move {2}⏎ details {2}\/ filter {2}\? help {2}q quit +1\/4 $/);
});

/**
 * What a click at x, y does, by the hits a view gave.
 * @param {import('../src/view.js').Hit[]} hits
 * @param {number} x
 * @param {number} y
 */
const clickAt = (hits, x, y) => hits.find((h) => h.y === y && x >= h.x0 && x < h.x1)?.action;

test('where a click goes in the list: a row selects it, a title sorts by it, a key below is pressed', () => {
  const snap = snapshot(sessions());
  const ui = initialUi();
  const rows = visibleRows(snap, ui, plain);
  settleSelection(ui, rows, 17);
  /** @type {import('../src/view.js').Hit[]} */
  const hits = [];
  const lines = listLines(snap, rows, ui, { width: 160, height: 20, now: NOW }, plain, hits);
  assert.deepEqual(clickAt(hits, 10, 3), { select: rows[1].agent.key });
  assert.deepEqual(clickAt(hits, 150, 2 + rows.length - 1), { select: rows[rows.length - 1].agent.key });
  assert.equal(clickAt(hits, 10, 2 + rows.length), undefined, 'nothing below the last row');
  for (const [title, sort] of [['NAME', 'name'], ['PROJECT', 'project'], ['ACTIVITY', 'status'], ['LAST', 'recent']]) {
    assert.deepEqual(clickAt(hits, lines[1].indexOf(title) + 1, 1), { sort }, title);
  }
  assert.equal(clickAt(hits, lines[1].indexOf('MODEL') + 1, 1), undefined);
  for (const [label, key] of [['⏎ details', 'enter'], ['/ filter', '/'], ['s sort', 's'], ['a agents', 'a'], ['b bell', 'b'], ['? help', '?'], ['q quit', 'q']]) {
    assert.deepEqual(clickAt(hits, lines[19].indexOf(label) + 1, 19), { key }, label);
  }
  assert.equal(clickAt(hits, lines[19].indexOf('move'), 19), undefined);

  // The filter in use clears; while it is typed, the keys keep or clear it.
  const filtered = /** @type {import('../src/view.js').Hit[]} */ ([]);
  const footer = listLines(snap, rows, { ...ui, filter: 'Idle' }, { width: 160, height: 20, now: NOW }, plain, filtered)[19];
  assert.deepEqual(clickAt(filtered, footer.indexOf('filter "Idle"') + 2, 19), { key: 'escape' });
  assert.deepEqual(clickAt(filtered, footer.indexOf('? help') + 1, 19), { key: '?' });
  const typing = /** @type {import('../src/view.js').Hit[]} */ ([]);
  const typed = listLines(snap, rows, { ...ui, filter: '日本', editingFilter: true }, { width: 160, height: 20, now: NOW }, plain, typing)[19];
  // The two wide characters take two columns each: their string index is a column less each.
  assert.deepEqual(clickAt(typing, typed.indexOf('keep') + 2, 19), { key: 'enter' });
  assert.deepEqual(clickAt(typing, typed.indexOf('esc clear') + 2, 19), { key: 'escape' });
});

test('where a click goes in the details: an agent opens its own, a key below is pressed', () => {
  const s = busySession();
  /** @type {import('../src/view.js').Hit[]} */
  const hits = [];
  const lines = detailLines(s, snapshot([s]), initialUi(), { width: 100, height: 30, now: NOW }, plain, hits);
  assert.deepEqual(clickAt(hits, 5, lines.findIndex((l) => l.includes('find the parser'))), { open: 'a:1' });
  assert.deepEqual(clickAt(hits, 5, lines.findIndex((l) => l.includes('review-changes'))), { open: 'w:1' });
  assert.deepEqual(clickAt(hits, 2, 29), { key: 'escape' });
  assert.deepEqual(clickAt(hits, lines[29].indexOf('tab next') + 1, 29), { key: 'tab' });
  assert.equal(clickAt(hits, lines[29].indexOf('scroll'), 29), undefined);
});

test('an empty list says why', () => {
  const say = (/** @type {import('../src/monitor.js').Snapshot} */ snap, filter = '') =>
    listLines(snap, [], { ...initialUi(), filter }, { width: 100, height: 10, now: NOW }, plain).join('\n');
  assert.match(say(snapshot([])), /No Claude agents running or active in the last 24h\./);
  assert.match(say(snapshot([], { found: false })), /No Claude Code sessions found in \/home\/me\/\.claude\./);
  assert.match(say(snapshot([]), 'xyz'), /Nothing matches "xyz"\./);
});

test('the activity says how long the current step has taken; an agent that ended says so', () => {
  const s = agent({
    key: 's:x', title: 'Tests', state: 'working', activity: 'Bash: npm test', activityKind: 'tool', activityAt: NOW - 185_000,
    children: [agent({ key: 'a:x', type: 'subagent', title: 'helper', state: 'done', live: false })],
  });
  const snap = snapshot([s]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('all') };
  const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 100, height: 8, now: NOW }, plain);
  assert.match(lines.find((l) => l.includes('Tests')) ?? '', /Bash: npm test +3m05s +1m$/);
  assert.match(lines.find((l) => l.includes('helper')) ?? '', /└─ helper +done +1m$/);
});

/**
 * A task list made in the turn at work, of `n` steps: `done` of them done, the next in progress.
 * @param {number} n @param {number} done
 * @returns {import('../src/monitor.js').Plan}
 */
const planOf = (n, done) => ({
  steps: Array.from({ length: n }, (_, k) => ({ text: `step ${k + 1}`, status: k < done ? 'completed' : k === done ? 'in_progress' : 'pending' })),
  at: NOW - 10 * MINUTE,
  current: true,
});

test('in a tool: its own mark, counted apart; a task list at work says how far it has come', () => {
  const tool = agent({
    key: 's:t', title: 'Tool session', state: 'working', inTool: true, project: 'demo',
    activity: 'Bash: Build', activityKind: 'tool', activityAt: NOW - 65_000, plan: planOf(8, 4),
  });
  const earlier = agent({
    key: 's:k', title: 'Thinking session', state: 'working', project: 'demo',
    activity: 'thinking', activityKind: 'thinking', activityAt: NOW - 5000, plan: { ...planOf(8, 4), current: false },
  });
  const idle = agent({ key: 's:i', title: 'Idle session', state: 'idle', project: 'demo', activity: 'Done.', activityKind: 'reply', plan: planOf(8, 8) });
  const snap = snapshot([tool, earlier, idle]);
  const ui = initialUi();
  const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 120, height: 8, now: NOW }, plain);
  const line = (/** @type {string} */ title) => lines.find((l) => l.includes(title)) ?? '';
  assert.match(lines[0], / Claude agents {2}● 1 working {2}◐ 1 in a tool {2}○ 1 idle /);
  assert.match(line('Tool session'), /^[ >]◐ demo +Tool session +4\/8 Bash: Build +1m05s +1m/);
  assert.match(line('Thinking session'), /Thinking session +thinking +5s +1m/, 'a task list of an earlier turn: no count');
  assert.match(line('Idle session'), /Idle session +Done\. +1m/, 'nor that of a session not at work');
  const color = makeTheme({ color: true, ascii: false, animate: true });
  const out = table(snap, { width: 120, now: NOW, agents: 'running', showEnded: true }, color);
  assert.match(out, /\x1b\[32m[◐◓◑◒]\x1b\[0m/, 'its mark turns, slower than one at work');
  assert.match(out, /\x1b\[32m4\/8 \x1b\[0m\x1b\[36mBash: Build/);
});

test('the detail view of a session in a tool: its task list, and the commands it runs in the background', () => {
  const s = agent({
    key: 's:t', title: 'Tool session', state: 'working', inTool: true, sessionId: 't1',
    activity: 'Bash: Build', activityKind: 'tool', activityAt: NOW - 65_000, plan: planOf(12, 5),
    commands: [{ summary: 'Bash: Serve the site', ts: NOW - 10 * MINUTE }, { summary: 'PowerShell: Watch', ts: NOW - 2 * MINUTE }],
  });
  const lines = detailLines(s, snapshot([s]), initialUi(), { width: 100, height: 30, now: NOW }, plain);
  assert.match(lines[0], /^ ◐ Tool session +in a tool · 1m05s $/);
  const text = lines.join('\n');
  assert.match(text, /Doing {6}Bash: Build {2}\(1m05s\)/);
  assert.match(text, /Background Bash: Serve the site {2}\(10m00s\) *\n {12}PowerShell: Watch {2}\(2m00s\) *\n/);
  // 8 lines for its steps: from the last one done, the 4 done above it in one line.
  assert.match(text, / Tasks {2}5\/12 done *\n {3}✓ 4 more done *\n {3}✓ step 5 *\n {3}▸ step 6 *\n {3}○ step 7 *\n {3}○ step 8 *\n {3}○ step 9 *\n {3}○ step 10 *\n {3}and 2 more *\n/);

  const over = agent({ key: 's:o', title: 'Idle session', state: 'idle', activity: 'Done.', activityKind: 'reply', plan: { ...planOf(12, 12), current: false } });
  const o = detailLines(over, snapshot([over]), initialUi(), { width: 100, height: 30, now: NOW }, plain).join('\n');
  assert.match(o, / Tasks {2}12\/12 done · in an earlier turn *\n {3}✓ 5 more done *\n {3}✓ step 6 *\n[\s\S]* {3}✓ step 12 *\n *\n/, 'all done: the last ones');
  assert.doesNotMatch(o, /Background|and \d+ more/);
  const short = agent({ key: 's:s', title: 'Short list', state: 'working', activity: 'thinking', activityKind: 'thinking', activityAt: NOW - 1000, plan: planOf(3, 1) });
  assert.match(detailLines(short, snapshot([short]), initialUi(), { width: 100, height: 30, now: NOW }, plain).join('\n'), / Tasks {2}1\/3 done *\n {3}✓ step 1 *\n {3}▸ step 2 *\n {3}○ step 3 *\n *\n/);
});

test('wide characters and emoji take their two columns', () => {
  const s = agent({
    key: 's:w', title: '日本語のセッション名がとても長い場合のテスト😀', project: 'プロジェクト',
    activity: '返信のテキスト🎉が長く続く場合でも列に収まる',
  });
  const snap = snapshot([s]);
  for (const cols of [40, 80, 120]) {
    const ui = initialUi();
    const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: cols, height: 6, now: NOW }, plain);
    lines.slice(0, -1).forEach((l) => assert.equal(visible(l), cols, l));
  }
});

test('the detail view: the fields of a session, its agents and its activity', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const s = agent({
    key: 's:d', title: 'Detail session', state: 'ended', live: false, sessionId: id, kind: 'cli', version: '2.1.309',
    cwd: 'C:\\work\\demo', branch: 'main', project: 'demo', model: 'claude-opus-5-5', effort: 'high', ctx: 112_400, outTokens: 5300,
    cost: { usd: 1.5, input: 100, output: 2000, cacheRead: 30_000, cacheWrite: 4000, linesAdded: 10, linesRemoved: 2, apiMs: 1000, durationMs: 5000 },
    startedAt: NOW - HOUR, lastActive: NOW - 5 * MINUTE, activity: 'All done.', activityKind: 'reply', activityAt: NOW - 5 * MINUTE,
    transcript: 'C:\\Users\\me\\.claude\\projects\\C--work-demo\\x.jsonl', transcriptSize: 822_041,
    events: [
      { ts: NOW - HOUR, kind: 'prompt', text: 'Fix the parser' },
      { ts: NOW - 50 * MINUTE, kind: 'tool', text: 'Bash: npm test' },
      { ts: NOW - 40 * MINUTE, kind: 'error', text: 'Bash: npm test failed: Exit code 1' },
      { ts: NOW - 5 * MINUTE, kind: 'reply', text: 'All done.' },
    ],
    children: [agent({ key: 'a:d', type: 'subagent', title: 'helper', state: 'done', live: false, agentType: 'Explore' })],
  });
  const lines = detailLines(s, snapshot([s]), initialUi(), { width: 100, height: 30, now: NOW }, plain);
  assert.equal(lines.length, 30);
  assert.match(lines[0], /^ · Detail session +ended $/);
  const text = lines.join('\n');
  for (const re of [
    /Last {7}All done\./,
    new RegExp(`Session {4}${id} · cli · Claude Code 2\\.1\\.309`),
    new RegExp(`Resume {5}claude --resume ${id}`),
    /Folder {5}C:\\work\\demo · branch main/,
    /Model {6}claude-opus-5-5 · effort high/,
    /Context {4}112k tokens · 5\.3k output tokens in the part read/,
    /Totals {5}\$1\.50 · 2k out · 34k in · \+10 -2 lines · as Claude Code last saved them/,
    /Transcript C:\\Users\\me\\\.claude\\projects\\C--work-demo\\x\.jsonl · 803 KB/,
    /Agents {2}1 agent *\n/,
    /Explore +helper/,
    /Activity/,
    /you {4}Fix the parser/,
    /error {2}Bash: npm test failed: Exit code 1/,
    /claude All done\./,
  ]) assert.match(text, re);
  lines.forEach((l, i) => assert.equal(visible(l), i === lines.length - 1 ? 99 : 100, `line ${i}: ${l}`));
});

test('the detail view of an unread session: the reply not read yet, and when it was last opened', () => {
  const s = agent({
    key: 's:u', title: 'Unread session', state: 'idle', kind: 'desktop', sessionId: 'u1', unread: true,
    activity: 'All done: the tests pass.', activityKind: 'reply', activityAt: NOW - 3 * MINUTE,
    hostSessionId: 'local_u', openedAt: NOW - 10 * MINUTE,
  });
  const lines = detailLines(s, snapshot([s]), initialUi(), { width: 100, height: 20, now: NOW }, plain);
  assert.match(lines[0], /^ • Unread session +idle · unread $/);
  const text = lines.join('\n');
  assert.match(text, /Unread {5}All done: the tests pass\./);
  assert.match(text, /Desktop {4}local_u · last opened .+ \(10m ago\)/);
});

test("the detail view of a blocked session: what you are to do, the app's summary, its category", () => {
  const s = blockedSession({ key: 's:b', title: 'Blocked session', kind: 'desktop', sessionId: 'b1', unread: true });
  const lines = detailLines(s, snapshot([s]), initialUi(), { width: 100, height: 20, now: NOW }, plain);
  assert.match(lines[0], /^ ◇ Blocked session +idle · blocked · unread $/);
  const text = lines.join('\n');
  assert.match(text, /Blocked {4}say whether the stutter was picture or sound *\n/);
  assert.match(text, /Summary {4}Stutter: picture or sound\?/);
  const review = agent({
    key: 's:r', title: 'Ready for review', state: 'ended', live: false, blocked: false,
    turn: { category: 'review_ready', detail: 'Web build checked' }, activity: 'Web build checked', activityKind: 'summary',
  });
  const r = detailLines(review, snapshot([review]), initialUi(), { width: 100, height: 20, now: NOW }, plain);
  assert.match(r[0], /^ · Ready for review +ended · review ready $/);
  assert.match(r.join('\n'), /Last {7}Web build checked/);
  assert.doesNotMatch(r.join('\n'), /Summary/);
});

test('the detail view of an agent at work: how long it has been at it', () => {
  const a = agent({
    key: 'a:w', type: 'subagent', title: 'find the parser', state: 'running', agentId: 'a1', agentType: 'Explore',
    activity: 'Grep: parse', activityKind: 'tool', activityAt: NOW - 65_000,
  });
  const lines = detailLines(a, snapshot([]), initialUi(), { width: 80, height: 12, now: NOW }, plain);
  assert.match(lines[0], /find the parser +running · 1m05s $/);
  assert.match(lines.join('\n'), /Doing {6}Grep: parse {2}\(1m05s\)/);
  assert.match(lines.join('\n'), /Agent {6}a1 · Explore/);
});

test('the detail view of a workflow: its agents take the room of an activity log', () => {
  const kids = Array.from({ length: 30 }, (_, k) =>
    agent({ key: `a:${k}`, type: 'agent', title: `agent ${k}`, state: k < 2 ? 'running' : 'done', phase: 'Review' }));
  const w = agent({
    key: 'w:x', type: 'workflow', title: 'review-changes', state: 'running', runId: 'wf_1', phase: 'Review',
    counts: { running: 2, done: 28, failed: 0, total: 30 }, children: kids,
  });
  const lines = detailLines(w, snapshot([]), initialUi(), { width: 100, height: 24, now: NOW }, plain);
  const text = lines.join('\n');
  assert.equal(lines.length, 24);
  assert.doesNotMatch(text, /Activity/);
  assert.match(text, /Agent {6}wf_1 · workflow · phase Review/);
  assert.match(text, /Agents {5}30 in all · 2 running · 28 done/);
  assert.match(text, /Agents {2}30 agents · 2 running/);
  assert.match(text, /and 16 more/);
  assert.equal(lines.filter((l) => /agent \d+/.test(l)).length, 14);
});

test('the activity log shows the newest events, and scrolls back', () => {
  const events = Array.from({ length: 50 }, (_, k) => ({ ts: NOW - (50 - k) * 1000, kind: /** @type {const} */ ('reply'), text: `event ${k}` }));
  const a = agent({ key: 'a:log', type: 'subagent', title: 'Chatty agent', state: 'running', agentId: 'a1', agentType: 'Explore', events });
  const ui = initialUi();
  const draw = () => detailLines(a, snapshot([]), ui, { width: 80, height: 20, now: NOW }, plain);
  assert.match(draw()[18], /event 49 *$/);
  ui.logScroll = 5;
  const back = draw();
  assert.match(back[18], /event 44 *$/);
  assert.match(back.join('\n'), /Activity \(5 newer below\)/);
  ui.logScroll = 1000;
  const oldest = draw();
  assert.equal(ui.logScroll, 37, 'no further back than the oldest');
  assert.match(oldest[6], /event 0 *$/);
});

test('the help fills the screen, the keys that scroll it on its last line, one column short', () => {
  const lines = helpLines(initialUi(), { width: 90, height: 45, now: NOW }, plain, '/home/me/.claude');
  assert.equal(lines.length, 45);
  assert.match(lines.join('\n'), /Keys[\s\S]*States[\s\S]*Columns[\s\S]*Reading \/home\/me\/\.claude/);
  assert.match(lines.join('\n'), /◇ blocked {3}its turn ended on something only you can do/);
  assert.match(lines.join('\n'), /◐ tool {6}it waits on a tool call it made/);
  assert.match(lines.join('\n'), /• unread {4}the desktop app's blue dot/);
  assert.match(lines.join('\n'), /EFFORT {8}the effort it works at, and a \+ when ultracode is on/);
  assert.match(lines.join('\n'), /ACTIVITY {6}what it is doing, with how many of its tasks are done \(4\/8\) and how *\n {17}long the current step has taken/);
  assert.match(lines.join('\n'), /click {9}select a row +double-click +its details/);
  assert.match(lines.join('\n'), /~34% {10}that sample carried on to now with what this computer's sessions used *\n {17}since: an estimate, blind to use elsewhere/);
  assert.match(lines.join('\n'), /resets {8}about when that limit resets: the week's at the same time each week, *\n {17}the session's five hours after its first use/);
  assert.match(lines.join('\n'), /↑↓ pgup pgdn home end and the wheel scroll; any other key or a click goes back\./);
  const off = helpLines(initialUi(), { width: 90, height: 45, now: NOW }, plain, '/x', false).join('\n');
  assert.doesNotMatch(off, /click|wheel/, 'not with the mouse off');
  assert.match(off, /↑↓ pgup pgdn home end scroll; any other key goes back\./);
  lines.slice(0, -1).forEach((l) => assert.equal(visible(l), 90, l));
  // All of it fits: no telling how far down it is.
  assert.equal(lines[44], ` esc back  ↑↓ scroll  home/end${' '.repeat(59)}`);
  assert.equal(helpLines(initialUi(), { width: 90, height: 10, now: NOW }, plain, '/x').length, 10);
});

test('on a screen too short for it the help scrolls, and says how far down it is', () => {
  const full = helpLines(initialUi(), { width: 90, height: 100, now: NOW }, plain, '/x');
  const ui = initialUi();
  const draw = () => helpLines(ui, { width: 90, height: 12, now: NOW }, plain, '/x');
  let lines = draw();
  const total = Number(/\/(\d+) $/.exec(lines[11])?.[1]);
  assert.ok(total > 11, lines[11]);
  assert.deepEqual(lines.slice(0, 11), full.slice(0, 11));
  assert.match(lines[11], new RegExp(`^ esc back {2}↑↓ scroll {2}home/end +1-11/${total} $`));
  assert.equal(visible(lines[11]), 89);
  ui.helpTop = 5;
  lines = draw();
  assert.deepEqual(lines.slice(0, 11), full.slice(5, 16));
  assert.match(lines[11], new RegExp(` 6-16/${total} $`));
  ui.helpTop = 1000;
  lines = draw();
  assert.equal(ui.helpTop, total - 11, 'no further down than its end');
  assert.match(lines[10], /any other key or a click goes back/);
  assert.match(lines[11], new RegExp(` ${total - 10}-${total}/${total} $`));
  // Taller again, it shows from the top what it can.
  helpLines(ui, { width: 90, height: 100, now: NOW }, plain, '/x');
  assert.equal(ui.helpTop, 0);
});

test('on a screen as narrow as a phone\'s the help wraps, each line under the start of what it says', () => {
  const web = makeTheme({ color: false, ascii: false, animate: false, web: true });
  const narrow = helpLines(initialUi(), { width: 43, height: 200, now: NOW }, web, '/x');
  const wide = helpLines(initialUi(), { width: 120, height: 200, now: NOW }, web, '/x');
  const words = (/** @type {string[]} */ lines) => lines.slice(0, -1).join(' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(words(narrow), words(wide), 'nothing cut, nothing moved');
  narrow.forEach((l, i) => assert.equal(visible(l), i === narrow.length - 1 ? 42 : 43, l));
  const text = narrow.map((l) => l.trimEnd());
  /** The lines from the one that starts with `start`. @param {string} start @param {number} n */
  const from = (start, n) => text.slice(text.findIndex((l) => l.startsWith(start))).slice(0, n);
  /** `a`, and `b` from column `n`. @param {string} a @param {number} n @param {string} b */
  const col = (a, n, b) => a.padEnd(n) + b;
  assert.deepEqual(from(' agentmonitor', 2), [' agentmonitor  the Claude agents on this', col('', 15, 'computer')]);
  // A key wider than its column has a line of its own, and what it does goes under it.
  assert.deepEqual(from('   ↑↓ j k', 3), [col('   ↑↓ j k', 17, 'move'), '   pgup pgdn home end', col('', 17, 'move by pages')]);
  assert.deepEqual(from('   b ', 3), [col('   b', 17, 'bell on or off: it rings'), col('', 17, 'when a session needs you'), col('', 17, 'or ends its turn')]);
  assert.deepEqual(from('   touch', 2), [col('   touch', 17, 'a tap is a click; a drag'), col('', 17, 'moves or scrolls')]);
  // A glyph stays with its word.
  assert.deepEqual(from('   ● working', 2), [col('   ● working', 15, 'the session is at work, or'), col('', 15, '● an agent runs')]);
  assert.deepEqual(from('   · ended', 2), [col('   · ended', 15, '✓ done   ✗ failed'), col('', 15, '■ stopped')]);
  assert.deepEqual(from('   EFFORT', 3), [col('   EFFORT', 17, 'the effort it works at,'), col('', 17, 'and a + when ultracode is'), col('', 17, 'on')]);
});

test('a styled line wrapped: at its spaces, under an indent, its styles closed at a break and opened again', () => {
  assert.deepEqual(wrapStyled('one two three', 9), ['one two', 'three']);
  assert.deepEqual(wrapStyled('a: one two three', 10, 3), ['a: one two', '   three']);
  assert.deepEqual(wrapStyled('   one   two', 20), ['   one   two'], 'spaces kept within a line');
  assert.deepEqual(wrapStyled('one   two  ', 4), ['one', 'two'], 'and left out at a break and the end');
  const styled = ' \x1b[1mKeys\x1b[0m and \x1b[32m●\x1b[0m \x1b[1;33m◆\x1b[0m more';
  assert.deepEqual(wrapStyled(styled, 80), [styled], 'as it was, when it fits');
  assert.deepEqual(wrapStyled('\x1b[2mone two three\x1b[0m', 9), ['\x1b[2mone two\x1b[0m', '\x1b[2mthree\x1b[0m']);
  assert.deepEqual(wrapStyled('x \x1b[32m●\x1b[0m on', 4), ['x', '\x1b[32m●\x1b[0m on'], 'a no-break space binds, drawn as a space');
  assert.deepEqual(wrapStyled('go abcdefghij', 6, 2), ['go', '  abcd', '  efgh', '  ij'], 'a word wider than a line, cut');
  assert.deepEqual(wrapStyled('漢字 漢字', 5), ['漢字', '漢字']);
  assert.deepEqual(wrapStyled('one two', 8, 30), ['one two']);
  assert.deepEqual(wrapStyled('one two three', 10, 30), ['one two', '     three'], 'indented half the width at most');
  assert.deepEqual(wrapStyled('', 10), ['']);
});

test('with --ascii, nothing but ASCII is drawn', () => {
  const ascii = makeTheme({ color: false, ascii: true, animate: true });
  const busy = busySession();
  // A workflow that is not the last agent: a line runs down past its agents to the next.
  busy.children.reverse();
  const unread = agent({ key: 's:u', title: 'Unread session', state: 'idle', unread: true, hostSessionId: 'local_u', openedAt: NOW - HOUR });
  const blocked = blockedSession({ key: 's:b', title: 'Blocked session' });
  const tool = agent({
    key: 's:t', title: 'Tool session', state: 'working', inTool: true, activity: 'Bash: Build', activityKind: 'tool', activityAt: NOW - 65_000,
    plan: planOf(12, 5), commands: [{ summary: 'Bash: Serve the site', ts: NOW - 10 * MINUTE }],
  });
  const snap = snapshot([busy, unread, blocked, tool, ...sessions().filter((a) => a.key !== 's:busy')]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('all') };
  const rows = visibleRows(snap, ui, ascii);
  settleSelection(ui, rows, 17);
  assert.ok(rows.some((r) => r.prefix === '|  |- '), rows.map((r) => r.prefix).join(','));
  const list = listLines(snap, rows, ui, { width: 120, height: 20, now: NOW }, ascii);
  assert.match(list.find((l) => l.includes('Tool session')) ?? '', /^ % +Tool session .* 5\/12 Bash: Build +1m05s/);
  const details = detailLines(tool, snap, ui, { width: 120, height: 30, now: NOW }, ascii);
  assert.match(details.join('\n'), / Tasks {2}5\/12 done *\n {3}\+ 4 more done *\n {3}\+ step 5 *\n {3}> step 6 *\n {3}- step 7 *\n/);
  const screens = [
    list,
    details,
    detailLines(busy, snap, ui, { width: 120, height: 20, now: NOW }, ascii),
    detailLines(unread, snap, ui, { width: 120, height: 20, now: NOW }, ascii),
    detailLines(blocked, snap, ui, { width: 120, height: 20, now: NOW }, ascii),
    helpLines(initialUi(), { width: 120, height: 30, now: NOW }, ascii, '/home/me/.claude'),
    helpLines(initialUi(), { width: 43, height: 80, now: NOW }, ascii, '/home/me/.claude'),
    table(snap, { width: 120, now: NOW, agents: 'all', showEnded: true }, ascii).split('\n'),
  ];
  for (const line of screens.flat()) assert.match(line, /^[\x20-\x7e]*$/, line);
});

test('the table printed once: no selection, no trailing spaces', () => {
  const out = table(snapshot(sessions()), { width: 100, now: NOW, agents: 'running', showEnded: false }, plain);
  assert.ok(out.endsWith('\n'));
  const lines = out.trimEnd().split('\n');
  assert.match(lines[0], /^ Claude agents {2}● 1 working/);
  assert.match(lines[1], /^ {3}PROJECT +NAME +CTX +ACTIVITY +LAST$/);
  assert.equal(lines.length, 2 + 7);
  assert.ok(!out.includes('Ended session'));
  for (const l of lines) {
    assert.equal(l, l.trimEnd());
    assert.ok(visible(l) <= 100, l);
  }
  assert.match(table(snapshot([]), { width: 100, now: NOW, agents: 'running', showEnded: true }, plain), /No Claude agents running or active in the last 24h\./);
  assert.match(table(snapshot([], { found: false }), { width: 100, now: NOW, agents: 'running', showEnded: true }, plain), /No Claude Code sessions found in \/home\/me\/\.claude\./);
});
