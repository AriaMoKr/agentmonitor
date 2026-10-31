// What Claude Code's replies used, from the transcripts under <config>/projects: the sessions',
// their subagents' and their workflows' agents'. Each reply once, though it is written as a
// record for each of its content blocks, each with the usage so far: when it was written, about
// when it was asked for, and its tokens weighed as the plan's usage limits are taken to count
// them. Read back to a time asked for, and after that only what the transcripts grow by, so that
// src/usage.js can carry the desktop app's samples of the plan's usage on to now.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { entries, readRange, statOf } from './files.js';

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const AGENT_FILE = /^agent-[\w-]+\.jsonl$/;
/** How much of a transcript is read at a time. */
const CHUNK = 4 << 20;
/** How much a look for the time of the lines at a place reads first, and at most. */
const PROBE = 64 << 10;
const MAX_PROBE = 1 << 20;
/** How far before its first record written since the time asked for a transcript is read from. */
const NEAR = 1 << 20;
/** A time asked for further back than the last by this much is read again from the start (ms). */
const SLACK = 60 * 60_000;
/** A thinking time longer than this is not taken for one (ms). */
const MAX_THINKING = 60 * 60_000;
/** What a reply's record holds, unescaped: a line without it is not parsed. */
const REPLY = Buffer.from('"assistant"');
/** Records that begin with their type, but a reply's: never parsed (some are megabytes). */
const OTHER = /^\{"type":"(?!assistant")/;
const TIME = /"timestamp":"([^"]{10,40})"/;

/**
 * What a token of each kind weighs against an output token: input as the API prices it, cache
 * reads and writes as the desktop app's samples of the usage rose with them (reads at about half
 * of what they are priced at, writes about at it).
 */
const KINDS = { input: 0.2, cacheRead: 0.0055, cacheWrite: 0.29 };

/**
 * What a model's tokens weigh against Claude Opus 5.5's, as the API prices their output: the
 * first here that begins the model's name. Another Claude model weighs 1, and any other (one
 * served through a proxy) nothing: it uses none of the plan.
 * @type {[string, number][]}
 */
const MODELS = [
  ['claude-fable', 2.5],
  ['claude-mythos', 2.5],
  ['claude-opus-5-5', 1],
  ['claude-opus', 1.25],
  ['claude-sonnet-5', 0.5],
  ['claude-sonnet', 0.75],
  ['claude-haiku-5', 0.025],
  ['claude-haiku', 0.25],
];

/**
 * @typedef {object} Reply
 * @property {number} t when it was written: the time of its first record (ms)
 * @property {number} asked about when it was asked for: that, less the time it thought
 * @property {number} x its tokens, weighed: as many output tokens of Claude Opus 5.5
 *
 * @typedef {object} Replies the replies read
 * @property {number} from the time back to which all of them are known
 * @property {Reply[]} replies in the order written
 *
 * @typedef {{ t: number, asked: number, weight: number, input: number, output: number, cacheRead: number, cacheWrite: number }} Message
 * @typedef {{ size: number, mtimeMs: number, offset: number, carry: Buffer | null, partial: boolean }} Place
 *   how far a transcript was read: the next byte, and the start of a line not finished yet
 */

export class Ledger {
  /** @param {string} root the transcripts' folder: <config>/projects */
  constructor(root) {
    this.root = root;
    /** @type {Map<string, Place>} */
    this.places = new Map();
    /** @type {Map<string, Message>} the replies read, by message ID */
    this.messages = new Map();
    /** the time the transcripts are read back to */
    this.since = Infinity;
    /** the time back to which a read that finished found all the replies; Infinity before one */
    this.from = Infinity;
    this.readAt = -Infinity;
    /** @type {Promise<void> | null} the read going on */
    this.reading = null;
    /** @type {Reply[]} */
    this.list = [];
    this.changed = false;
  }

  /**
   * The replies written since `since`, as far as known: the transcripts are read again at most
   * every `maxAgeMs`, in the background unless `wait`. Undefined until a first read has finished.
   * @param {number} now
   * @param {number} since
   * @param {{ maxAgeMs?: number, wait?: boolean }} [o]
   * @returns {Promise<Replies | undefined>}
   */
  async read(now, since, { maxAgeMs = 10_000, wait = false } = {}) {
    if (!this.reading && now - this.readAt >= maxAgeMs) {
      this.readAt = now;
      this.reading = this.update(since).catch(() => {}).finally(() => {
        this.reading = null;
      });
    }
    if (wait && this.reading) await this.reading;
    if (this.from === Infinity) return undefined;
    if (this.changed) {
      this.changed = false;
      this.list = [...this.messages.values()].map(replyOf).sort((a, b) => a.t - b.t);
    }
    return { from: this.from, replies: this.list };
  }

  /**
   * Reads what the transcripts written since `since` have that was not read, and forgets the
   * replies before it: all of them again when `since` is further back than they were read.
   * @param {number} since
   */
  async update(since) {
    if (this.since !== Infinity && since < this.since - SLACK) {
      this.places.clear();
      this.messages.clear();
      this.since = Infinity;
      this.from = Infinity;
      this.changed = true;
    }
    if (this.since === Infinity || since > this.since) this.since = since;
    const found = await transcripts(this.root, this.since);
    for (const { path, st } of found) {
      try {
        await this.readFile(path, st);
      } catch {
        // Removed or locked meanwhile: what was read stands.
      }
    }
    const paths = new Set(found.map((f) => f.path));
    for (const path of this.places.keys()) if (!paths.has(path)) this.places.delete(path);
    for (const [id, m] of this.messages) {
      if (m.t < this.since) {
        this.messages.delete(id);
        this.changed = true;
      }
    }
    this.from = this.since;
  }

  /**
   * Reads what a transcript has that was not read: on first sight from about its first record
   * written since `this.since`, then what was appended.
   * @param {string} path
   * @param {{ size: number, mtimeMs: number }} st
   */
  async readFile(path, st) {
    let place = this.places.get(path);
    if (place && place.size === st.size && place.mtimeMs === st.mtimeMs) return;
    const fh = await open(path, 'r');
    try {
      if (!place || st.size < place.offset) {
        const at = await firstSince(fh, st.size, this.since);
        place = { size: -1, mtimeMs: 0, offset: at, carry: null, partial: at > 0 };
        this.places.set(path, place);
      }
      while (place.offset < st.size) {
        const buf = await readRange(fh, place.offset, Math.min(st.size, place.offset + CHUNK));
        if (!buf.length) break;
        place.offset += buf.length;
        this.consume(place, place.carry ? Buffer.concat([place.carry, buf]) : buf);
      }
    } finally {
      await fh.close();
    }
    place.size = st.size;
    place.mtimeMs = st.mtimeMs;
  }

  /**
   * Takes the replies in the complete lines of `buf`, and keeps its unfinished last line.
   * @param {Place} place
   * @param {Buffer} buf
   */
  consume(place, buf) {
    let pos = 0;
    if (place.partial) {
      // Begun inside a line: from the next one.
      const nl = buf.indexOf(10);
      if (nl < 0) {
        place.carry = null;
        return;
      }
      pos = nl + 1;
      place.partial = false;
    }
    // Where a reply's text is next: the lines that end before it hold none.
    let next = buf.indexOf(REPLY, pos);
    for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
      if (next >= 0 && next < nl) {
        this.line(buf, pos, nl);
        next = buf.indexOf(REPLY, nl + 1);
      }
      pos = nl + 1;
    }
    place.carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : null;
  }

  /**
   * One line that may be a reply's record; one that is not JSON (being written) is skipped.
   * @param {Buffer} buf
   * @param {number} start
   * @param {number} end
   */
  line(buf, start, end) {
    if (OTHER.test(buf.toString('latin1', start, Math.min(end, start + 40)))) return;
    let rec;
    try {
      rec = JSON.parse(buf.toString('utf8', start, end));
    } catch {
      return;
    }
    this.take(rec);
  }

  /**
   * Takes a reply's record: its message's usage so far, at the time of its first record. A reply
   * of a model that uses none of the plan, or with no usage (an error's), is left out.
   * @param {any} rec
   */
  take(rec) {
    const m = rec && typeof rec === 'object' && rec.type === 'assistant' ? rec.message : undefined;
    const u = m && typeof m === 'object' ? m.usage : undefined;
    if (!u || typeof u !== 'object' || typeof m.id !== 'string' || typeof m.model !== 'string') return;
    const weight = weightOf(m.model);
    const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!weight || !Number.isFinite(t)) return;
    // A thinking block's record is written when it ends.
    const asked = t - Math.min(count(rec.thinkingDurationMs), MAX_THINKING);
    const tokens = {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
    };
    const had = this.messages.get(m.id);
    if (had) {
      had.t = Math.min(had.t, t);
      had.asked = Math.min(had.asked, asked);
      had.input = Math.max(had.input, tokens.input);
      had.output = Math.max(had.output, tokens.output);
      had.cacheRead = Math.max(had.cacheRead, tokens.cacheRead);
      had.cacheWrite = Math.max(had.cacheWrite, tokens.cacheWrite);
    } else {
      if (t < this.since) return;
      this.messages.set(m.id, { t, asked, weight, ...tokens });
    }
    this.changed = true;
  }
}

/** @param {unknown} v a count of tokens or milliseconds; 0 when it is none */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * What a model's tokens weigh against Claude Opus 5.5's (MODELS).
 * @param {string} model
 */
export function weightOf(model) {
  if (!model.startsWith('claude-')) return 0;
  for (const [name, w] of MODELS) if (model.startsWith(name)) return w;
  return 1;
}

/**
 * A message's usage, weighed.
 * @param {Message} m
 * @returns {Reply}
 */
function replyOf(m) {
  const x = m.output + KINDS.input * m.input + KINDS.cacheRead * m.cacheRead + KINDS.cacheWrite * m.cacheWrite;
  return { t: m.t, asked: m.asked, x: m.weight * x };
}

/**
 * The transcripts under `root` written since `since`, with their stats: <project>/<session>.jsonl,
 * and in <project>/<session>/subagents/ the agents' agent-<id>.jsonl and those of its workflows,
 * workflows/<run>/agent-<id>.jsonl.
 * @param {string} root
 * @param {number} since
 */
async function transcripts(root, since) {
  /** @type {{ path: string, st: import('node:fs').Stats }[]} */
  const found = [];
  /** @param {string} path */
  const take = async (path) => {
    const st = await statOf(path);
    if (st && st.mtimeMs >= since) found.push({ path, st });
  };
  /** The agents' transcripts in a folder. @param {string} dir */
  const agents = async (dir) => {
    const list = await entries(dir);
    await Promise.all(list.filter((e) => e.isFile() && AGENT_FILE.test(e.name)).map((e) => take(join(dir, e.name))));
    return list;
  };
  /** A session's agents, and its workflows'. @param {string} dir its folder */
  const session = async (dir) => {
    const list = await agents(join(dir, 'subagents'));
    if (!list.some((e) => e.isDirectory() && e.name === 'workflows')) return;
    const runs = (await entries(join(dir, 'subagents', 'workflows'))).filter((e) => e.isDirectory());
    await Promise.all(runs.map((r) => agents(join(dir, 'subagents', 'workflows', r.name))));
  };
  const projects = (await entries(root)).filter((e) => e.isDirectory());
  await Promise.all(projects.map(async (p) => {
    const dir = join(root, p.name);
    await Promise.all((await entries(dir)).map(async (e) => {
      if (e.isFile() && SESSION_FILE.test(e.name)) await take(join(dir, e.name));
      else if (e.isDirectory()) await session(join(dir, e.name));
    }));
  }));
  return found;
}

/**
 * Where to read a transcript from for its records written since `since`: its start, or the start
 * of a line written before them, at most NEAR before the first. Records are in the order they
 * were written, near enough (a fork copies older ones to its start, which only makes it read
 * more).
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} size
 * @param {number} since
 */
async function firstSince(fh, size, since) {
  let lo = 0;
  let hi = size;
  while (hi - lo > NEAR) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const t = await timeAt(fh, mid, size);
    if (t !== undefined && t < since) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The time of the first record with one in the lines after `at`; undefined when the bytes looked
 * at (MAX_PROBE at most) hold no line with a time.
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} at
 * @param {number} size
 * @returns {Promise<number | undefined>}
 */
async function timeAt(fh, at, size) {
  for (let probe = PROBE; ; probe *= 4) {
    const buf = await readRange(fh, at, Math.min(size, at + probe));
    let pos = at > 0 ? buf.indexOf(10) + 1 : 0;
    if (at === 0 || pos > 0) {
      for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
        const m = TIME.exec(buf.toString('latin1', pos, nl));
        const t = m ? Date.parse(m[1]) : NaN;
        if (Number.isFinite(t)) return t;
        pos = nl + 1;
      }
    }
    if (probe >= MAX_PROBE || at + probe >= size) return undefined;
  }
}
