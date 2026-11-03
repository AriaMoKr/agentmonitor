import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, fit, monthDay, timeOfDay, weekday, width } from '../src/format.js';
import { columns, detailLines, helpLines, initialUi, listLines, makeTheme, putAway, rate, settleSelection, table, visibleRows, wrapStyled } from '../src/view.js';
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
  const lines = listLines(snap, rows, ui, { width: 170, height: 12, now: NOW }, plain);
  assert.match(lines[0], /◆ 1 waiting {2}◇ 2 blocked {2}○ 1 idle/);
  assert.doesNotMatch(lines[0], /unread/, 'blocked shows before unread');
  assert.match(lines[3], /^ ◇ theta +Blocked session +blocked: say whether the stutter was picture or sound +30m/);
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const ended = listLines(snap, visibleRows(snap, ui, color), ui, { width: 170, height: 12, now: NOW }, color)[4];
  assert.ok(ended.includes('\x1b[1;33mblocked: say whether'), `a session that ended, blocked, still waits on you: ${JSON.stringify(ended)}`);
});

test('a session archived in the desktop app is put away once it ended, blocked or not: listed only with all that ended, counted nowhere', () => {
  const snap = snapshot([
    ...sessions(),
    agent({ key: 's:old', title: 'Old release', state: 'ended', live: false, archived: true, project: 'kappa', lastActive: NOW - 2 * HOUR }),
    blockedSession({ key: 's:pick', title: 'Pick a provider', state: 'ended', live: false, archived: true, project: 'lambda', lastActive: NOW - 3 * HOUR }),
    agent({ key: 's:back', title: 'Back at work', state: 'working', archived: true, project: 'mu', lastActive: NOW - 2 * MINUTE }),
  ]);
  assert.deepEqual(snap.rows.map(putAway), [false, false, false, false, false, true, true, false]);
  assert.equal(putAway(agent({ title: 'Idle, archived', archived: true })), false, 'a process still runs it');
  const at = (/** @type {Partial<import('../src/view.js').Ui>} */ o) => ({ ...initialUi(), agents: /** @type {const} */ ('none'), ...o });
  const titles = (/** @type {Partial<import('../src/view.js').Ui>} */ o) => visibleRows(snap, at(o), plain).map((r) => r.agent.title);
  assert.deepEqual(titles({}), ['Waiting session', 'Back at work', 'Busy session', 'Active session', 'Idle session', 'Ended session']);
  assert.deepEqual(titles({ showEnded: false }), ['Waiting session', 'Back at work', 'Busy session', 'Active session', 'Idle session']);
  assert.deepEqual(titles({ showArchived: true }), [
    'Waiting session', 'Pick a provider', 'Back at work', 'Busy session', 'Active session', 'Idle session', 'Ended session', 'Old release',
  ]);
  assert.deepEqual(titles({ showArchived: true, filter: 'ARCHIVED' }), ['Pick a provider', 'Back at work', 'Old release'], 'the filter knows them');
  assert.deepEqual(titles({ filter: 'archived' }), ['Back at work']);
  /** The header and the footer, as e is on, off or all. @param {Partial<import('../src/view.js').Ui>} o */
  const ends = (o) => {
    const ui = at(o);
    const lines = listLines(snap, visibleRows(snap, ui, plain), ui, { width: 160, height: 12, now: NOW }, plain);
    return [lines[0], /e ended:\w+/.exec(lines[11])?.[0]];
  };
  const [head, key] = ends({});
  assert.match(head, /^ Claude agents {2}● 2 working {2}◆ 1 waiting {2}○ 1 idle {2}◌ 1 active {2}\S 1 ended {2}2 agents at work /);
  assert.equal(key, 'e ended:on');
  assert.deepEqual(ends({ showEnded: false }), [head, 'e ended:off']);
  assert.deepEqual(ends({ showArchived: true }), [head, 'e ended:all'], 'listed, still not counted');
  const once = (/** @type {boolean} */ showArchived) => table(snap, { width: 120, now: NOW, agents: 'none', showEnded: true, showArchived }, plain);
  assert.ok(!once(false).includes('Old release'));
  assert.ok(once(true).includes('Old release'));
});

/**
 * A session whose turn is over, with a command it started going on in the background.
 * @param {Partial<import('../src/monitor.js').Agent>} o
 */
const serving = (o) => agent({
  state: 'idle', activity: 'background: Bash: Serve the site', activityKind: 'background', activityAt: NOW - 8 * MINUTE,
  commands: [{ summary: 'Bash: Serve the site', ts: NOW - 8 * MINUTE }], ...o,
});

test('a session whose turn is over that waits on what it left running: its mark, counted, listed before those idle', () => {
  const watch = agent({ key: 'a:ci', type: 'subagent', title: 'watch CI', state: 'running', background: true, startedAt: NOW - 3 * MINUTE });
  const snap = snapshot([
    ...sessions(),
    serving({ key: 's:srv', title: 'Serving session', project: 'kappa', lastActive: NOW - 8 * MINUTE }),
    // An agent it started at work, not a command.
    agent({
      key: 's:ci', title: 'Waiting on CI', state: 'idle', project: 'lambda', lastActive: NOW - 3 * MINUTE,
      activity: 'background: 1 agent running', activityKind: 'background', activityAt: NOW - 3 * MINUTE, children: [watch],
    }),
    // What needs you or is unread shows as that; at work, as at work.
    serving({ key: 's:blk', title: 'Blocked, serving', project: 'mu', blocked: true, lastActive: NOW - 9 * MINUTE }),
    serving({ key: 's:new', title: 'Unread, serving', project: 'nu', unread: true, lastActive: NOW - 9 * MINUTE }),
    serving({ key: 's:wrk', title: 'Working, serving', project: 'xi', state: 'working', activity: 'thinking', activityKind: 'thinking', lastActive: NOW - 2 * MINUTE }),
  ]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('none') };
  const rows = visibleRows(snap, ui, plain);
  assert.deepEqual(rows.map((r) => r.agent.title), [
    'Blocked, serving', 'Waiting session', 'Unread, serving', 'Working, serving', 'Busy session', 'Active session',
    'Waiting on CI', 'Serving session', 'Idle session', 'Ended session',
  ]);
  const lines = listLines(snap, rows, ui, { width: 160, height: 14, now: NOW }, plain);
  assert.match(lines[0], /◇ 1 blocked {2}• 1 unread {2}◎ 2 background {2}○ 1 idle {2}◌ 1 active/);
  const line = (/** @type {string[]} */ l, /** @type {string} */ title) => l.find((s) => s.includes(title)) ?? '';
  assert.match(line(lines, 'Serving session'), /^ ◎ kappa +Serving session +background: Bash: Serve the site +8m00s +8m /);
  assert.match(line(lines, 'Waiting on CI'), /^ ◎ lambda +Waiting on CI +background: 1 agent running +3m00s +3m /);
  assert.match(line(lines, 'Blocked, serving'), /^.◇ mu /, 'the first row, selected');
  assert.match(line(lines, 'Unread, serving'), /^ • nu /);
  assert.match(line(lines, 'Working, serving'), /^ ● xi /);
  assert.match(line(lines, 'Idle session'), /^ ○ zeta /);
  const ascii = makeTheme({ color: false, ascii: true, animate: false });
  assert.match(line(listLines(snap, rows, ui, { width: 160, height: 14, now: NOW }, ascii), 'Serving session'), /^ & kappa /);
  const color = makeTheme({ color: true, ascii: false, animate: false });
  assert.ok(listLines(snap, rows, ui, { width: 160, height: 14, now: NOW }, color)[0].includes('\x1b[36m◎\x1b[0m 2 background'));
  // Its details say so, and list what it waits on.
  const srv = /** @type {import('../src/monitor.js').Agent} */ (snap.rows.find((r) => r.key === 's:srv'));
  const detail = detailLines(srv, snap, initialUi(), { width: 100, height: 20, now: NOW }, plain);
  assert.match(detail[0], /^ ◎ Serving session +background · 8m00s $/);
  assert.match(detail.join('\n'), /Background Bash: Serve the site {2}\(8m00s\)/);
  // An agent it started, once done, leaves it idle.
  const done = { ...snap.rows[6], children: [{ ...watch, state: /** @type {const} */ ('done') }] };
  assert.match(detailLines(done, snap, initialUi(), { width: 100, height: 20, now: NOW }, plain)[0], /^ ○ Waiting on CI +idle/);
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

test('with none selected (a click below the rows) none stays so as rows come and go, and none is marked', () => {
  const rows = (/** @type {string[]} */ keys) => keys.map((key) => ({ agent: agent({ key, title: key }), depth: 0, prefix: '' }));
  const ui = initialUi();
  ui.selected = 'h';
  settleSelection(ui, rows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']), 4);
  Object.assign(ui, { selected: undefined, index: -1 });
  settleSelection(ui, rows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']), 4);
  assert.deepEqual([ui.selected, ui.index, ui.top], [undefined, -1, 4], 'the list where it was');
  for (const keys of [['h'], [], ['a', 'b']]) {
    settleSelection(ui, rows(keys), 4);
    assert.deepEqual([ui.selected, ui.index], [undefined, -1], keys.join());
  }
  // No row marked, and where the selection is, a dash.
  const snap = snapshot(sessions());
  const none = { ...initialUi(), index: -1 };
  const shown = visibleRows(snap, none, plain);
  settleSelection(none, shown, 17);
  const lines = listLines(snap, shown, none, { width: 100, height: 20, now: NOW }, plain);
  assert.deepEqual(lines.filter((l) => l.startsWith('>')), []);
  assert.match(lines[19], / -\/8 $/);
  const color = makeTheme({ color: true, ascii: false, animate: false });
  assert.deepEqual(listLines(snap, shown, none, { width: 100, height: 20, now: NOW }, color).filter((l) => l.startsWith('\x1b[7m')), []);
});

test('the columns fill the width; a narrow screen drops the least needed', () => {
  for (const cols of [20, 40, 72, 80, 100, 120, 160, 200]) {
    assert.equal(columns(cols).reduce((n, c) => n + c.width + 1, 0), cols, `${cols} columns`);
  }
  assert.deepEqual(columns(80).map((c) => c.key), ['state', 'project', 'title', 'activity', 'last']);
  assert.deepEqual(columns(109).map((c) => c.key), ['state', 'project', 'title', 'model', 'ctx', 'activity', 'last']);
  assert.deepEqual(columns(111).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'activity', 'last']);
  assert.deepEqual(columns(112).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last']);
  assert.deepEqual(columns(118).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last', 'kind']);
  assert.deepEqual(columns(160).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last', 'pid', 'kind']);
  // With the plan's price, what the sessions' use came to, before the PID: this week's from 120
  // columns, in all from 128.
  for (const cols of [100, 119, 120, 127, 128, 160]) {
    assert.equal(columns(cols, true).reduce((n, c) => n + c.width + 1, 0), cols, `${cols} columns, priced`);
  }
  assert.deepEqual(columns(119, true), columns(119));
  assert.deepEqual(columns(120, true).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last', 'week', 'kind']);
  assert.deepEqual(columns(128, true).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last', 'week', 'total', 'kind']);
  assert.deepEqual(columns(160, true).map((c) => c.key), ['state', 'project', 'title', 'model', 'effort', 'ctx', 'cache', 'activity', 'last', 'week', 'total', 'pid', 'kind']);
});

test("with the plan's price, what each session's use came to: this week, and in all the replies read", () => {
  const busy = busySession();
  Object.assign(busy, { sessionId: 'p1', pid: 4242 });
  const split = {
    week: { from: NOW - 48 * HOUR, to: NOW, sessions: /** @type {[string, number][]} */ ([['p1', 22], ['p2', 0.01]]), models: [] },
    all: { from: NOW - 30 * 24 * HOUR, to: NOW, sessions: /** @type {[string, number][]} */ ([['p1', 30], ['p2', 3], ['p4', 2.1741], ['p3', 0.04]]), models: [] },
  };
  const rows = [
    busy,
    agent({ key: 's:last', title: 'Last week alone', state: 'idle', sessionId: 'p2' }),
    agent({ key: 's:none', title: 'Next to none', state: 'idle', sessionId: 'p3' }),
    agent({ key: 's:whole', title: 'A whole dollar', state: 'idle', sessionId: 'p4' }),
  ];
  const ui = { ...initialUi(), agents: /** @type {const} */ ('all') };
  /** @param {number} width @param {Partial<import('../src/monitor.js').Snapshot>} o */
  const draw = (width, o) => {
    const snap = snapshot(rows, o);
    return listLines(snap, visibleRows(snap, ui, plain), ui, { width, height: 14, now: NOW }, plain);
  };
  const lines = draw(160, { planPrice: 200, usage: { at: NOW, split } });
  assert.match(lines[1], / LAST +WEEK +TOTAL +PID +KIND +$/);
  const row = (/** @type {string} */ title) => lines.find((l) => l.includes(title)) ?? '';
  // Each 7 columns, to the right: 22 and 30 points at $200 a month; nothing for an agent alone.
  assert.match(row('Busy session'), / 5m  \$10\.12  \$13\.80   4242 /);
  assert.match(row('Last week alone'), / 1m {11}\$1\.38 /, 'next to none this week');
  assert.match(row('A whole dollar'), / 1m {11}\$1\.00 /, 'to the cent, as the others');
  assert.doesNotMatch(row('Next to none'), /\$/);
  assert.doesNotMatch(row('find the parser'), /\$/);
  // The week's alone where there is room for one, none where there is not, nor with no price.
  assert.match(draw(120, { planPrice: 200, usage: { at: NOW, split } })[1], / LAST +WEEK +KIND +$/);
  assert.match(draw(119, { planPrice: 200, usage: { at: NOW, split } })[1], / LAST +KIND +$/);
  assert.match(draw(160, { usage: { at: NOW, split } })[1], / LAST +PID +KIND +$/);
  // Priced with the use not known yet: the columns, empty.
  const unknown = draw(160, { planPrice: 200 });
  assert.match(unknown[1], / LAST +WEEK +TOTAL +PID +KIND +$/);
  assert.doesNotMatch(unknown.join('\n'), /\$/);
  // And in the table --once prints.
  const once = table(snapshot(rows, { planPrice: 100, usage: { at: NOW, split } }), { width: 160, now: NOW, agents: 'none', showEnded: true }, plain).split('\n');
  assert.match(once[1], / LAST +WEEK +TOTAL +PID +KIND$/);
  assert.match(once.find((l) => l.includes('Busy session')) ?? '', / 5m {3}\$5\.06 {3}\$6\.90 {3}4242$/);
});

test("how long each session's prompt cache keeps its context yet, while it is not at work; and in its details, what a reply comes to once it does not", () => {
  /** @param {number} ago @param {number} [ttl] */
  const cache = (ago, ttl = HOUR) => ({ at: NOW - ago, ttl, rewrite: 80_000 });
  const busy = busySession();
  busy.cache = cache(5000);
  const rows = [
    busy,
    agent({ key: 's:warm', title: 'Warm session', state: 'idle', ctx: 281_000, cache: cache(12 * MINUTE) }),
    agent({ key: 's:soon', title: 'Soon cold', state: 'waiting', cache: cache(55 * MINUTE) }),
    agent({ key: 's:cold', title: 'Cold session', state: 'idle', cache: cache(2 * HOUR) }),
    agent({ key: 's:five', title: 'Five minutes', state: 'ended', live: false, cache: cache(2 * MINUTE, 5 * MINUTE) }),
  ];
  const [, warm, soon, cold, five] = rows;
  const ui = { ...initialUi(), agents: /** @type {const} */ ('none'), index: -1 };
  /** @param {import('../src/view.js').Theme} t */
  const draw = (t) => listLines(snapshot(rows), visibleRows(snapshot(rows), ui, t), ui, { width: 120, height: 12, now: NOW }, t);
  const lines = draw(plain);
  const at = lines[1].indexOf(' CACHE ') + 1;
  assert.ok(at > 0, lines[1]);
  const cell = (/** @type {string} */ title) => (lines.find((l) => l.includes(title)) ?? '').slice(at, at + 5).trim();
  // At work, each reply keeps it; once it ran out, nothing.
  assert.deepEqual(['Busy session', 'Warm session', 'Soon cold', 'Cold session', 'Five minutes'].map(cell), ['', '48m', '5m', '', '3m']);
  // In yellow when it is about to run out, but in a session that ended.
  const color = draw(makeTheme({ color: true, ascii: false, animate: false }));
  const colored = (/** @type {string} */ title) => color.find((l) => l.includes(title)) ?? '';
  assert.ok(colored('Soon cold').includes('\x1b[33m   5m\x1b[0m'), colored('Soon cold'));
  assert.ok(!colored('Warm session').includes('\x1b[33m'), colored('Warm session'));
  assert.ok(colored('Five minutes').includes('\x1b[2m   3m\x1b[0m'), colored('Five minutes'));
  // The details: till when, and what a reply after that comes to, writing its context again.
  /** @param {import('../src/monitor.js').Agent} a @param {Partial<import('../src/monitor.js').Snapshot>} [o] */
  const details = (a, o = {}) => detailLines(a, snapshot(rows, o), ui, { width: 100, height: 40, now: NOW }, plain).filter((l) => l.startsWith(' Cache')).map((l) => l.trimEnd());
  const perUse = { session: 8e-6, week: 1e-6 };
  assert.deepEqual(details(warm, { planPrice: 200, usage: { at: NOW, perUse } }), [
    ` Cache      warm till ${clock(NOW + 48 * MINUTE, NOW)} (in 48m), an hour after its last request`,
    ' Cache miss writes its 281k tokens again: 0.64 points of the session, 0.08 of the week, $0.04',
  ]);
  assert.deepEqual(details(warm, { usage: { at: NOW, perUse: { week: perUse.week } } })[1], ' Cache miss writes its 281k tokens again: 0.08 points of the week', 'the week alone, no price');
  assert.deepEqual(details(warm)[1], ' Cache miss writes its 281k tokens again', 'what that comes to not known');
  assert.deepEqual(details(soon), [` Cache      warm till ${clock(NOW + 5 * MINUTE, NOW)} (in 5m), an hour after its last request`]);
  assert.deepEqual(details(cold), [` Cache      ran out at ${clock(NOW - HOUR, NOW)} (1h ago), an hour after its last request`]);
  assert.deepEqual(details(five), [` Cache      warm till ${clock(NOW + 3 * MINUTE, NOW)} (in 3m), 5 minutes after its last request`]);
  assert.deepEqual(details(busy), []);
  // And in the table --once prints.
  const once = table(snapshot(rows), { width: 120, now: NOW, agents: 'none', showEnded: true }, plain).split('\n');
  assert.match(once.find((l) => l.includes('Warm session')) ?? '', / 281k {3}48m /);
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
  assert.match(lines[1], /^ {3}PROJECT +NAME +MODEL +EFFORT +CTX +CACHE +ACTIVITY +LAST +KIND +$/);
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
  assert.match(footer(160), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}v view {2}s sort:status {2}e ended:on {2}a agents:running {2}w window {2}b bell:off {2}\? help {2}q quit +1\/8 $/);
  // The least worth go first, and of the last to go, those that fit come back.
  assert.match(footer(100), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}v view {2}s sort:status {2}e ended:on {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(60), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}v view {2}\? help {2}q quit +1\/8 $/);
  // As wide as a phone: the keys a tap can press.
  assert.match(footer(43), /^ ⏎ details {2}\/ filter {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(100, 'parser'), /^ filter "parser" esc clears {2}↑↓ move {2}⏎ details {2}\/ filter {2}v view {2}e ended:on {2}\? help {2}q quit +1\/4 $/);
});

/**
 * What a click at x, y does, by the hits a view gave.
 * @param {import('../src/view.js').Hit[]} hits
 * @param {number} x
 * @param {number} y
 */
const clickAt = (hits, x, y) => hits.find((h) => h.y === y && x >= h.x0 && x < h.x1)?.action;

test('where a click goes in the list: a row selects it, the space below the rows none, a title sorts by it, a key is pressed', () => {
  const snap = snapshot(sessions());
  const ui = initialUi();
  const rows = visibleRows(snap, ui, plain);
  settleSelection(ui, rows, 17);
  /** @type {import('../src/view.js').Hit[]} */
  const hits = [];
  const lines = listLines(snap, rows, ui, { width: 160, height: 20, now: NOW }, plain, hits);
  assert.deepEqual(clickAt(hits, 10, 3), { select: rows[1].agent.key });
  assert.deepEqual(clickAt(hits, 150, 2 + rows.length - 1), { select: rows[rows.length - 1].agent.key });
  // Below the last row, as wide as the screen and down to the keys: none, but on the selected
  // session shown there, which opens it.
  const below = 2 + rows.length;
  assert.match(lines[below + 1], /^ ─ ◆ alpha · Waiting session ─+ waiting · 10m00s ─ $/);
  assert.match(lines[below + 2], /^ Waiting {4}permission: Bash {2}\(10m00s\) +$/);
  for (let y = below; y < 19; y++) {
    const action = y === below + 1 || y === below + 2 ? { open: 's:wait' } : { unselect: true };
    for (const x of [0, 10, 159]) assert.deepEqual(clickAt(hits, x, y), action, `${x}, ${y}`);
  }
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

test("a session's details with the plan's price: what it used of the week's limit, in dollars, this week and in all the replies read", () => {
  const s = agent({ key: 's:p', title: 'Priced session', state: 'idle', sessionId: 'p1' });
  const from = NOW - 30 * 24 * HOUR;
  /**
   * @param {[string, number][]} sessions this week's
   * @param {number} [planPrice]
   * @param {[string, number][]} [all] in all the replies read, from 30 days back
   */
  const text = (sessions, planPrice, all = sessions, a = s) => {
    const usage = { at: NOW, split: { week: { from: NOW - 48 * HOUR, to: NOW, sessions, models: [] }, all: { from, to: NOW, sessions: all, models: [] } } };
    return detailLines(a, snapshot([a], { usage, planPrice }), initialUi(), { width: 100, height: 20, now: NOW }, plain).join('\n');
  };
  assert.match(text([['other', 30], ['p1', 22]], 200), /Plan {7}\$10\.12 this week: 22 points of its limit, at \$200 a month +\n/);
  assert.match(text([['p1', 8.5]], 100), /Plan {7}\$1\.95 this week: 8\.5 points of its limit, at \$100 a month +\n/);
  assert.doesNotMatch(text([['p1', 22]]), / Plan /, 'no price told');
  assert.doesNotMatch(text([['other', 30], ['p1', 0.01]], 200), / Plan /, 'next to none of the week');
  // More in all: since the first reply read, or in all for a session begun after it; whole at 100 columns.
  assert.match(text([['p1', 22]], 200, [['p1', 30]]), new RegExp(`Plan {7}\\$10\\.12 this week, \\$13\\.80 since ${monthDay(from)}: 22 and 30 points of its limit, at \\$200 a month +\\n`));
  const later = { ...s, startedAt: NOW - 9 * 24 * HOUR };
  assert.match(text([['p1', 22]], 200, [['p1', 30]], later), /Plan {7}\$10\.12 this week, \$13\.80 in all: 22 and 30 points of its limit, at \$200 a month +\n/);
  assert.match(text([['p1', 0.01]], 200, [['p1', 3]], later), /Plan {7}\$1\.38 in all: 3\.0 points of its limit, at \$200 a month +\n/, 'next to none this week');
  assert.match(text([['p1', 22]], 200, [['p1', 22.04]]), /Plan {7}\$10\.12 this week: 22 points of its limit, at \$200 a month +\n/, 'next to none more');
});

test('an earlier run of a desktop app session: its details say so, and the title it had, which the filter knows', () => {
  const run = agent({
    key: 's:e', title: 'reviews (earlier run)', state: 'ended', live: false, kind: 'desktop', sessionId: 'e1', hostSessionId: 'local_r',
    earlier: { of: 'reviews', title: 'Sessions, folders, and repos review', rewoundAt: NOW - 15 * MINUTE },
    cost: { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, linesAdded: 0, linesRemoved: 0, apiMs: 0, durationMs: 0 },
  });
  const details = (/** @type {import('../src/monitor.js').Agent} */ a) => detailLines(a, snapshot([a]), initialUi(), { width: 100, height: 20, now: NOW }, plain).join('\n');
  const text = details(run);
  assert.match(text, /Desktop {4}local_r · an earlier run, rewound .+ \(15m ago\)/);
  assert.match(text, /Was titled Sessions, folders, and repos review/);
  assert.match(text, /Totals {5}\$0\.00 · as Claude Code last saved them/, 'no reply, no tokens to count');
  const restarted = details({ ...run, earlier: { of: 'reviews', title: 'reviews' } });
  assert.match(restarted, /Desktop {4}local_r · an earlier run *$/m);
  assert.doesNotMatch(restarted, /Was titled/, 'the title it had is the one it is named after');
  const titles = (/** @type {string} */ filter) => visibleRows(snapshot([...sessions(), run]), { ...initialUi(), filter }, plain).map((r) => r.agent.title);
  assert.deepEqual(titles('FOLDERS, AND REPOS'), ['reviews (earlier run)']);
  assert.deepEqual(titles('earlier run'), ['reviews (earlier run)']);
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
  const lines = helpLines(initialUi(), { width: 90, height: 67, now: NOW }, plain, '/home/me/.claude');
  assert.equal(lines.length, 67);
  assert.match(lines.join('\n'), /Keys[\s\S]*States[\s\S]*Usage[\s\S]*Columns[\s\S]*Below the list[\s\S]*Reading \/home\/me\/\.claude/);
  // What a state means from the column a key's does.
  assert.match(lines.join('\n'), /◇ blocked {5}its turn ended on something only you can do/);
  assert.match(lines.join('\n'), /◐ tool {8}it waits on a tool call it made/);
  assert.match(lines.join('\n'), /• unread {6}the desktop app's blue dot/);
  assert.match(lines.join('\n'), /◎ background {2}it waits on a command, an agent or a workflow it left running/);
  assert.match(lines.join('\n'), /EFFORT {8}the effort it works at, and a \+ when ultracode is on/);
  assert.match(lines.join('\n'), /CACHE {9}while it is not at work, how long the prompt cache keeps that context *\n {17}yet: an hour after its last request, yellow its last ten minutes; a *\n {17}reply after that writes it all again/);
  assert.match(lines.join('\n'), /ACTIVITY {6}what it is doing, with how many of its tasks are done \(4\/8\) and how *\n {17}long the current step has taken/);
  assert.match(lines.join('\n'), /click {9}select a row, or none below the rows; double-click for its details/);
  assert.match(lines.join('\n'), /~34% {10}that sample carried on to now with what this computer's sessions used *\n {17}since: an estimate, blind to use elsewhere/);
  assert.match(lines.join('\n'), /resets {8}about when that limit resets: the week's at the same time each week, *\n {17}the session's five hours after its window began, on the 10-minute mark *\n {17}at or before its first use/);
  assert.match(lines.join('\n'), /Usage {9}each limit as a bar of what is used, │ where its time has gone to; when *\n/);
  assert.match(lines.join('\n'), /\+12%\/h {8}the session's pace, the last hour's, as this computer's replies tell it/);
  assert.match(lines.join('\n'), /click {9}on a session or an agent there opens its details; anywhere else selects/);
  assert.match(lines.join('\n'), /↑↓ pgup pgdn home end and the wheel scroll; any other key or a click goes back\./);
  const off = helpLines(initialUi(), { width: 90, height: 64, now: NOW }, plain, '/x', false).join('\n');
  assert.doesNotMatch(off, /click|wheel/, 'not with the mouse off');
  assert.match(off, /↑↓ pgup pgdn home end scroll; any other key goes back\./);
  lines.slice(0, -1).forEach((l) => assert.equal(visible(l), 90, l));
  // All of it fits: no telling how far down it is.
  assert.equal(lines[66], ` esc back  ↑↓ scroll  home/end${' '.repeat(59)}`);
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
  assert.deepEqual(from('   ● working', 2), [col('   ● working', 17, 'the session is at work, or'), col('', 17, '● an agent runs')]);
  assert.deepEqual(from('   · ended', 2), [col('   · ended', 17, '✓ done   ✗ failed'), col('', 17, '■ stopped')]);
  assert.deepEqual(from('   ◎ background', 3), [
    col('   ◎ background', 17, 'it waits on a command, an'), col('', 17, 'agent or a workflow it'), col('', 17, 'left running'),
  ]);
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

/** Sessions with something to show below the list: one at work on a task list, one waiting, one unread, one idle. */
function panelSessions() {
  return [
    agent({
      key: 's:busy', title: 'Busy session', state: 'working', project: 'demo', lastActive: NOW - 20_000,
      activity: 'Edit: src/view.js', activityKind: 'tool', activityAt: NOW - 20_000, plan: planOf(7, 3),
      events: [
        { ts: NOW - 30 * MINUTE, kind: 'prompt', text: 'add the panel' },
        { ts: NOW - 29 * MINUTE, kind: 'reply', text: 'I will add all four.' },
        { ts: NOW - 20_000, kind: 'tool', text: 'Edit: src/view.js' },
      ],
    }),
    agent({
      key: 's:wait', title: 'Waiting session', state: 'waiting', project: 'alpha', lastActive: NOW - 10 * MINUTE,
      activity: 'waiting: a question: which database should the login use?', activityKind: 'waiting', activityAt: NOW - 10 * MINUTE,
      events: [{ ts: NOW - 12 * MINUTE, kind: 'prompt', text: 'fix the login' }],
    }),
    agent({
      key: 's:new', title: 'Unread session', state: 'idle', unread: true, project: 'beta', lastActive: NOW - 3 * MINUTE,
      activity: 'The README is done.', activityKind: 'reply', events: [{ ts: NOW - 3 * MINUTE, kind: 'reply', text: 'The README is done.' }],
    }),
    agent({ key: 's:idle', title: 'Idle session', state: 'idle', project: 'zeta', lastActive: NOW - HOUR }),
  ];
}

/** The usage carried on: the session at 50% with an hour left, at 60 points an hour; the week at 41%, five days in. */
const PANEL_USAGE = {
  at: NOW - 10 * MINUTE, session: 30, week: 40,
  tracked: {
    at: NOW, session: 50, sessionReset: { at: NOW + HOUR, from: NOW + HOUR, to: NOW + HOUR }, sessionPace: 60,
    week: 41, weekReset: { at: NOW + 48 * HOUR, from: NOW + 48 * HOUR, to: NOW + 48 * HOUR },
  },
};

/**
 * The list of the panel's sessions, with the hits, at a size.
 * @param {number} cols @param {number} height @param {Partial<import('../src/view.js').Ui>} [o]
 * @param {ReturnType<typeof makeTheme>} [t] @param {import('../src/usage.js').Usage} [usage]
 */
function panelList(cols, height, o = {}, t = plain, usage = PANEL_USAGE) {
  const snap = snapshot(panelSessions(), { usage });
  const ui = { ...initialUi(), ...o };
  const rows = visibleRows(snap, ui, t);
  settleSelection(ui, rows, height - 3);
  /** @type {import('../src/view.js').Hit[]} */
  const hits = [];
  return { rows, hits, lines: listLines(snap, rows, ui, { width: cols, height, now: NOW }, t, hits) };
}

test('below the rows, where there is room: the selected session, the others that need you, what was said, and the usage at the bottom', () => {
  const { rows, hits, lines } = panelList(120, 40);
  assert.deepEqual(rows.map((r) => r.agent.key), ['s:wait', 's:new', 's:busy', 's:idle']);
  const text = lines.map((l) => l.trimEnd());
  /** The time `m` minutes ago, as an event says it, in `w` columns. @param {number} m @param {number} w */
  const at = (m, w) => fit(clock(NOW - m * MINUTE, NOW), w);
  assert.equal(text[6], '', 'a line between');
  assert.match(text[7], /^ ─ ◆ alpha · Waiting session ─+ waiting · 10m00s ─$/);
  assert.match(text[8], /^ Waiting {4}a question: which database should the login use\? {2}\(10m00s\)$/);
  assert.equal(text[9], ` ${at(12, 12)} you    fix the login`);
  assert.match(text[10], /^ ─ Needs you ─+$/);
  assert.equal(text[11], ' • beta · Unread session  3m  The README is done.');
  assert.match(text[12], /^ ─ Activity ─+$/);
  // As wide as the widest time: a day's, else another day's.
  const tw = [30, 29, 12, 3].some((m) => clock(NOW - m * MINUTE, NOW).length > 8) ? 12 : 8;
  assert.deepEqual(text.slice(13, 17), [
    ` ${at(30, tw)} ${fit('demo', 16)} you    add the panel`,
    ` ${at(29, tw)} ${fit('demo', 16)} claude I will add all four.`,
    ` ${at(12, tw)} ${fit('alpha', 16)} you    fix the login`,
    ` ${at(3, tw)} ${fit('beta', 16)} claude The README is done.`,
  ], 'the newest last, without the tool calls');
  assert.deepEqual(text.slice(17, 36), Array(19).fill(''));
  assert.match(text[36], /^ ─ Usage ─+$/);
  // A bar of 24: half of it used, the mark four-fifths along, as an hour of five is left.
  assert.equal(text[37], ` session ${'█'.repeat(12)}${'░'.repeat(7)}│${'░'.repeat(4)}  ~50%  resets ${timeOfDay(NOW + HOUR)} in 1h00m · +60%/h: 100% at ${timeOfDay(NOW + 50 * MINUTE)}, 10m before`);
  assert.equal(text[38], ` week    ${'█'.repeat(10)}${'░'.repeat(7)}│${'░'.repeat(6)}  ~41%  resets ${weekday(NOW + 48 * HOUR)} ${timeOfDay(NOW + 48 * HOUR)} in 2d00h · +8%/d: about 57% by then`);
  assert.match(text[39], /^ ↑↓ move/);
  // A click on a session opens it; anywhere else, none is selected.
  for (const [y, action] of /** @type {[number, object][]} */ ([
    [6, { unselect: true }], [7, { open: 's:wait' }], [9, { open: 's:wait' }], [10, { unselect: true }], [11, { open: 's:new' }],
    [12, { unselect: true }], [13, { open: 's:busy' }], [15, { open: 's:wait' }], [16, { open: 's:new' }], [20, { unselect: true }], [37, { unselect: true }],
  ])) assert.deepEqual(clickAt(hits, 30, y), action, `line ${y}`);
  lines.slice(0, -1).forEach((l, i) => assert.equal(visible(l), 120, `line ${i}: ${l}`));
  // In color: what reaches 100% before the reset in yellow, the bar's used part as its percent is.
  const color = makeTheme({ color: true, ascii: false, animate: false });
  const colored = panelList(120, 40, {}, color, { ...PANEL_USAGE, tracked: { ...PANEL_USAGE.tracked, session: 80 } }).lines;
  const session = colored.find((l) => l.includes('session') && l.includes('█')) ?? '';
  assert.ok(session.includes(`\x1b[33m${'█'.repeat(19)}\x1b[0m\x1b[1m│\x1b[0m`), JSON.stringify(session));
  assert.ok(session.includes(`\x1b[33m+60%/h: 100% at ${timeOfDay(NOW + 20 * MINUTE)}, 40m before\x1b[0m`), JSON.stringify(session));
});

test("the week's pace below the rows: since the plan changed, where that was after its reset, once a day has gone", () => {
  /** The week's line, the plan changed at `changed`. @param {{ t: number, v: number }} changed */
  const week = (changed) => panelList(120, 40, {}, plain, { ...PANEL_USAGE, changed }).lines.map((l) => l.trimEnd()).find((l) => l.startsWith(' week')) ?? '';
  const head = ` week    ${'█'.repeat(10)}${'░'.repeat(7)}│${'░'.repeat(6)}  ~41%  resets ${weekday(NOW + 48 * HOUR)} ${timeOfDay(NOW + 48 * HOUR)} in 2d00h`;
  assert.equal(week({ t: NOW - 48 * HOUR, v: 5 }), `${head} · +18%/d: about 77% by then`, '36 points in the two days since');
  assert.equal(week({ t: NOW - 12 * HOUR, v: 0 }), head, 'half a day: no pace yet');
  assert.equal(week({ t: NOW - 6 * 24 * HOUR, v: 0 }), `${head} · +8%/d: about 57% by then`, 'before the reset: since the reset');
  assert.equal(week({ t: NOW - 48 * HOUR, v: 40 }), `${head} · +0.5%/d: about 42% by then`, 'a point in two days: in tenths');
});

test('a pace as said: in whole points, or in tenths below one', () => {
  assert.deepEqual([rate(12.4, 'h'), rate(1.5, 'h'), rate(0.96, 'h'), rate(0.36, 'd'), rate(0.04, 'h'), rate(0, 'h')], ['+12%/h', '+2%/h', '+1%/h', '+0.4%/d', '+0%/h', '+0%/h']);
});

test('with less room below the rows, what was said goes first, then what needs you, then the selected session; the usage last', () => {
  /** The panel's sections at a height. @param {number} height */
  const sections = (height) => panelList(120, height).lines.flatMap((l) => /^ ─ (.+?) ─/.exec(l)?.[1] ?? []);
  const preview = '◆ alpha · Waiting session';
  assert.deepEqual(sections(21), [preview, 'Needs you', 'Activity', 'Usage']);
  const tight = panelList(120, 20).lines.map((l) => l.trimEnd());
  assert.ok(!tight.some((l) => l.endsWith('add the panel')) && tight.some((l) => l.endsWith('claude The README is done.')), 'what was said: the newest that fit');
  assert.deepEqual(sections(16), [preview, 'Needs you', 'Usage']);
  assert.deepEqual(sections(14), [preview, 'Usage']);
  assert.deepEqual(sections(12), ['Usage']);
  assert.deepEqual(sections(10), [preview], 'no room for the usage: the selected session has it');
  assert.deepEqual(sections(8), []);
  // More rows than room: none of it.
  assert.deepEqual(sections(6), []);
  // With none selected, the session that waits is with the others that need you.
  const none = panelList(120, 40, { index: -1 }).lines.map((l) => l.trimEnd());
  assert.deepEqual(none.flatMap((l) => /^ ─ (.+?) ─/.exec(l)?.[1] ?? []), ['Needs you', 'Activity', 'Usage']);
  assert.deepEqual(none.slice(8, 10), [
    ' ◆ alpha · Waiting session  10m  a question: which database should the login use?',
    ' • beta · Unread session  3m  The README is done.',
  ]);
});

test('below the rows on a phone: what needs you in two lines at most, the usage without its bar; what you are to do for a blocked session', () => {
  const snap = snapshot([
    ...panelSessions(),
    blockedSession({ key: 's:blk', title: 'Blocked session', project: 'theta', lastActive: NOW - 30 * MINUTE }),
    agent({
      key: 's:long', title: 'Long question', state: 'waiting', project: 'kappa', lastActive: NOW - 5 * MINUTE,
      activity: `waiting: a question: ${'which one of these should it be, '.repeat(4)}`, activityKind: 'waiting', activityAt: NOW - 5 * MINUTE,
    }),
  ], { usage: PANEL_USAGE });
  const ui = { ...initialUi(), selected: 's:idle' };
  const rows = visibleRows(snap, ui, plain);
  settleSelection(ui, rows, 37);
  const lines = listLines(snap, rows, ui, { width: 43, height: 40, now: NOW }, plain);
  const text = lines.map((l) => l.trimEnd());
  const needs = text.findIndex((l) => l.startsWith(' ─ Needs you'));
  assert.deepEqual(text.slice(needs + 1, needs + 9), [
    ' ◆ kappa · Long question  5m  a question:',
    '   which one of these should it be, which …',
    ' ◆ alpha · Waiting session  10m  a',
    '   question: which database should the …',
    ' ◇ theta · Blocked session  30m  say',
    '   whether the stutter was picture or sound',
    ' • beta · Unread session  3m  The README is',
    '   done.',
  ]);
  // A time stays with what it goes with.
  const usage = text.findIndex((l) => l.startsWith(' ─ Usage'));
  assert.deepEqual(text.slice(usage + 1), [
    ` session  ~50%  resets ${timeOfDay(NOW + HOUR)} in 1h00m ·`,
    `                +60%/h: 100% at ${timeOfDay(NOW + 50 * MINUTE)},`,
    '                10m before',
    ` week     ~41%  resets ${weekday(NOW + 48 * HOUR)} ${timeOfDay(NOW + 48 * HOUR)} in 2d00h ·`,
    '                +8%/d: about 57% by then',
    text.at(-1),
  ]);
  lines.slice(0, -1).forEach((l, i) => assert.equal(visible(l), 43, `line ${i}: ${l}`));
});

test('the selected agent below the rows: its task list, the commands it left running, a workflow\'s agents', () => {
  const tool = agent({
    key: 's:t', title: 'Tool session', state: 'idle', project: 'demo', activity: 'Done for now.', activityKind: 'reply',
    plan: planOf(5, 2), commands: [{ summary: 'Bash: Serve the site', ts: NOW - 10 * MINUTE }, { summary: 'Bash: Watch the tests', ts: NOW - 4 * MINUTE }],
    events: [{ ts: NOW - 2 * MINUTE, kind: 'reply', text: 'Done for now.' }],
  });
  const flow = agent({ key: 'w:1', type: 'workflow', title: 'review-changes', state: 'running', phase: 'Review', counts: { total: 4, running: 1, done: 2, failed: 1 } });
  tool.children = [flow];
  const snap = snapshot([tool]);
  /** The panel with the agent with this key selected. @param {string} selected */
  const panel = (selected) => {
    const ui = { ...initialUi(), selected };
    const rows = visibleRows(snap, ui, plain);
    settleSelection(ui, rows, 21);
    return listLines(snap, rows, ui, { width: 100, height: 24, now: NOW }, plain).map((l) => l.trimEnd()).slice(2 + rows.length);
  };
  assert.deepEqual(panel('s:t').slice(1, 6).map((l) => l.replace(/─{3,}/, '──')), [
    ' ─ ◎ demo · Tool session ── background ─',
    ' Last       Done for now.',
    ' Background Bash: Watch the tests  (4m00s)  and 1 more',
    ' Tasks      2/5  ▸ step 3',
    ` ${fit(clock(NOW - 2 * MINUTE, NOW), 12)} claude Done for now.`,
  ]);
  assert.deepEqual(panel('w:1').slice(1, 3).map((l) => l.replace(/─{3,}/, '──')), [
    ' ─ ● Review · review-changes ── running ─',
    ' Agents     4 in all · 1 running · 2 done · 1 failed',
  ]);
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
    panelList(120, 40, {}, ascii).lines,
    panelList(43, 40, {}, ascii).lines,
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
