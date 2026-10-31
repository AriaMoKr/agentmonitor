import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { Monitor } from '../src/monitor.js';
import { HOUR, iso, makeConfig, MINUTE, NOW, rec, sessionId } from './helpers/fixture.js';

/**
 * A monitor of a test config folder; `running` gives the processes that run, as { pid: program }.
 * @param {ReturnType<typeof makeConfig>} cfg
 * @param {{ running?: Record<number, string>, windowMs?: number }} [o]
 */
function monitorOf(cfg, { running = {}, windowMs = 24 * HOUR } = {}) {
  const calls = { table: 0 };
  const monitor = new Monitor({
    dir: cfg.dir,
    windowMs,
    desktopDirs: async () => [cfg.desktop],
    isRunning: (pid) => Object.hasOwn(running, pid),
    processTable: async () => {
      calls.table++;
      return new Map(Object.entries(running).map(([pid, name]) => [Number(pid), { name, memKB: 300 * 1024 }]));
    },
  });
  return { monitor, calls };
}

test('the plan\'s usage, as the desktop app last sampled it', async (t) => {
  const cfg = makeConfig(t);
  const { monitor } = monitorOf(cfg);
  assert.equal((await monitor.refresh(NOW)).usage, undefined, 'none until the app samples it');
  cfg.planUsage([[NOW - 35 * MINUTE, 0, 10], [NOW - 20 * MINUTE, 40, 10], [NOW - 5 * MINUTE, 64, 29]]);
  assert.deepEqual((await monitor.refresh(NOW + 5000)).usage, {
    at: NOW - 5 * MINUTE,
    session: 64,
    week: 29,
    sessionReset: { at: NOW - 35 * MINUTE + 5 * HOUR, from: NOW - 35 * MINUTE + 5 * HOUR, to: NOW - 20 * MINUTE + 5 * HOUR },
  }, 'the session began after its last 0%; the week has not dropped');
});

test('a running session: its state, title, folder, model, context and the tool it is in', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [
    rec.prompt('Fix the parser', NOW - 5 * MINUTE),
    rec.aiTitle('Fixing the parser'),
    rec.tool('toolu_1', 'Bash', { command: 'npm test', description: 'Run the tests' }, NOW - 30_000),
  ], { mtime: NOW - 30_000 });
  cfg.registry({
    pid: 4242, sessionId: id, cwd: 'C:\\work\\demo', status: 'busy', name: 'fix-the-parser', nameSource: 'derived',
    startedAt: NOW - 10 * MINUTE, statusUpdatedAt: NOW - 30_000,
  });
  const { monitor } = monitorOf(cfg, { running: { 4242: 'claude.exe' } });
  const snap = await monitor.refresh(NOW);
  assert.equal(snap.found, true);
  assert.equal(snap.rows.length, 1);
  const s = snap.rows[0];
  assert.equal(s.key, `s:${id}`);
  assert.equal(s.type, 'session');
  assert.equal(s.state, 'working');
  assert.equal(s.live, true);
  assert.equal(s.title, 'Fixing the parser', 'a name made up from the prompt gives way to the title');
  assert.equal(s.activity, 'Bash: Run the tests');
  assert.equal(s.activityKind, 'tool');
  assert.equal(s.activityAt, NOW - 30_000);
  assert.deepEqual(s.pending, [{ summary: 'Bash: Run the tests', ts: NOW - 30_000 }]);
  assert.equal(s.pid, 4242);
  assert.equal(s.memKB, 300 * 1024);
  assert.equal(s.cwd, 'C:\\work\\demo');
  assert.equal(s.project, 'demo');
  assert.equal(s.branch, 'main');
  assert.equal(s.kind, 'cli');
  assert.equal(s.version, '2.1.309');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.ctx, 60_005);
  assert.equal(s.startedAt, NOW - 5 * MINUTE);
  assert.equal(s.processStartedAt, NOW - 10 * MINUTE);
  assert.equal(s.lastActive, NOW - 30_000);
});

test('waiting and idle sessions; a name the user gave comes first', async (t) => {
  const cfg = makeConfig(t);
  const waiting = sessionId();
  cfg.transcript(waiting, [rec.prompt('Deploy it', NOW - 2 * MINUTE), rec.tool('toolu_w', 'Bash', { command: 'deploy.sh' }, NOW - MINUTE)], { mtime: NOW - MINUTE });
  cfg.registry({ pid: 10, sessionId: waiting, status: 'waiting', waitingFor: 'permission: Bash', name: 'Release', nameSource: 'user', statusUpdatedAt: NOW - MINUTE });
  const idle = sessionId();
  cfg.transcript(idle, [rec.prompt('Explain the code', NOW - 20 * MINUTE), rec.reply('It reads the registry.', NOW - 19 * MINUTE)], { mtime: NOW - 19 * MINUTE });
  cfg.registry({ pid: 11, sessionId: idle, status: 'idle', statusUpdatedAt: NOW - 19 * MINUTE });
  const { monitor } = monitorOf(cfg, { running: { 10: 'claude.exe', 11: 'node.exe' } });
  const rows = (await monitor.refresh(NOW)).rows;
  const w = rows.find((r) => r.sessionId === waiting);
  assert.equal(w?.state, 'waiting');
  assert.equal(w?.title, 'Release');
  assert.equal(w?.activity, 'waiting: permission: Bash');
  assert.equal(w?.activityKind, 'waiting');
  assert.equal(w?.activityAt, NOW - MINUTE);
  const i = rows.find((r) => r.sessionId === idle);
  assert.equal(i?.state, 'idle');
  assert.equal(i?.title, 'Explain the code');
  assert.equal(i?.activity, 'It reads the registry.');
  assert.equal(i?.activityKind, 'reply');
});

test('a call that asks you something: a question, a plan to approve, the offer of a session', async (t) => {
  const cfg = makeConfig(t);
  /** @param {number} pid @param {object[]} records */
  const session = (pid, records) => {
    const id = sessionId();
    cfg.transcript(id, [rec.prompt('Plan the release', NOW - 5 * MINUTE), ...records], { mtime: NOW - MINUTE });
    cfg.registry({ pid, sessionId: id, status: 'busy', entrypoint: 'claude-desktop', statusUpdatedAt: NOW - 5 * MINUTE });
    return id;
  };
  const questions = [{ question: 'Which \x1b[1mbranch?', header: 'Branch', options: [], multiSelect: false }, { question: 'Tag it?', header: 'Tag', options: [], multiSelect: false }];
  const question = session(1, [rec.tool('q1', 'AskUserQuestion', { questions }, NOW - MINUTE)]);
  const plan = session(2, [rec.tool('p1', 'ExitPlanMode', { plan: '1. Build\n2. Ship' }, NOW - MINUTE)]);
  const offer = session(3, [rec.tool('o1', 'mcp__ccd_session__start_session', { initiation: 'offer', title: 'Fix the docs' }, NOW - MINUTE)]);
  const started = session(4, [rec.tool('o2', 'mcp__ccd_session__start_session', { initiation: 'user_asked', title: 'Fix the docs' }, NOW - MINUTE)]);
  const answered = session(5, [rec.tool('q2', 'AskUserQuestion', { questions }, NOW - 2 * MINUTE), rec.result('q2', NOW - MINUTE, false, 'User has answered your questions: "Which branch?"="main".')]);
  const running = Object.fromEntries([1, 2, 3, 4, 5].map((pid) => [pid, 'claude.exe']));
  const rows = (await monitorOf(cfg, { running }).monitor.refresh(NOW)).rows;
  const seen = (/** @type {string} */ id) => {
    const r = rows.find((x) => x.sessionId === id);
    return [r?.state, r?.activityKind, r?.activity, r?.activityAt, r?.inTool];
  };
  assert.deepEqual(seen(question), ['waiting', 'waiting', 'waiting: a question: Which branch? (+1 more)', NOW - MINUTE, undefined]);
  assert.deepEqual(seen(plan), ['waiting', 'waiting', 'waiting: a plan to approve', NOW - MINUTE, undefined]);
  assert.deepEqual(seen(offer), ['waiting', 'waiting', 'waiting: a session offer: Fix the docs', NOW - MINUTE, undefined]);
  assert.deepEqual(seen(started), ['working', 'tool', 'ccd_session:start_session: user_asked', NOW - MINUTE, true], 'a session started without asking: a tool it waits on');
  assert.deepEqual(seen(answered), ['working', 'thinking', 'thinking', NOW - MINUTE, undefined]);
});

test('in a tool: a call other than an agent, a few seconds after it was made', async (t) => {
  const cfg = makeConfig(t);
  /** @param {number} pid @param {string} name @param {object} input @param {number} at */
  const session = (pid, name, input, at) => {
    const id = sessionId();
    cfg.transcript(id, [rec.prompt('Build it', NOW - 5 * MINUTE), rec.tool(`toolu_${pid}`, name, input, at)], { mtime: at });
    cfg.registry({ pid, sessionId: id, status: 'busy', statusUpdatedAt: at });
    return id;
  };
  const long = session(1, 'Bash', { command: 'npm run build', description: 'Build' }, NOW - 3000);
  const short = session(2, 'Bash', { command: 'ls' }, NOW - 2900);
  const agent = session(3, 'Agent', { subagent_type: 'Explore', description: 'Find the parser' }, NOW - MINUTE);
  const running = { 1: 'claude.exe', 2: 'claude.exe', 3: 'claude.exe' };
  const rows = (await monitorOf(cfg, { running }).monitor.refresh(NOW)).rows;
  const seen = (/** @type {string} */ id) => {
    const r = rows.find((x) => x.sessionId === id);
    return [r?.state, r?.activity, r?.inTool];
  };
  assert.deepEqual(seen(long), ['working', 'Bash: Build', true]);
  assert.deepEqual(seen(short), ['working', 'Bash: ls', undefined]);
  assert.deepEqual(seen(agent), ['working', 'Agent: Explore: Find the parser', undefined], 'an agent at work is shown as one');
});

test('a command in the background of a session whose turn is over; its task list, of this turn or an earlier one', async (t) => {
  const cfg = makeConfig(t);
  const steps = [{ content: 'Build', status: 'completed' }, { content: 'Serve', status: 'in_progress' }, { content: 'Check', status: 'pending' }];
  const records = [
    rec.prompt('Serve it', NOW - 10 * MINUTE),
    rec.tool('p1', 'mcp__ccd_turn__update_plan', { items: steps, scope: 'first_task' }, NOW - 9 * MINUTE),
    rec.result('p1', NOW - 9 * MINUTE + 100, false, 'Plan shown (3 steps).'),
    rec.tool('b1', 'Bash', { command: 'npm run serve', description: 'Serve the site', run_in_background: true }, NOW - 8 * MINUTE),
    rec.result('b1', NOW - 8 * MINUTE + 500, false, 'Command running in background with ID: bx1.'),
    rec.reply('It serves on port 8080.', NOW - 7 * MINUTE),
  ];
  const live = sessionId();
  cfg.transcript(live, records, { mtime: NOW - 7 * MINUTE });
  cfg.registry({ pid: 1, sessionId: live, status: 'idle', statusUpdatedAt: NOW - 7 * MINUTE });
  const ended = sessionId();
  cfg.transcript(ended, records, { mtime: NOW - 7 * MINUTE });
  const later = sessionId();
  cfg.transcript(later, [...records, rec.prompt('Thanks', NOW - 2 * MINUTE), rec.reply('You are welcome.', NOW - MINUTE)], { mtime: NOW - MINUTE });
  cfg.registry({ pid: 2, sessionId: later, status: 'idle', statusUpdatedAt: NOW - MINUTE });
  const rows = (await monitorOf(cfg, { running: { 1: 'claude.exe', 2: 'claude.exe' } }).monitor.refresh(NOW)).rows;
  const row = (/** @type {string} */ id) => rows.find((r) => r.sessionId === id);
  const plan = { steps: steps.map((s) => ({ text: s.content, status: s.status })), at: NOW - 9 * MINUTE + 100, current: true };

  const l = row(live);
  assert.deepEqual([l?.state, l?.activityKind, l?.activity, l?.activityAt], ['idle', 'background', 'background: Bash: Serve the site', NOW - 8 * MINUTE]);
  assert.deepEqual(l?.commands, [{ summary: 'Bash: Serve the site', ts: NOW - 8 * MINUTE }]);
  assert.deepEqual(l?.plan, plan);
  // Its process gone, nothing goes on in the background.
  const e = row(ended);
  assert.deepEqual([e?.state, e?.activityKind, e?.activity, e?.commands], ['ended', 'reply', 'It serves on port 8080.', undefined]);
  assert.deepEqual(row(later)?.plan, { ...plan, current: false }, 'made before the last prompt');
});

test('a session two processes run has a row for each', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Twice', NOW - MINUTE)], { mtime: NOW - MINUTE });
  cfg.registry({ pid: 20, sessionId: id, status: 'idle' });
  cfg.registry({ pid: 21, sessionId: id, status: 'busy' });
  const { monitor } = monitorOf(cfg, { running: { 20: 'claude', 21: 'claude' } });
  const rows = (await monitor.refresh(NOW)).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.pid).sort(), [20, 21]);
  const [first, second] = rows;
  assert.equal(first.key, `s:${id}`);
  assert.equal(second.key, `s:${id}:${second.pid}`);
});

test('a record whose process is gone, or is another program now, is a session that ended', async (t) => {
  const cfg = makeConfig(t);
  const gone = sessionId();
  cfg.transcript(gone, [rec.prompt('Gone', NOW - 30 * MINUTE), rec.reply('Bye.', NOW - 29 * MINUTE)], { mtime: NOW - 29 * MINUTE });
  cfg.registry({ pid: 30, sessionId: gone, status: 'busy' });
  const reused = sessionId();
  cfg.transcript(reused, [rec.prompt('Reused', NOW - 40 * MINUTE), rec.reply('Bye.', NOW - 39 * MINUTE)], { mtime: NOW - 39 * MINUTE });
  cfg.registry({ pid: 31, sessionId: reused, status: 'busy' });
  // A process started ahead of a session, before it runs one.
  cfg.registry({ pid: 32, sessionId: sessionId(), spare: true, status: 'idle' });
  const { monitor } = monitorOf(cfg, { running: { 31: 'notepad.exe', 32: 'claude.exe' } });
  const rows = (await monitor.refresh(NOW)).rows;
  assert.deepEqual(rows.map((r) => [r.title, r.state, r.live, r.pid]).sort(), [
    ['Gone', 'ended', false, undefined],
    ['Reused', 'ended', false, undefined],
  ]);
});

test('without a process: active when written moments ago, else ended; outside the window, not listed', async (t) => {
  const cfg = makeConfig(t);
  const active = sessionId();
  cfg.transcript(active, [rec.prompt('Quick job', NOW - 40_000), rec.tool('toolu_q', 'Bash', { command: 'make' }, NOW - 20_000)], { mtime: NOW - 20_000 });
  const ended = sessionId();
  cfg.transcript(ended, [rec.prompt('Earlier today', NOW - 3 * HOUR), rec.reply('Done.', NOW - 3 * HOUR + 1000)], { mtime: NOW - 3 * HOUR + 1000 });
  const old = sessionId();
  cfg.transcript(old, [rec.prompt('Yesterday', NOW - 30 * HOUR)], { mtime: NOW - 30 * HOUR });
  // Claude Code appends its totals, without a time, to every transcript open when the app quits.
  const touched = sessionId();
  cfg.transcript(touched, [rec.prompt('Long ago', NOW - 30 * HOUR), rec.reply('ok', NOW - 30 * HOUR + 1000), rec.cost()], { mtime: NOW - HOUR });
  const { monitor } = monitorOf(cfg);
  const rows = (await monitor.refresh(NOW)).rows;
  assert.deepEqual(rows.map((r) => r.title).sort(), ['Earlier today', 'Quick job']);
  const a = rows.find((r) => r.title === 'Quick job');
  assert.equal(a?.state, 'active');
  assert.equal(a?.live, false);
  assert.equal(a?.activity, 'Bash: make');
  const e = rows.find((r) => r.title === 'Earlier today');
  assert.equal(e?.state, 'ended');
  assert.equal(e?.activity, 'Done.');
  assert.equal(e?.activityKind, 'reply');
  assert.equal(e?.lastActive, NOW - 3 * HOUR + 1000);
});

test('a session seen running that stops has ended, though it wrote moments ago', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Short', NOW - 30_000), rec.reply('Bye.', NOW - 10_000)], { mtime: NOW - 10_000 });
  const record = cfg.registry({ pid: 40, sessionId: id, status: 'idle', statusUpdatedAt: NOW - 10_000 });
  const { monitor } = monitorOf(cfg, { running: { 40: 'claude.exe' } });
  assert.equal((await monitor.refresh(NOW)).rows[0].state, 'idle');
  rmSync(record);
  const [s] = (await monitor.refresh(NOW + 1000)).rows;
  assert.equal(s.state, 'ended');
  assert.equal(s.live, false);
});

test('subagents: at work, done when their call returned or they finished, ended when quiet long', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [
    rec.prompt('Look into the parser', NOW - 10 * MINUTE),
    rec.tool('toolu_a1', 'Agent', { subagent_type: 'Explore', description: 'find the parser' }, NOW - 9 * MINUTE),
    rec.tool('toolu_a2', 'Agent', { subagent_type: 'general-purpose', description: 'write tests' }, NOW - 9 * MINUTE + 1000),
    rec.result('toolu_a2', NOW - 2 * MINUTE),
  ], { mtime: NOW - 2 * MINUTE });
  cfg.registry({ pid: 50, sessionId: id, status: 'busy', statusUpdatedAt: NOW - 9 * MINUTE });
  const fg = { requestShape: 'foreground' };
  const bg = { requestShape: 'background' };
  cfg.subagent(id, 'a1', { ...fg, agentType: 'Explore', description: 'find the parser', toolUseId: 'toolu_a1' }, [
    rec.prompt('find the parser', NOW - 9 * MINUTE),
    rec.tool('toolu_x', 'Grep', { pattern: 'parse', path: 'C:\\work\\demo\\src' }, NOW - 20_000, { effort: 'medium' }),
  ], { mtime: NOW - 20_000 });
  cfg.subagent(id, 'a2', { ...fg, agentType: 'general-purpose', description: 'write tests', toolUseId: 'toolu_a2' }, [
    rec.prompt('write tests', NOW - 9 * MINUTE),
    rec.reply('Tests written.', NOW - 2 * MINUTE),
  ], { mtime: NOW - 2 * MINUTE });
  cfg.subagent(id, 'a3', { ...bg, agentType: 'general-purpose', description: 'watch CI', finished: true }, [
    rec.prompt('watch CI', NOW - 8 * MINUTE),
    rec.reply('CI passed.', NOW - 5 * MINUTE),
  ], { mtime: NOW - 5 * MINUTE });
  cfg.subagent(id, 'a4', { ...bg, agentType: 'general-purpose', description: 'old helper' }, [
    rec.prompt('help', NOW - 40 * MINUTE),
    rec.tool('toolu_y', 'Bash', { command: 'ls' }, NOW - 35 * MINUTE),
    rec.result('toolu_y', NOW - 34 * MINUTE),
  ], { mtime: NOW - 34 * MINUTE });
  const { monitor } = monitorOf(cfg, { running: { 50: 'claude.exe' } });
  const [s] = (await monitor.refresh(NOW)).rows;
  assert.equal(s.activity, 'Agent: Explore: find the parser');
  assert.deepEqual(s.children.map((c) => [c.title, c.state]), [
    ['find the parser', 'running'],
    ['write tests', 'done'],
    ['watch CI', 'done'],
    ['old helper', 'ended'],
  ]);
  const [a1, a2, a3] = s.children;
  assert.equal(a1.key, `a:${id}:a1`);
  assert.equal(a1.type, 'subagent');
  assert.equal(a1.live, true);
  assert.equal(a1.agentType, 'Explore');
  assert.equal(a1.background, false);
  assert.equal(a1.activity, 'Grep: parse in src');
  assert.equal(a1.activityAt, NOW - 20_000);
  assert.equal(a1.ctx, 60_005);
  assert.equal(a1.effort, 'medium');
  assert.equal(a2.lastActive, NOW - 2 * MINUTE);
  assert.equal(a3.background, true);
});

test('the agent being looked at has its transcript read, though it is done', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [
    rec.prompt('Check it', NOW - 10 * MINUTE),
    rec.tool('toolu_a', 'Agent', { subagent_type: 'Explore', description: 'look around' }, NOW - 9 * MINUTE),
    rec.result('toolu_a', NOW - 5 * MINUTE),
    rec.reply('Checked.', NOW - 4 * MINUTE),
  ], { mtime: NOW - 4 * MINUTE });
  cfg.subagent(id, 'x1', { requestShape: 'foreground', agentType: 'Explore', description: 'look around', toolUseId: 'toolu_a' }, [
    rec.prompt('look around', NOW - 9 * MINUTE),
    rec.reply('Nothing odd.', NOW - 5 * MINUTE),
  ], { mtime: NOW - 5 * MINUTE });
  const { monitor } = monitorOf(cfg);
  const child = async () => (await monitor.refresh(NOW)).rows[0].children[0];
  const before = await child();
  assert.deepEqual([before.state, before.activity, before.events.length], ['done', '', 0]);
  // Looked at from the terminal and a web page: either one has it read.
  monitor.focus = new Set([`a:${id}:x9`, `a:${id}:x1`]);
  const focused = await child();
  assert.equal(focused.state, 'done');
  assert.equal(focused.activity, 'Nothing odd.');
  assert.deepEqual(focused.events.map((e) => e.kind), ['prompt', 'reply']);
  assert.equal(focused.model, 'claude-opus-5-5');
  monitor.focus = new Set();
  assert.equal((await child()).activity, '');
});

test('workflow runs: one at work, with its agents, and one finished, with its record', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [
    rec.prompt('Review the change', NOW - 20 * MINUTE),
    rec.tool('toolu_wf', 'Workflow', { script: "export const meta = { name: 'review-changes' }" }, NOW - 19 * MINUTE),
    rec.result('toolu_wf', NOW - 19 * MINUTE + 1000),
    rec.reply('The review runs in the background.', NOW - 19 * MINUTE + 2000),
  ], { mtime: NOW - 19 * MINUTE + 2000 });
  cfg.registry({ pid: 60, sessionId: id, status: 'busy', statusUpdatedAt: NOW - 19 * MINUTE });
  cfg.workflow(id, 'wf_run1', {
    agents: [
      {
        id: 'w1', label: 'review:bugs', phase: 'Review', state: 'running',
        records: [rec.prompt('find bugs', NOW - 18 * MINUTE), rec.tool('toolu_r1', 'Read', { file_path: 'C:\\work\\demo\\src\\a.js' }, NOW - 10_000, { effort: 'low' })],
      },
      {
        id: 'w2', label: 'review:perf', phase: 'Review', state: 'done',
        records: [rec.prompt('find slow code', NOW - 18 * MINUTE), rec.reply('Nothing slow.', NOW - 5 * MINUTE)],
      },
    ],
    script: 'review-changes',
    mtime: NOW - 10_000,
  });
  cfg.workflow(id, 'wf_run0', {
    agents: [{ id: 'w0', label: 'scan', phase: 'Scan', state: 'done', records: [rec.prompt('scan', NOW - 3 * HOUR), rec.reply('done', NOW - 2 * HOUR)] }],
    record: { status: 'completed', workflowName: 'find-flaky-tests', startTime: NOW - 3 * HOUR, durationMs: HOUR, totalTokens: 1_234_567, defaultModel: 'claude-opus-5-5' },
    mtime: NOW - 2 * HOUR,
  });
  const { monitor } = monitorOf(cfg, { running: { 60: 'claude.exe' } });
  const [s] = (await monitor.refresh(NOW)).rows;
  assert.equal(s.activity, '1 agent running');
  assert.equal(s.activityKind, 'agents');
  assert.equal(s.activityAt, NOW - 10_000);
  const [run, done] = s.children;
  assert.equal(run.key, `w:${id}:wf_run1`);
  assert.equal(run.type, 'workflow');
  assert.equal(run.title, 'review-changes', 'named after its script');
  assert.equal(run.state, 'running');
  assert.deepEqual(run.counts, { running: 1, done: 1, failed: 0, total: 2 });
  assert.equal(run.phase, 'Review');
  assert.equal(run.activity, 'Review: 1 running, 1/2 done');
  assert.deepEqual(run.children.map((a) => [a.key, a.title, a.state, a.activity, a.effort]), [
    [`a:${id}:w1`, 'review:bugs', 'running', 'Read: src\\a.js', 'low'],
    [`a:${id}:w2`, 'review:perf', 'done', '', undefined],
  ]);
  assert.equal(run.effort, undefined, 'a run has none of its own: its agents each have theirs');
  assert.equal(done.title, 'find-flaky-tests');
  assert.equal(done.state, 'done');
  assert.equal(done.activity, 'completed, 1 agent');
  assert.equal(done.tokens, 1_234_567);
  assert.equal(done.durationMs, HOUR);
  assert.equal(done.startedAt, NOW - 3 * HOUR);
  assert.equal(done.model, 'claude-opus-5-5');
});

test("a background job, and the desktop app's title and settings", async (t) => {
  const cfg = makeConfig(t);
  const job = sessionId();
  cfg.job('j1', {
    sessionId: job, name: 'Nightly triage', state: 'blocked', needs: 'approve the plan', cwd: 'C:\\work\\jobs',
    createdAt: iso(NOW - HOUR), updatedAt: iso(NOW - 2 * MINUTE),
  });
  const app = sessionId();
  cfg.transcript(app, [rec.prompt('Plan the release', NOW - 5 * MINUTE, { entrypoint: 'claude-desktop' }), rec.aiTitle('Release planning')], { mtime: NOW - 5 * MINUTE });
  cfg.registry({
    pid: 70, sessionId: app, status: 'idle', entrypoint: 'claude-desktop', hostSessionId: 'local_abc',
    name: 'plan-the-release', nameSource: 'derived', statusUpdatedAt: NOW - 5 * MINUTE,
  });
  cfg.desktopSession({
    sessionId: 'local_abc', cliSessionId: app, title: 'Release plan', isArchived: true,
    model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'acceptEdits', lastActivityAt: NOW - 5 * MINUTE,
  });
  const { monitor } = monitorOf(cfg, { running: { 70: 'claude.exe' } });
  const rows = (await monitor.refresh(NOW)).rows;
  const j = rows.find((r) => r.sessionId === job);
  assert.equal(j?.title, 'Nightly triage');
  assert.equal(j?.kind, 'bg');
  assert.equal(j?.state, 'ended');
  assert.equal(j?.activity, 'blocked: approve the plan');
  assert.equal(j?.activityKind, 'job');
  assert.equal(j?.project, 'jobs');
  assert.equal(j?.lastActive, NOW - 2 * MINUTE);
  assert.equal(j?.startedAt, NOW - HOUR);
  const d = rows.find((r) => r.sessionId === app);
  assert.equal(d?.title, 'Release plan');
  assert.equal(d?.kind, 'desktop');
  assert.equal(d?.archived, true);
  assert.equal(d?.hostSessionId, 'local_abc');
  assert.equal(d?.model, 'claude-sonnet-5-5');
  assert.equal(d?.effort, 'high');
  assert.equal(d?.permissionMode, 'acceptEdits');
});

test("the effort: of the turn at work, else the desktop app's setting, which the next turn takes", async (t) => {
  const cfg = makeConfig(t);
  /** @param {number} pid @param {string | undefined} status none: its process is gone @param {string} [app] the app's setting; '' none */
  const session = (pid, status, app) => {
    const id = sessionId();
    const records = [rec.prompt('Work', NOW - 10 * MINUTE), rec.tool(`toolu_${pid}`, 'Read', { file_path: 'a.js' }, NOW - 9 * MINUTE, { effort: 'xhigh' })];
    if (status !== 'busy') records.push(rec.result(`toolu_${pid}`, NOW - 9 * MINUTE + 500), rec.reply('Read it.', NOW - 8 * MINUTE, { effort: 'xhigh' }));
    cfg.transcript(id, records, { mtime: NOW - 8 * MINUTE });
    const local = `local_${pid}`;
    if (status) cfg.registry({ pid, sessionId: id, status, entrypoint: app === undefined ? 'cli' : 'claude-desktop', statusUpdatedAt: NOW - 8 * MINUTE });
    if (app !== undefined) cfg.desktopSession({ sessionId: local, cliSessionId: id, title: local, ...(app ? { effort: app } : {}) });
    return id;
  };
  const working = session(1, 'busy', 'max');
  const idle = session(2, 'idle', 'max');
  const cli = session(3, 'idle');
  const ended = session(4, undefined, 'max');
  const unset = session(5, 'idle', '');
  const rows = (await monitorOf(cfg, { running: { 1: 'claude.exe', 2: 'claude.exe', 3: 'claude.exe', 5: 'claude.exe' } }).monitor.refresh(NOW)).rows;
  const effort = (/** @type {string} */ id) => {
    const r = rows.find((x) => x.sessionId === id);
    return [r?.state, r?.effort];
  };
  assert.deepEqual(effort(working), ['working', 'xhigh'], "at work: its turn's, though the app was set to another since");
  assert.deepEqual(effort(idle), ['idle', 'max']);
  assert.deepEqual(effort(cli), ['idle', 'xhigh'], 'no app: its last reply\'s');
  assert.deepEqual(effort(ended), ['ended', 'max']);
  assert.deepEqual(effort(unset), ['idle', 'xhigh'], 'the app has none');
});

test("ultracode: the desktop app's setting for a session, else a reminder of it in the transcript", async (t) => {
  const cfg = makeConfig(t);
  /**
   * @param {number} pid @param {boolean} reminded a reminder came after its prompt
   * @param {Record<string, unknown> | null} [settings] the app's sessionSettings; null: a record without them; none: no record
   */
  const session = (pid, reminded, settings) => {
    const id = sessionId();
    const records = [rec.prompt('Work', NOW - 10 * MINUTE), ...(reminded ? [rec.ultra(NOW - 10 * MINUTE)] : []), rec.reply('Done.', NOW - 8 * MINUTE, { effort: 'max' })];
    cfg.transcript(id, records, { mtime: NOW - 8 * MINUTE });
    cfg.registry({ pid, sessionId: id, status: 'idle', entrypoint: settings === undefined ? 'cli' : 'claude-desktop', statusUpdatedAt: NOW - 8 * MINUTE });
    if (settings !== undefined) cfg.desktopSession({ sessionId: `local_${pid}`, cliSessionId: id, title: `local_${pid}`, ...(settings ? { sessionSettings: settings } : {}) });
    return id;
  };
  const on = session(1, false, { ultracode: true });
  const off = session(2, true, {});
  const unset = session(3, true, null);
  const cli = session(4, true);
  const none = session(5, false);
  const rows = (await monitorOf(cfg, { running: { 1: 'claude.exe', 2: 'claude.exe', 3: 'claude.exe', 4: 'claude.exe', 5: 'claude.exe' } }).monitor.refresh(NOW)).rows;
  const ultracode = (/** @type {string} */ id) => rows.find((r) => r.sessionId === id)?.ultracode;
  assert.equal(ultracode(on), true, 'though no reminder was read');
  assert.equal(ultracode(off), undefined, "the app's setting over a reminder before it");
  assert.equal(ultracode(unset), true, 'the app keeps no settings for it: the reminder');
  assert.equal(ultracode(cli), true);
  assert.equal(ultracode(none), undefined);
});

test('what the files say is cleaned before it is drawn: the folder, branch, model and effort, a job', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Hello', NOW - 5 * MINUTE, { gitBranch: '\x1b[31mmain', permissionMode: 'accept\x1b[0mEdits' })], { mtime: NOW - 5 * MINUTE });
  cfg.registry({ pid: 90, sessionId: id, status: 'idle', cwd: 'C:\\work\\\x1b]0;pwned\x07demo', version: '2.1.309\x1b[5m', entrypoint: 'claude-desktop', statusUpdatedAt: NOW - 5 * MINUTE });
  cfg.desktopSession({ sessionId: 'local_e', cliSessionId: id, model: '\x1b[2Jclaude-sonnet-5-5', effort: 'max\x07' });
  const job = sessionId();
  cfg.job('j2', { sessionId: job, name: 'Triage', state: '\x1b[1mblocked', needs: 'approve \x1b]8;;http://x\x07the plan\x1b]8;;\x07', updatedAt: iso(NOW - MINUTE) });
  const rows = (await monitorOf(cfg, { running: { 90: 'claude.exe' } }).monitor.refresh(NOW)).rows;
  const s = rows.find((r) => r.sessionId === id);
  assert.deepEqual([s?.cwd, s?.project, s?.branch, s?.version, s?.model, s?.effort, s?.permissionMode], [
    'C:\\work\\demo', 'demo', 'main', '2.1.309', 'claude-sonnet-5-5', 'max', 'acceptEdits',
  ]);
  const j = rows.find((r) => r.sessionId === job);
  assert.deepEqual([j?.job?.id, j?.job?.state, j?.job?.needs, j?.activity], ['j2', 'blocked', 'approve the plan', 'blocked: approve the plan']);
});

/**
 * A session of the desktop app: its transcript, its process, and the app's record of it.
 * @param {ReturnType<typeof makeConfig>} cfg
 * @param {number} pid
 * @param {string} local the app's ID for it
 * @param {Record<string, unknown>} app the record's fields
 * @param {string} [status]
 */
function desktopSession(cfg, pid, local, app, status = 'idle') {
  const id = sessionId();
  cfg.transcript(id, [rec.prompt(`Work on ${local}`, NOW - 30 * MINUTE), rec.reply('Done.', NOW - 2 * MINUTE)], { mtime: NOW - 2 * MINUTE });
  cfg.registry({ pid, sessionId: id, status, entrypoint: 'claude-desktop', hostSessionId: local, statusUpdatedAt: NOW - 2 * MINUTE });
  cfg.desktopSession({ sessionId: local, cliSessionId: id, title: local, ...app });
  return id;
}

test('a desktop app session is unread, as the app shows it, when its last turn ended while another one was open', async (t) => {
  const cfg = makeConfig(t);
  desktopSession(cfg, 1, 'local_left', { lastFocusedAt: NOW - 10 * MINUTE, lastTurnEdgeAt: NOW - 2 * MINUTE });
  desktopSession(cfg, 2, 'local_watched', { lastFocusedAt: NOW - 5 * MINUTE, lastTurnEdgeAt: NOW - 3 * MINUTE });
  desktopSession(cfg, 3, 'local_reopened', { lastFocusedAt: NOW - MINUTE, lastTurnEdgeAt: NOW - 4 * MINUTE });
  desktopSession(cfg, 4, 'local_unopened', { lastTurnEdgeAt: NOW - 6 * MINUTE });
  desktopSession(cfg, 5, 'local_older', { lastFocusedAt: NOW - 7 * MINUTE, lastActivityAt: NOW - 4 * MINUTE });
  desktopSession(cfg, 6, 'local_busy', { lastFocusedAt: NOW - 8 * MINUTE, lastTurnEdgeAt: NOW - 90_000 }, 'busy');
  desktopSession(cfg, 7, 'local_archived', { lastFocusedAt: NOW - 9 * MINUTE, lastTurnEdgeAt: NOW - 2 * MINUTE, isArchived: true });
  const running = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((pid) => [pid, 'claude.exe']));
  const rows = (await monitorOf(cfg, { running }).monitor.refresh(NOW)).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.hostSessionId, r.unread])), {
    local_left: true, // local_watched was opened before its turn ended
    local_watched: false, // nothing else was opened after it before its turn ended
    local_reopened: false, // opened after its turn ended
    local_unopened: true,
    local_older: true, // no turn edge on record: its last activity
    local_busy: false, // at work
    local_archived: false,
  });
  assert.equal(rows.find((r) => r.hostSessionId === 'local_left')?.openedAt, NOW - 10 * MINUTE);
});

test('the monitor remembers the openings it saw, which a record forgets when its session is opened again', async (t) => {
  const cfg = makeConfig(t);
  // x was opened, then y, and x's turn ended while y was open.
  const x = desktopSession(cfg, 1, 'local_x', { lastFocusedAt: NOW - 10 * MINUTE, lastTurnEdgeAt: NOW - 2 * MINUTE });
  const y = desktopSession(cfg, 2, 'local_y', { lastFocusedAt: NOW - 5 * MINUTE, lastTurnEdgeAt: NOW - 20 * MINUTE });
  const running = { 1: 'claude.exe', 2: 'claude.exe' };
  const { monitor } = monitorOf(cfg, { running });
  const unread = async (/** @type {Monitor} */ m, /** @type {number} */ at) => (await m.refresh(at)).rows.find((r) => r.sessionId === x)?.unread;
  assert.equal(await unread(monitor, NOW), true);
  cfg.desktopSession({ sessionId: 'local_y', cliSessionId: y, lastFocusedAt: NOW + MINUTE, lastTurnEdgeAt: NOW - 20 * MINUTE }, NOW + MINUTE);
  assert.equal(await unread(monitor, NOW + 2 * MINUTE), true);
  // One started now knows only each session's last opening: x looks as if it was open.
  assert.equal(await unread(monitorOf(cfg, { running }).monitor, NOW + 2 * MINUTE), false);
  cfg.desktopSession({ sessionId: 'local_x', cliSessionId: x, lastFocusedAt: NOW + 3 * MINUTE, lastTurnEdgeAt: NOW - 2 * MINUTE }, NOW + 3 * MINUTE);
  assert.equal(await unread(monitor, NOW + 4 * MINUTE), false);
});

test("the desktop app's summary of a session's last turn: what it came to, or what you are to do", async (t) => {
  const cfg = makeConfig(t);
  // The uuid of the reply desktopSession writes.
  const reply = `r${NOW - 2 * MINUTE}`;
  const summary = (/** @type {Record<string, unknown>} */ o) => ({
    postTurnSummary: { status_category: 'completed', status_detail: 'Topics set; homepage unchanged', needs_action: '', summarizes_uuid: reply, ...o },
  });
  const blocked = { status_category: 'blocked', status_detail: 'Stutter: picture or sound?', needs_action: 'say whether the stutter was picture or sound' };
  desktopSession(cfg, 1, 'local_done', summary({}));
  desktopSession(cfg, 2, 'local_blocked', summary(blocked));
  desktopSession(cfg, 3, 'local_stale', summary({ ...blocked, summarizes_uuid: 'r-an-older-reply' }));
  desktopSession(cfg, 4, 'local_busy', summary(blocked), 'busy');
  desktopSession(cfg, 5, 'local_ended', summary({ ...blocked, needs_action: 'open the \x1b[31mPR\x1b[0m' }));
  desktopSession(cfg, 6, 'local_for', { ...summary({ summarizes_uuid: undefined }), postTurnSummaryFor: reply });
  const running = Object.fromEntries([1, 2, 3, 4, 6].map((pid) => [pid, 'claude.exe']));
  const rows = (await monitorOf(cfg, { running }).monitor.refresh(NOW)).rows;
  const row = (/** @type {string} */ local) => rows.find((r) => r.hostSessionId === local);
  const seen = (/** @type {string} */ local) => {
    const r = row(local);
    return [r?.state, r?.activityKind, r?.activity, r?.blocked];
  };
  assert.deepEqual(seen('local_done'), ['idle', 'summary', 'Topics set; homepage unchanged', false]);
  assert.deepEqual(row('local_done')?.turn, { category: 'completed', detail: 'Topics set; homepage unchanged', needs: undefined });
  assert.deepEqual(seen('local_blocked'), ['idle', 'blocked', 'blocked: say whether the stutter was picture or sound', true]);
  assert.deepEqual(row('local_blocked')?.turn, { category: 'blocked', detail: 'Stutter: picture or sound?', needs: 'say whether the stutter was picture or sound' });
  assert.deepEqual(seen('local_stale'), ['idle', 'reply', 'Done.', undefined], 'a summary of an older reply is not used');
  assert.equal(row('local_stale')?.turn, undefined);
  assert.deepEqual(seen('local_busy'), ['working', 'thinking', 'thinking', undefined], 'nor one of a session at work');
  assert.deepEqual(seen('local_ended'), ['ended', 'blocked', 'blocked: open the PR', true]);
  assert.deepEqual(seen('local_for'), ['idle', 'summary', 'Topics set; homepage unchanged', false]);
});

test('the window can change between refreshes', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Old work', NOW - 3 * HOUR), rec.reply('Done.', NOW - 3 * HOUR + 1000)], { mtime: NOW - 3 * HOUR + 1000 });
  const { monitor } = monitorOf(cfg, { windowMs: HOUR });
  assert.deepEqual((await monitor.refresh(NOW)).rows, []);
  monitor.windowMs = 6 * HOUR;
  const snap = await monitor.refresh(NOW);
  assert.deepEqual(snap.rows.map((r) => [r.title, r.state]), [['Old work', 'ended']]);
  assert.equal(snap.windowMs, 6 * HOUR);
});

test('the process table is read for a new process, then only every few seconds', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Hello', NOW - MINUTE)], { mtime: NOW - MINUTE });
  cfg.registry({ pid: 80, sessionId: id, status: 'idle', statusUpdatedAt: NOW - MINUTE });
  const { monitor, calls } = monitorOf(cfg, { running: { 80: 'node' } });
  await monitor.refresh(NOW);
  await monitor.refresh(NOW + 1000);
  assert.equal(calls.table, 1);
  await monitor.refresh(NOW + 11_000);
  assert.equal(calls.table, 2);
});

test('an empty config folder', async (t) => {
  const cfg = makeConfig(t);
  const snap = await monitorOf(cfg).monitor.refresh(NOW);
  assert.equal(snap.found, false);
  assert.deepEqual(snap.rows, []);
  assert.equal(snap.dir, cfg.dir);
  assert.equal(snap.at, NOW);
});
