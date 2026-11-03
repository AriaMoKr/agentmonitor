import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promptText, TAIL_BYTES, Transcript } from '../src/transcript.js';
import { HOUR, iso, MINUTE, NOW, rec } from './helpers/fixture.js';

/** @param {import('node:test').TestContext} t */
function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentmonitor-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'session.jsonl');
}

/** @param {object[]} records */
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** @param {Transcript} tx */
const update = (tx) => tx.update(statSync(tx.path));

test('reads a session: model, context, prompt, reply, titles, totals', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.prompt('Build the monitor', NOW - 60_000),
    rec.customTitle('Agent monitor'),
    rec.aiTitle('Terminal monitor'),
    rec.agentName('monitor'),
    rec.reply('Here is the plan.', NOW - 50_000, { ctx: 45_000, out: 300 }),
    rec.cost(),
  ]));
  const tx = new Transcript(path);
  assert.equal(await update(tx), true);
  const i = tx.info;
  assert.equal(i.model, 'claude-opus-5-5');
  assert.equal(i.ctx, 45_000);
  assert.equal(i.outTokens, 300);
  assert.equal(i.lastPrompt?.text, 'Build the monitor');
  assert.equal(i.lastReply?.text, 'Here is the plan.');
  assert.equal(i.customTitle, 'Agent monitor');
  assert.equal(i.aiTitle, 'Terminal monitor');
  assert.equal(i.agentName, 'monitor');
  assert.equal(i.cwd, 'C:\\work\\demo');
  assert.equal(i.gitBranch, 'main');
  assert.equal(i.lastRole, 'assistant');
  assert.equal(i.lastStop, 'end_turn');
  assert.equal(i.firstTs, NOW - 60_000);
  assert.equal(i.lastTs, NOW - 50_000);
  assert.equal(i.prompts, 1);
  assert.deepEqual(i.cost, { usd: 1.5, input: 100, output: 2000, cacheRead: 30_000, cacheWrite: 4000, linesAdded: 10, linesRemoved: 2, apiMs: 1000, durationMs: 5000 });
  assert.deepEqual(tx.head, { firstTs: NOW - 60_000, firstPrompt: 'Build the monitor' });
  assert.deepEqual(i.events.map((e) => e.kind), ['prompt', 'reply']);
  assert.equal(await update(tx), false, 'an unchanged file is not read again');
});

test('tool calls stay pending until their result, and failures become events', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.prompt('test it', NOW - 10_000),
    rec.tool('toolu_1', 'Bash', { command: 'npm test', description: 'Run the tests' }, NOW - 9000),
    rec.tool('toolu_2', 'Read', { file_path: 'C:\\work\\demo\\a.js' }, NOW - 8000),
    rec.result('toolu_2', NOW - 7000, true),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual([...tx.info.pending.keys()], ['toolu_1']);
  assert.equal(tx.info.pending.get('toolu_1')?.summary, 'Bash: Run the tests');
  assert.equal(tx.info.pending.get('toolu_1')?.ts, NOW - 9000);
  assert.ok(tx.info.seenTools.has('toolu_2'));
  const failure = tx.info.events.find((e) => e.kind === 'error');
  assert.equal(failure?.text, 'Read: a.js failed: Exit code 1 / boom');

  appendFileSync(path, jsonl([rec.result('toolu_1', NOW - 1000)]));
  await update(tx);
  assert.equal(tx.info.pending.size, 0);
});

test('the latest tool calls, each from its call to its result: the file an edit changes, whether it failed, whether it waits on you', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.prompt('fix it', NOW - 10_000),
    rec.tool('toolu_1', 'Edit', { file_path: 'C:\\work\\demo\\a.js', old_string: 'a', new_string: 'b' }, NOW - 9000),
    rec.result('toolu_1', NOW - 8500),
    rec.tool('toolu_2', 'Bash', { command: 'npm test', description: 'Run the tests' }, NOW - 8000),
    rec.result('toolu_2', NOW - 6000, true),
    rec.tool('toolu_3', 'AskUserQuestion', { questions: [{ question: 'Which one?', header: 'Pick' }] }, NOW - 5000),
    rec.tool('toolu_4', 'mcp__ccd_session__start_session', { initiation: 'offer', title: 'Docs' }, NOW - 4000),
    rec.tool('toolu_5', 'mcp__ccd_session__start_session', { initiation: 'own_initiative', title: 'Tests' }, NOW - 3000),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual(tx.info.calls.map(({ id, name, ts, end, error, file, asks }) => ({ id, name, ts, end, error, file, asks })), [
    { id: 'toolu_1', name: 'Edit', ts: NOW - 9000, end: NOW - 8500, error: false, file: 'C:\\work\\demo\\a.js', asks: undefined },
    { id: 'toolu_2', name: 'Bash', ts: NOW - 8000, end: NOW - 6000, error: true, file: undefined, asks: undefined },
    { id: 'toolu_3', name: 'AskUserQuestion', ts: NOW - 5000, end: 0, error: false, file: undefined, asks: true },
    { id: 'toolu_4', name: 'mcp__ccd_session__start_session', ts: NOW - 4000, end: 0, error: false, file: undefined, asks: true },
    { id: 'toolu_5', name: 'mcp__ccd_session__start_session', ts: NOW - 3000, end: 0, error: false, file: undefined, asks: undefined },
  ]);
  assert.equal(tx.info.calls[1].summary, 'Bash: Run the tests');
  appendFileSync(path, jsonl([rec.result('toolu_3', NOW - 1000)]));
  await update(tx);
  assert.equal(tx.info.calls[2].end, NOW - 1000);
});

test("the turns: from a prompt to the reply that ends it; a background task's end begins one, an interruption or an API error ends one", async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    // The part read begins in a turn: its first reply begins it.
    rec.tool('toolu_0', 'Read', { file_path: 'C:\\work\\demo\\a.js' }, NOW - 90_000),
    rec.result('toolu_0', NOW - 89_000),
    rec.reply('Read it.', NOW - 88_000),
    rec.prompt('go on', NOW - 60_000),
    rec.tool('toolu_1', 'Bash', { command: 'ls' }, NOW - 55_000),
    rec.result('toolu_1', NOW - 54_000),
    rec.reply('Done.', NOW - 50_000, { id: 'msg_end' }),
    // A later block of the reply that ended the turn: it ends later.
    rec.reply('And more.', NOW - 49_000, { id: 'msg_end' }),
    // A compaction's summary is no prompt.
    { ...rec.prompt('This session is being continued from a previous conversation.', NOW - 45_000), isCompactSummary: true },
    rec.taskEnd('toolu_x', 'bx1', 'completed', NOW - 40_000),
    rec.reply('The build passed.', NOW - 38_000),
    rec.prompt('next', NOW - 30_000),
    rec.prompt('[Request interrupted by user]', NOW - 28_000),
    rec.prompt('again', NOW - 20_000),
    rec.apiError('Overloaded', NOW - 19_000),
    rec.prompt('once more', NOW - 10_000),
    rec.tool('toolu_2', 'Bash', { command: 'npm test' }, NOW - 9000),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual(tx.info.turns, [
    { start: NOW - 90_000, end: NOW - 88_000 },
    { start: NOW - 60_000, end: NOW - 49_000 },
    { start: NOW - 40_000, end: NOW - 38_000 },
    { start: NOW - 30_000, end: NOW - 28_000 },
    { start: NOW - 20_000, end: NOW - 19_000 },
    { start: NOW - 10_000, end: 0 },
  ]);
  assert.equal(tx.info.prompts, 4, 'not the summary, the task\'s end or the interruption');
});

test('a failed tool call says why, without the tags around it', async (t) => {
  const path = tempFile(t);
  const failed = rec.result('toolu_1', NOW - 1000, true);
  failed.message.content[0].content = '<tool_use_error>Error: No such tool available: Bash</tool_use_error>';
  writeFileSync(path, jsonl([rec.tool('toolu_1', 'Bash', { command: 'ls', description: 'List the files' }, NOW - 2000), failed]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.events.at(-1)?.text, 'Bash: List the files failed: Error: No such tool available: Bash');
});

test('output tokens of one message, written block by block, count once', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.tool('toolu_a', 'Bash', { command: 'ls' }, NOW - 3000, { id: 'msg_same', out: 40 }),
    rec.tool('toolu_b', 'Bash', { command: 'pwd' }, NOW - 2900, { id: 'msg_same', out: 90 }),
    rec.reply('done', NOW - 1000, { id: 'msg_next', out: 10 }),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.outTokens, 100);
});

test("the prompt cache: when the last reply was asked for, before it thought, and how long the cache keeps what it wrote; nothing after a compaction", async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.prompt('go on', NOW - 20 * MINUTE), rec.reply('first', NOW - 19 * MINUTE, { ttl: '5m' })]));
  const tx = new Transcript(path);
  await update(tx);
  const cache = () => [tx.info.cacheAt, tx.info.cacheTtl];
  assert.deepEqual(cache(), [NOW - 19 * MINUTE, 5 * MINUTE]);
  // Asked for before it thought, as its first record says; its later records change nothing.
  appendFileSync(path, jsonl([
    rec.reply('thought', NOW - 10 * MINUTE, { id: 'msg_b', ttl: '1h', think: 30_000 }),
    rec.reply('and said', NOW - 9 * MINUTE, { id: 'msg_b', ttl: '1h' }),
  ]));
  await update(tx);
  assert.deepEqual(cache(), [NOW - 10 * MINUTE - 30_000, HOUR]);
  // A reply that does not say for how long keeps that; an API error is no reply.
  appendFileSync(path, jsonl([rec.reply('read it all', NOW - 5 * MINUTE, { id: 'msg_c' }), rec.apiError('Overloaded', NOW - 4 * MINUTE)]));
  await update(tx);
  assert.deepEqual(cache(), [NOW - 5 * MINUTE, HOUR]);
  appendFileSync(path, jsonl([{ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: iso(NOW - 2 * MINUTE) }]));
  await update(tx);
  assert.deepEqual(cache(), [0, HOUR], 'what was cached is not the conversation any more');
});

test('reads what was appended, and waits for a line to be finished', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.prompt('first', NOW - 5000)]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.prompts, 1);

  const line = JSON.stringify(rec.reply('a reply in two writes', NOW - 4000));
  appendFileSync(path, line.slice(0, 40));
  await update(tx);
  assert.equal(tx.info.lastReply, undefined, 'half a line is not read');
  appendFileSync(path, line.slice(40) + '\n');
  await update(tx);
  assert.equal(tx.info.lastReply?.text, 'a reply in two writes');
  assert.equal(tx.start, 0);
});

test('a long transcript is read from its tail, and its head gives the first prompt', async (t) => {
  const path = tempFile(t);
  const filler = 'x'.repeat(10_000);
  const records = [rec.prompt('the very first prompt', NOW - 3_600_000)];
  for (let k = 0; k < 150; k++) records.push(rec.reply(`${k} ${filler}`, NOW - 3_000_000 + k));
  records.push(rec.prompt('the latest prompt', NOW - 2000), rec.reply('the latest reply', NOW - 1000));
  writeFileSync(path, jsonl(records));
  assert.ok(statSync(path).size > TAIL_BYTES);
  const tx = new Transcript(path);
  await update(tx);
  assert.ok(tx.start > 0, 'only the tail was read');
  assert.equal(tx.info.lastPrompt?.text, 'the latest prompt');
  assert.equal(tx.info.lastReply?.text, 'the latest reply');
  assert.equal(tx.head?.firstPrompt, 'the very first prompt');
  assert.equal(tx.head?.firstTs, NOW - 3_600_000);
  assert.ok(tx.info.events.every((e) => !e.text.startsWith('0 ')), 'the first replies were not read');
});

test('a tail without a whole message is widened until it has one', async (t) => {
  const path = tempFile(t);
  const huge = 'y'.repeat(TAIL_BYTES + 200_000);
  writeFileSync(path, jsonl([rec.prompt('before', NOW - 9000), rec.reply(huge, NOW - 5000)]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.messages, 2);
  assert.equal(tx.info.lastReply?.text.length, 400);
});

test("the effort: the turn's, else the session's, as of the last assistant record that has one", async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.prompt('think hard', NOW - 60_000), rec.reply('On it.', NOW - 50_000, { effort: 'xhigh' })]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.effort, 'xhigh');
  appendFileSync(path, jsonl([rec.reply('Harder.', NOW - 40_000, { effort: 'max', perTurnEffort: null })]));
  await update(tx);
  assert.equal(tx.info.effort, 'max', 'no effort of the turn: the session\'s');
  appendFileSync(path, jsonl([rec.reply('This turn only.', NOW - 30_000, { effort: 'high', perTurnEffort: 'max' })]));
  await update(tx);
  assert.equal(tx.info.effort, 'max', "the turn's first");
  appendFileSync(path, jsonl([rec.apiError('Rate limited.', NOW - 20_000), rec.reply('Back.', NOW - 10_000, { effort: 'low' })]));
  await update(tx);
  assert.equal(tx.info.effort, 'low', 'a record without one changes nothing');
});

test('ultracode: on once a reminder of it is read, which comes after some prompts only', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.prompt('plan it', NOW - 60_000), rec.reply('Planned.', NOW - 50_000)]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.ultracode, false);
  appendFileSync(path, jsonl([rec.prompt('build it', NOW - 40_000), rec.ultra(NOW - 40_000, 'sparse'), rec.reply('Built.', NOW - 30_000)]));
  await update(tx);
  assert.equal(tx.info.ultracode, true);
  appendFileSync(path, jsonl([rec.prompt('test it', NOW - 20_000), rec.reply('Tested.', NOW - 10_000)]));
  await update(tx);
  assert.equal(tx.info.ultracode, true, 'a prompt without one changes nothing');
});

test('commands in the background: on until the message about their end, or until stopped', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.prompt('build and serve it', NOW - 60_000),
    rec.tool('toolu_b', 'Bash', { command: 'npm run build', description: 'Build', run_in_background: true }, NOW - 50_000),
    rec.result('toolu_b', NOW - 49_000, false, 'Command running in background with ID: b1. Output is being written to: C:\\tmp\\b1.output'),
    rec.tool('toolu_s', 'PowerShell', { command: 'npm run serve', description: 'Serve' }, NOW - 40_000),
    rec.result('toolu_s', NOW - 30_000, false, 'Command did not complete within its 120s timeout and was moved to the background (ID: b2). Output is being written to: C:\\tmp\\b2.output.'),
    // Output that tells of a background command is not one.
    rec.tool('toolu_g', 'Bash', { command: 'grep -r background logs', description: 'Search the logs' }, NOW - 20_000),
    rec.result('toolu_g', NOW - 19_000, false, 'logs/a.txt: Command running in background with ID: b9'),
    rec.reply('Both run.', NOW - 18_000),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual([...tx.info.commands], [
    ['toolu_b', { summary: 'Bash: Build', ts: NOW - 50_000, taskId: 'b1' }],
    ['toolu_s', { summary: 'PowerShell: Serve', ts: NOW - 40_000, taskId: 'b2' }],
  ]);

  appendFileSync(path, jsonl([rec.taskEnd('toolu_b', 'b1', 'completed', NOW - 10_000)]));
  await update(tx);
  assert.deepEqual([...tx.info.commands.keys()], ['toolu_s']);
  assert.equal(tx.info.events.at(-1)?.text, 'Bash: Build: completed in the background');
  assert.equal(tx.info.prompts, 1, 'the message about it is no prompt');

  appendFileSync(path, jsonl([
    rec.tool('toolu_k', 'TaskStop', { task_id: 'b2' }, NOW - 5000),
    rec.result('toolu_k', NOW - 4900, false, '{"message":"Successfully stopped task: b2 (npm run serve)","task_id":"b2"}'),
  ]));
  await update(tx);
  assert.equal(tx.info.commands.size, 0);
});

test('a background command ends by a message taken in while a turn goes on', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([
    rec.tool('toolu_b', 'Bash', { command: 'npm test', description: 'Run the tests', run_in_background: true }, NOW - 50_000),
    rec.result('toolu_b', NOW - 49_000, false, 'Command running in background with ID: b1.'),
    rec.tool('toolu_r', 'Read', { file_path: 'C:\\work\\demo\\a.js' }, NOW - 20_000),
    rec.taskEnd('toolu_b', 'b1', 'failed', NOW - 15_000, true),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.commands.size, 0);
  assert.equal(tx.info.events.at(-1)?.text, 'Bash: Run the tests: failed in the background');
});

test("a task list: the desktop app's, step by step and checked off at the end, and TodoWrite's", async (t) => {
  const path = tempFile(t);
  const plan = (/** @type {string} */ id, /** @type {object} */ input, /** @type {number} */ at, ok = true) => [
    rec.tool(id, 'mcp__ccd_turn__update_plan', input, at),
    rec.result(id, at + 100, !ok, ok ? 'Plan updated.' : 'items also needs "scope"'),
  ];
  const items = [{ content: 'Read the code', status: 'in_progress' }, { content: 'Fix it', status: 'pending' }, { content: 'Test it', status: 'pending' }];
  writeFileSync(path, jsonl([rec.prompt('fix it', NOW - 60_000), ...plan('p1', { items, scope: 'first_task' }, NOW - 50_000)]));
  const tx = new Transcript(path);
  await update(tx);
  const statuses = () => tx.info.plan?.steps.map((s) => s.status);
  assert.deepEqual(tx.info.plan, { steps: [
    { text: 'Read the code', status: 'in_progress' }, { text: 'Fix it', status: 'pending' }, { text: 'Test it', status: 'pending' },
  ], ts: NOW - 49_900 });

  appendFileSync(path, jsonl(plan('p2', { advance: true }, NOW - 40_000)));
  await update(tx);
  assert.deepEqual(statuses(), ['completed', 'in_progress', 'pending']);

  appendFileSync(path, jsonl(plan('p3', { done: [2], start: 3 }, NOW - 30_000)));
  await update(tx);
  assert.deepEqual(statuses(), ['completed', 'completed', 'in_progress']);

  appendFileSync(path, jsonl(plan('p4', { items: [{ content: 'x', status: 'completed' }] }, NOW - 25_000, false)));
  await update(tx);
  assert.deepEqual(statuses(), ['completed', 'completed', 'in_progress'], 'a call that failed changes nothing');

  appendFileSync(path, jsonl([rec.tool('w1', 'mcp__ccd_turn__wrap_up', { recap: 'Fixed.' }, NOW - 20_000), rec.result('w1', NOW - 19_900, false, 'Shown in the next-step box.')]));
  await update(tx);
  assert.deepEqual(statuses(), ['completed', 'completed', 'completed']);
  assert.equal(tx.info.plan?.ts, NOW - 19_900);
  appendFileSync(path, jsonl([rec.prompt('and now?', NOW - 15_000), rec.tool('w2', 'mcp__ccd_turn__wrap_up', { recap: 'Nothing.' }, NOW - 14_000), rec.result('w2', NOW - 13_900, false, 'Shown.')]));
  await update(tx);
  assert.equal(tx.info.plan?.ts, NOW - 19_900, 'a list with no step in progress: still of the turn before');

  appendFileSync(path, jsonl([
    rec.tool('t1', 'TodoWrite', { todos: [{ content: 'Write \x1b[31mit', status: 'completed', activeForm: 'Writing it' }, { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' }, { content: 'Tell', status: 'bogus' }] }, NOW - 10_000),
    rec.result('t1', NOW - 9900, false, 'Todos have been modified successfully.'),
  ]));
  await update(tx);
  assert.deepEqual(tx.info.plan?.steps, [{ text: 'Write it', status: 'completed' }, { text: 'Ship it', status: 'in_progress' }, { text: 'Tell', status: 'pending' }]);
});

test("what a turn's wrap_up asks you as it ends, in the desktop app's next-step box, till another turn begins", async (t) => {
  const path = tempFile(t);
  const wrap = (/** @type {string} */ id, /** @type {object} */ input, /** @type {number} */ at, ok = true) => [
    rec.tool(id, 'mcp__ccd_turn__wrap_up', input, at),
    rec.result(id, at + 100, !ok, ok ? 'Shown in the next-step box.' : 'wrap_up was already called this turn.'),
  ];
  const actions = [{ label: 'Take out the \x1b[1m15' }, { label: 'Take out 20 instead' }];
  writeFileSync(path, jsonl([
    rec.prompt('Check the picks', NOW - 60_000),
    ...wrap('w1', { recap: 'The 15 were never published.', ask: 'Take out the 15?', actions }, NOW - 50_000),
    ...wrap('w2', { recap: 'Nothing.' }, NOW - 49_000, false),
    rec.reply('They should come out.', NOW - 48_000),
  ]));
  const tx = new Transcript(path);
  await update(tx);
  // A second call that failed changes nothing.
  assert.deepEqual(tx.info.nextStep, { text: 'Take out the 15?', answers: ['Take out the 15', 'Take out 20 instead'], ts: NOW - 49_900 });

  // Answered: a turn begins, and asks nothing as it ends.
  appendFileSync(path, jsonl([rec.prompt('Take out the 15', NOW - 40_000)]));
  await update(tx);
  assert.equal(tx.info.nextStep, undefined);
  appendFileSync(path, jsonl([...wrap('w3', { recap: 'Taken out.' }, NOW - 35_000), rec.reply('Done.', NOW - 34_000)]));
  await update(tx);
  assert.equal(tx.info.nextStep, undefined, 'a box that asks nothing');

  // Blocked with no question: its recap, and an app action's answer by its name where it has no label.
  appendFileSync(path, jsonl([
    rec.prompt('Open a PR', NOW - 30_000),
    ...wrap('w4', { recap: 'The PR waits on your sign-off.', blocked: true, actions: [{ action: 'create_pr' }, { label: '', action: 'commit' }, 'junk'] }, NOW - 25_000),
    rec.reply('Sign it off.', NOW - 24_000),
  ]));
  await update(tx);
  assert.deepEqual(tx.info.nextStep, { text: 'The PR waits on your sign-off.', answers: ['create pr', 'commit'], ts: NOW - 24_900 });

  // A background task's end begins a turn too.
  appendFileSync(path, jsonl([rec.taskEnd('toolu_x', 'bx', 'completed', NOW - 20_000)]));
  await update(tx);
  assert.equal(tx.info.nextStep, undefined);
});

test('a task list made before the tail: the tail widens to take it in', async (t) => {
  const path = tempFile(t);
  const filler = 'x'.repeat(10_000);
  const records = [
    rec.prompt('a long job', NOW - 3_600_000),
    rec.tool('p1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }], scope: 'first_task' }, NOW - 3_500_000),
    rec.result('p1', NOW - 3_499_000, false, 'Plan shown (2 steps).'),
  ];
  for (let k = 0; k < 150; k++) records.push(rec.reply(`${k} ${filler}`, NOW - 3_000_000 + k));
  records.push(rec.tool('p2', 'mcp__ccd_turn__update_plan', { advance: true }, NOW - 2000), rec.result('p2', NOW - 1900, false, 'Plan updated: step 2 of 2 is in progress.'));
  writeFileSync(path, jsonl(records));
  assert.ok(statSync(path).size > TAIL_BYTES);
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual(tx.info.plan?.steps.map((s) => s.status), ['completed', 'in_progress']);
  assert.equal(tx.info.planMissed, false);
});

test('a transcript that shrank is read again from scratch', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.prompt('one', NOW - 5000), rec.prompt('two', NOW - 4000)]));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.prompts, 2);
  writeFileSync(path, jsonl([rec.prompt('three', NOW - 1000)]));
  await update(tx);
  assert.equal(tx.info.prompts, 1);
  assert.equal(tx.info.lastPrompt?.text, 'three');
});

test('API errors, interruptions and lines that are not JSON', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, [
    JSON.stringify(rec.prompt('go', NOW - 4000)),
    '{"type":"user", broken',
    JSON.stringify(rec.prompt('[Request interrupted by user]', NOW - 3500)),
    JSON.stringify(rec.apiError("You've hit your session limit · resets 10:40pm", NOW - 3000)),
    '',
  ].join('\n'));
  const tx = new Transcript(path);
  await update(tx);
  assert.equal(tx.info.apiError?.text, "You've hit your session limit · resets 10:40pm");
  assert.equal(tx.info.model, undefined, '<synthetic> is no model');
  assert.equal(tx.info.prompts, 1);
  assert.deepEqual(tx.info.events.map((e) => e.kind), ['prompt', 'info', 'error']);
});

test('a last-prompt record stands in for a prompt that was not read', async (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonl([rec.lastPrompt('continue'), rec.reply('ok', NOW)]));
  const tx = new Transcript(path);
  await update(tx);
  assert.deepEqual(tx.info.lastPrompt, { text: 'continue', ts: 0 });
});

test('promptText: what the person typed', () => {
  assert.equal(promptText('plain words'), 'plain words');
  assert.equal(promptText('<command-name>/review</command-name><command-args>42</command-args>'), '/review 42');
  assert.equal(promptText('<command-message>x</command-message><command-name>/clear</command-name><command-args></command-args>'), '/clear');
  assert.equal(promptText('<bash-input>ls -la</bash-input>'), '! ls -la');
  assert.equal(promptText('<local-command-stdout>output</local-command-stdout>'), '');
  assert.equal(promptText('<task-notification>done</task-notification>'), '');
  assert.equal(promptText('<system-reminder>ignore me</system-reminder>real text'), 'real text');
  assert.equal(promptText(42), '');
});
