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
    rec.tool('toolu_x', 'Grep', { pattern: 'parse', path: 'C:\\work\\demo\\src' }, NOW - 20_000),
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
  monitor.focus = `a:${id}:x1`;
  const focused = await child();
  assert.equal(focused.state, 'done');
  assert.equal(focused.activity, 'Nothing odd.');
  assert.deepEqual(focused.events.map((e) => e.kind), ['prompt', 'reply']);
  assert.equal(focused.model, 'claude-opus-5-5');
  monitor.focus = undefined;
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
        records: [rec.prompt('find bugs', NOW - 18 * MINUTE), rec.tool('toolu_r1', 'Read', { file_path: 'C:\\work\\demo\\src\\a.js' }, NOW - 10_000)],
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
  assert.deepEqual(run.children.map((a) => [a.key, a.title, a.state, a.activity]), [
    [`a:${id}:w1`, 'review:bugs', 'running', 'Read: src\\a.js'],
    [`a:${id}:w2`, 'review:perf', 'done', ''],
  ]);
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
