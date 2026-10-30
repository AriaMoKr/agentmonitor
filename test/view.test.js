import assert from 'node:assert/strict';
import { test } from 'node:test';
import { width } from '../src/format.js';
import { columns, detailLines, helpLines, initialUi, listLines, makeTheme, settleSelection, table, visibleRows } from '../src/view.js';
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
  assert.deepEqual(columns(80).map((c) => c.key), ['state', 'title', 'project', 'activity', 'last']);
  assert.deepEqual(columns(160).map((c) => c.key), ['state', 'title', 'project', 'kind', 'model', 'ctx', 'activity', 'last', 'pid']);
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
  assert.match(footer(160), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}s sort:status {2}e ended:on {2}a agents:running {2}w window {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(100), /^ ↑↓ move .*e ended:on {2}a agents:running {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(60), /^ ↑↓ move {2}⏎ details {2}\/ filter {2}\? help {2}q quit +1\/8 $/);
  assert.match(footer(100, 'parser'), /^ filter "parser" esc clears {2}↑↓ move {2}⏎ details {2}\/ filter {2}\? help {2}q quit +1\/4 $/);
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
    /helper +Explore/,
    /Activity/,
    /you {4}Fix the parser/,
    /error {2}Bash: npm test failed: Exit code 1/,
    /claude All done\./,
  ]) assert.match(text, re);
  lines.forEach((l, i) => assert.equal(visible(l), i === lines.length - 1 ? 99 : 100, `line ${i}: ${l}`));
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

test('the help fills the screen, its last line one column short', () => {
  const lines = helpLines({ width: 90, height: 40, now: NOW }, plain, '/home/me/.claude');
  assert.equal(lines.length, 40);
  assert.match(lines.join('\n'), /Keys[\s\S]*States[\s\S]*Columns[\s\S]*Reading \/home\/me\/\.claude/);
  lines.slice(0, -1).forEach((l) => assert.equal(visible(l), 90, l));
  assert.equal(lines[39], ' '.repeat(89));
  assert.equal(helpLines({ width: 90, height: 10, now: NOW }, plain, '/x').length, 10);
});

test('with --ascii, nothing but ASCII is drawn', () => {
  const ascii = makeTheme({ color: false, ascii: true, animate: true });
  const busy = busySession();
  // A workflow that is not the last agent: a line runs down past its agents to the next.
  busy.children.reverse();
  const snap = snapshot([busy, ...sessions().filter((a) => a.key !== 's:busy')]);
  const ui = { ...initialUi(), agents: /** @type {const} */ ('all') };
  const rows = visibleRows(snap, ui, ascii);
  settleSelection(ui, rows, 17);
  assert.ok(rows.some((r) => r.prefix === '|  |- '), rows.map((r) => r.prefix).join(','));
  const screens = [
    listLines(snap, rows, ui, { width: 120, height: 20, now: NOW }, ascii),
    detailLines(busy, snap, ui, { width: 120, height: 20, now: NOW }, ascii),
    helpLines({ width: 120, height: 30, now: NOW }, ascii, '/home/me/.claude'),
    table(snap, { width: 120, now: NOW, agents: 'all', showEnded: true }, ascii).split('\n'),
  ];
  for (const line of screens.flat()) assert.match(line, /^[\x20-\x7e]*$/, line);
});

test('the table printed once: no selection, no trailing spaces', () => {
  const out = table(snapshot(sessions()), { width: 100, now: NOW, agents: 'running', showEnded: false }, plain);
  assert.ok(out.endsWith('\n'));
  const lines = out.trimEnd().split('\n');
  assert.match(lines[0], /^ Claude agents {2}● 1 working/);
  assert.match(lines[1], /^ {3}NAME +PROJECT +CTX +ACTIVITY +LAST$/);
  assert.equal(lines.length, 2 + 7);
  assert.ok(!out.includes('Ended session'));
  for (const l of lines) {
    assert.equal(l, l.trimEnd());
    assert.ok(visible(l) <= 100, l);
  }
  assert.match(table(snapshot([]), { width: 100, now: NOW, agents: 'running', showEnded: true }, plain), /No Claude agents running or active in the last 24h\./);
  assert.match(table(snapshot([], { found: false }), { width: 100, now: NOW, agents: 'running', showEnded: true }, plain), /No Claude Code sessions found in \/home\/me\/\.claude\./);
});
