import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promptText, TAIL_BYTES, Transcript } from '../src/transcript.js';
import { NOW, rec } from './helpers/fixture.js';

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
