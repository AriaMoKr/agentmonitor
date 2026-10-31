import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger, weightOf } from '../src/ledger.js';
import { HOUR, iso, makeConfig, MINUTE, NOW, rec, sessionId } from './helpers/fixture.js';

/**
 * A reply's record, as Claude Code writes one for each content block of a message: with the
 * message's usage so far.
 * @param {string} id the message's
 * @param {number} at
 * @param {Record<string, number>} usage
 * @param {{ model?: string, thinking?: number }} [o] thinking: how long it thought (a thinking block's)
 */
const block = (id, at, usage, { model = 'claude-opus-5-5', thinking } = {}) => ({
  parentUuid: 'x', isSidechain: false, type: 'assistant', uuid: `b${at}`, timestamp: iso(at),
  ...(thinking ? { thinkingDurationMs: thinking } : {}),
  message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage },
});

/** The replies, their times as minutes before NOW and their use to a thousandth. @param {import('../src/ledger.js').Replies | undefined} r */
const brief = (r) => r?.replies.map((x) => ({ t: (NOW - x.t) / MINUTE, asked: (NOW - x.asked) / MINUTE, x: Math.round(x.x * 1000) / 1000 }));

test('what a model\'s tokens weigh against Claude Opus 5.5\'s, as the API prices their output; nothing for a model that is not Claude', () => {
  const weights = Object.fromEntries(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-next-1', '<synthetic>', 'qwen3-coder'].map((m) => [m, weightOf(m)]));
  assert.deepEqual(weights, {
    'claude-opus-5-5': 1, 'claude-opus-5': 1.25, 'claude-opus-4-8': 1.25, 'claude-fable-5-1': 2.5, 'claude-mythos-5-1': 2.5, 'claude-sonnet-5-5': 0.5,
    'claude-sonnet-4-6': 0.75, 'claude-haiku-5-5': 0.025, 'claude-haiku-4-5': 0.25, 'claude-next-1': 1, '<synthetic>': 0, 'qwen3-coder': 0,
  });
});

test('each reply once, in every transcript, at its first record\'s time, asked for before it thought, its tokens weighed', async (t) => {
  const cfg = makeConfig(t);
  const id = sessionId();
  const records = [
    rec.prompt('Fix the parser', NOW - 31 * MINUTE),
    // A message with a thinking block and a text block: the usage so far in each.
    block('m1', NOW - 29 * MINUTE, { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000 }, { thinking: 60_000 }),
    block('m1', NOW - 28 * MINUTE, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000 }),
    block('m2', NOW - 20 * MINUTE, { output_tokens: 1000 }, { model: 'claude-haiku-5-5' }),
    block('m3', NOW - 10 * MINUTE, { output_tokens: 1000 }, { model: 'qwen3-coder' }),
    rec.apiError('You have hit your limit', NOW - 5 * MINUTE),
  ];
  cfg.transcript(id, records);
  // A fork of it holds the same messages: counted once.
  cfg.transcript(sessionId(), records, { project: 'C--work-other' });
  cfg.subagent(id, 'a1', { agentType: 'Explore' }, [block('m4', NOW - 15 * MINUTE, { output_tokens: 200 })]);
  cfg.workflow(id, 'wf1', { agents: [{ id: 'w1', label: 'Review', phase: 'Review', state: 'done', records: [block('m5', NOW - 12 * MINUTE, { output_tokens: 300 }, { model: 'claude-fable-5-1' })] }] });
  const ledger = new Ledger(join(cfg.dir, 'projects'));
  const read = await ledger.read(NOW, NOW - HOUR, { wait: true });
  assert.equal(read?.from, NOW - HOUR);
  assert.deepEqual(brief(read), [
    // Output 500, input 1000 at 0.2, cache reads 100k at 0.0055 and writes 2000 at 0.29.
    { t: 29, asked: 30, x: 500 + 200 + 550 + 580 },
    { t: 20, asked: 20, x: 25 },
    { t: 15, asked: 15, x: 200 },
    { t: 12, asked: 12, x: 750 },
  ]);
});

test('read in the background unless waited for, at most every 10 seconds, then only what the transcripts grow by', async (t) => {
  const cfg = makeConfig(t);
  const path = cfg.transcript(sessionId(), [block('m1', NOW - 20 * MINUTE, { output_tokens: 100 })]);
  const ledger = new Ledger(join(cfg.dir, 'projects'));
  assert.equal(await ledger.read(NOW, NOW - HOUR), undefined, 'not read yet');
  await ledger.reading;
  assert.deepEqual(brief(await ledger.read(NOW + 1000, NOW - HOUR)), [{ t: 20, asked: 20, x: 100 }]);
  // A line written in two parts is taken once it is whole.
  const line = JSON.stringify(block('m2', NOW - 5 * MINUTE, { output_tokens: 40 }));
  appendFileSync(path, line.slice(0, 50));
  assert.equal((await ledger.read(NOW + 2000, NOW - HOUR, { wait: true }))?.replies.length, 1, 'not again within 10 seconds');
  assert.equal((await ledger.read(NOW + 11_000, NOW - HOUR, { wait: true }))?.replies.length, 1, 'half a line');
  appendFileSync(path, `${line.slice(50)}\n`);
  assert.deepEqual(brief(await ledger.read(NOW + 21_000, NOW - HOUR, { wait: true })), [{ t: 20, asked: 20, x: 100 }, { t: 5, asked: 5, x: 40 }]);
});

test('from about the time asked for: a long transcript from near its first record since, one written before not at all', async (t) => {
  const cfg = makeConfig(t);
  const filler = (/** @type {number} */ at) => rec.prompt('x'.repeat(300_000), at);
  const records = [filler(NOW - 10 * HOUR)];
  // Out of place, so as to show whether the start of the file is read.
  records.push(block('early', NOW - MINUTE, { output_tokens: 1 }));
  for (let h = 9; h >= 3; h--) records.push(filler(NOW - h * HOUR));
  records.push(block('old', NOW - 150 * MINUTE, { output_tokens: 10 }), filler(NOW - 2 * HOUR), block('late', NOW - 90 * MINUTE, { output_tokens: 20 }), filler(NOW - HOUR));
  cfg.transcript(sessionId(), records, { mtime: NOW - HOUR });
  cfg.transcript(sessionId(), [block('stale', NOW - MINUTE, { output_tokens: 30 })], { mtime: NOW - 5 * HOUR });
  const ledger = new Ledger(join(cfg.dir, 'projects'));
  assert.deepEqual(brief(await ledger.read(NOW, NOW - 165 * MINUTE, { wait: true })), [{ t: 150, asked: 150, x: 10 }, { t: 90, asked: 90, x: 20 }]);
});

test('asked for further back than read, all of it again; for later, the older replies are let go', async (t) => {
  const cfg = makeConfig(t);
  cfg.transcript(sessionId(), [
    block('a', NOW - 4 * HOUR, { output_tokens: 1 }),
    block('b', NOW - 2 * HOUR, { output_tokens: 2 }),
    block('c', NOW - 20 * MINUTE, { output_tokens: 3 }),
  ]);
  const ledger = new Ledger(join(cfg.dir, 'projects'));
  /** The replies' use, and the time they are known from. @param {number} at @param {number} since */
  const read = async (at, since) => {
    const r = await ledger.read(at, since, { wait: true });
    return { from: r && (NOW - r.from) / MINUTE, x: r?.replies.map((x) => x.x) };
  };
  assert.deepEqual(await read(NOW, NOW - HOUR), { from: 60, x: [3] });
  assert.deepEqual(await read(NOW + 10_000, NOW - 3 * HOUR), { from: 180, x: [2, 3] });
  assert.deepEqual(await read(NOW + 20_000, NOW - 30 * MINUTE), { from: 30, x: [3] });
  assert.deepEqual(await read(NOW + 30_000, NOW - 50 * MINUTE), { from: 30, x: [3] }, 'less than an hour further back: as read');
});
