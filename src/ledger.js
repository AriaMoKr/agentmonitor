// What Claude Code's replies used, from the transcripts under <config>/projects: the sessions',
// their subagents' and their workflows' agents'. Each reply once, though it is written as a
// record for each of its content blocks, each with the usage so far: when it was written, about
// when it was asked for, its tokens weighed as the plan's usage limits are taken to count them,
// its session, model and the tools it called; and the prompts typed in the sessions, and how long
// they waited on you. Read back to a time asked for, and after that only what the transcripts
// grow by, so that src/usage.js can carry the desktop app's samples of the plan's usage on to now,
// and the monitor can say what today came to.
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { entries, readRange, statOf } from './files.js';
import { promptText } from './transcript.js';

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
/** What a prompt's record holds: a message of text alone (a tool's result is a list). */
const PROMPT = Buffer.from('"role":"user","content":"');
/** Records that begin with their type, but a reply's: never parsed (some are megabytes). */
const OTHER = /^\{"type":"(?!assistant")/;
const TIME = /"timestamp":"([^"]{10,40})"/;
/** The calls that wait on you till you answer; the start of a session waits only when offered. */
const WAITS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const OFFER = 'mcp__ccd_session__start_session';

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
 * @property {string} [session] the session it is in: its transcript's, or for an agent's reply
 *   that of the session that started the agent
 * @property {string} [agent] the subagent or workflow agent that wrote it
 * @property {string} [model]
 * @property {number} [out] its output tokens
 * @property {number} [in] its input tokens, with those read from the cache and written to it
 * @property {string[]} [tools] the tools it called
 * @property {number} [seen] when the read that found it began (ms)
 *
 * @typedef {{ t: number, session: string }} Prompt a prompt typed in a session
 * @typedef {{ start: number, end: number, session: string }} Wait a session waiting on you: from
 *   a call that asks you something (a question, a plan to approve, a session offered) to the next
 *   reply in its transcript, about when you answered
 *
 * @typedef {object} Replies the replies read
 * @property {number} from the time back to which all of them are known
 * @property {Reply[]} replies in the order written
 * @property {Prompt[]} [prompts] in the order written
 * @property {Wait[]} [waits] those over, in the order they ended
 * @property {Map<string, string>} [cwds] each session's folder, as its transcripts last said it
 *
 * @typedef {{ t: number, asked: number, weight: number, input: number, output: number, cacheRead: number, cacheWrite: number,
 *   session: string, agent?: string, model: string, tools: string[], toolIds: string[], seen: number }} Message
 * @typedef {object} Place how far a transcript was read: the next byte, and the start of a line
 *   not finished yet; whose it is, and the call of it that waits on you
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} offset
 * @property {Buffer | null} carry
 * @property {boolean} partial
 * @property {string} session
 * @property {string} [agent]
 * @property {string} [cwd]
 * @property {{ start: number, id: string }} [wait] the reply that asked, and when
 */

export class Ledger {
  /** @param {string} root the transcripts' folder: <config>/projects */
  constructor(root) {
    this.root = root;
    /** @type {Map<string, Place>} */
    this.places = new Map();
    /** @type {Map<string, Message>} the replies read, by message ID */
    this.messages = new Map();
    /** @type {Map<string, Prompt>} the prompts read, by their record's uuid */
    this.prompts = new Map();
    /** @type {Map<string, Wait>} the waits on you that ended, by the message ID of the reply that asked */
    this.waits = new Map();
    /** the time the transcripts are read back to */
    this.since = Infinity;
    /** the time back to which a read that finished found all the replies; Infinity before one */
    this.from = Infinity;
    this.readAt = -Infinity;
    /** @type {Promise<void> | null} the read going on */
    this.reading = null;
    /** @type {Required<Replies>} */
    this.list = { from: Infinity, replies: [], prompts: [], waits: [], cwds: new Map() };
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
      /** @type {Map<string, string>} */
      const cwds = new Map();
      for (const p of this.places.values()) if (p.cwd && (!p.agent || !cwds.has(p.session))) cwds.set(p.session, p.cwd);
      this.list = {
        from: this.from,
        replies: [...this.messages.values()].map(replyOf).sort((a, b) => a.t - b.t),
        prompts: [...this.prompts.values()].sort((a, b) => a.t - b.t),
        waits: [...this.waits.values()].sort((a, b) => a.end - b.end),
        cwds,
      };
    }
    return { ...this.list, from: this.from };
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
      this.prompts.clear();
      this.waits.clear();
      this.since = Infinity;
      this.from = Infinity;
      this.changed = true;
    }
    if (this.since === Infinity || since > this.since) this.since = since;
    const found = await transcripts(this.root, this.since);
    for (const { path, st, session, agent } of found) {
      try {
        await this.readFile(path, st, { session, agent });
      } catch {
        // Removed or locked meanwhile: what was read stands.
      }
    }
    const paths = new Set(found.map((f) => f.path));
    for (const path of this.places.keys()) if (!paths.has(path)) this.places.delete(path);
    const gone = [
      prune(this.messages, (m) => m.t, this.since),
      prune(this.prompts, (p) => p.t, this.since),
      prune(this.waits, (w) => w.end, this.since),
    ];
    if (gone.includes(true)) this.changed = true;
    this.from = this.since;
  }

  /**
   * Reads what a transcript has that was not read: on first sight from about its first record
   * written since `this.since`, then what was appended.
   * @param {string} path
   * @param {{ size: number, mtimeMs: number }} st
   * @param {{ session: string, agent?: string }} [whose] the session it is in, and the agent
   *   that writes it, if it is an agent's
   */
  async readFile(path, st, { session, agent } = { session: '' }) {
    let place = this.places.get(path);
    if (place && place.size === st.size && place.mtimeMs === st.mtimeMs) return;
    const fh = await open(path, 'r');
    try {
      if (!place || st.size < place.offset) {
        const at = await firstSince(fh, st.size, this.since);
        place = { size: -1, mtimeMs: 0, offset: at, carry: null, partial: at > 0, session, ...(agent ? { agent } : {}) };
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
    // Where a reply's text is next, and a prompt's in a session's own transcript: the lines that
    // end before them hold none.
    let next = buf.indexOf(REPLY, pos);
    let prompt = place.agent ? -1 : buf.indexOf(PROMPT, pos);
    for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
      if (next >= 0 && next < nl) {
        this.line(buf, pos, nl, place);
        next = buf.indexOf(REPLY, nl + 1);
      }
      if (prompt >= 0 && prompt < nl) {
        this.prompt(buf, pos, nl, place);
        prompt = buf.indexOf(PROMPT, nl + 1);
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
   * @param {Place} [place] the transcript's
   */
  line(buf, start, end, place) {
    if (OTHER.test(buf.toString('latin1', start, Math.min(end, start + 40)))) return;
    let rec;
    try {
      rec = JSON.parse(buf.toString('utf8', start, end));
    } catch {
      return;
    }
    this.take(rec, place);
  }

  /**
   * One line that may be a prompt's record: a person's message (not one Claude Code wrote, such
   * as a compaction's summary, nor a command's output), and its time.
   * @param {Buffer} buf
   * @param {number} start
   * @param {number} end
   * @param {Place} place
   */
  prompt(buf, start, end, place) {
    let rec;
    try {
      rec = JSON.parse(buf.toString('utf8', start, end));
    } catch {
      return;
    }
    if (!rec || rec.type !== 'user' || rec.isMeta || rec.isCompactSummary || typeof rec.uuid !== 'string') return;
    const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(t) || t < this.since || this.prompts.has(rec.uuid)) return;
    const text = promptText(rec.message?.content);
    if (!text || text.startsWith('[Request interrupted')) return;
    this.prompts.set(rec.uuid, { t, session: place.session });
    this.changed = true;
  }

  /**
   * Takes a reply's record: its message's usage so far, at the time of its first record, and the
   * tools it calls. A reply of a model that uses none of the plan, or with no usage (an error's),
   * is left out. A call that asks you something waits on you till the next reply in the
   * transcript.
   * @param {any} rec
   * @param {Place} [place] the transcript's
   */
  take(rec, place = { size: 0, mtimeMs: 0, offset: 0, carry: null, partial: false, session: '' }) {
    const m = rec && typeof rec === 'object' && rec.type === 'assistant' ? rec.message : undefined;
    const u = m && typeof m === 'object' ? m.usage : undefined;
    if (!u || typeof u !== 'object' || typeof m.id !== 'string' || typeof m.model !== 'string') return;
    const weight = weightOf(m.model);
    const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (!weight || !Number.isFinite(t)) return;
    if (typeof rec.cwd === 'string' && rec.cwd) place.cwd = rec.cwd;
    // A thinking block's record is written when it ends.
    const asked = t - Math.min(count(rec.thinkingDurationMs), MAX_THINKING);
    if (place.wait && place.wait.id !== m.id && asked >= place.wait.start) {
      this.waits.set(place.wait.id, { start: place.wait.start, end: asked, session: place.session });
      place.wait = undefined;
    }
    const tokens = {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
    };
    let had = this.messages.get(m.id);
    if (had) {
      had.t = Math.min(had.t, t);
      had.asked = Math.min(had.asked, asked);
      had.input = Math.max(had.input, tokens.input);
      had.output = Math.max(had.output, tokens.output);
      had.cacheRead = Math.max(had.cacheRead, tokens.cacheRead);
      had.cacheWrite = Math.max(had.cacheWrite, tokens.cacheWrite);
    } else {
      if (t < this.since) return;
      had = { t, asked, weight, ...tokens, session: place.session, model: m.model, tools: [], toolIds: [], seen: this.readAt };
      if (place.agent) had.agent = place.agent;
      this.messages.set(m.id, had);
    }
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (part?.type !== 'tool_use' || typeof part.name !== 'string' || typeof part.id !== 'string' || had.toolIds.includes(part.id)) continue;
      had.toolIds.push(part.id);
      had.tools.push(part.name);
      if (WAITS.has(part.name) || (part.name === OFFER && part.input?.initiation === 'offer')) place.wait ??= { start: t, id: m.id };
    }
    this.changed = true;
  }
}

/** @param {unknown} v a count of tokens or milliseconds; 0 when it is none */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Takes out of `map` what is from before `since`, as `time` says; whether anything went.
 * @template T
 * @param {Map<string, T>} map
 * @param {(v: T) => number} time
 * @param {number} since
 */
function prune(map, time, since) {
  let gone = false;
  for (const [k, v] of map) {
    if (time(v) < since) {
      map.delete(k);
      gone = true;
    }
  }
  return gone;
}

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
 * What a context of so many tokens adds to a reply's use (its x) when the prompt cache no longer
 * holds it: written to the cache again, where it would have been read from it.
 * @param {number} tokens
 * @param {string} model
 */
export function rewriteOf(tokens, model) {
  return tokens * (KINDS.cacheWrite - KINDS.cacheRead) * weightOf(model);
}

/**
 * A message's usage, weighed.
 * @param {Message} m
 * @returns {Reply}
 */
function replyOf(m) {
  const x = m.output + KINDS.input * m.input + KINDS.cacheRead * m.cacheRead + KINDS.cacheWrite * m.cacheWrite;
  return {
    t: m.t, asked: m.asked, x: m.weight * x, session: m.session, ...(m.agent ? { agent: m.agent } : {}), model: m.model,
    out: m.output, in: m.input + m.cacheRead + m.cacheWrite, tools: m.tools, seen: m.seen,
  };
}

/**
 * @typedef {object} Day what the sessions on this computer did since a time (today's start)
 * @property {number} from
 * @property {number} sessions the sessions with replies
 * @property {number} agents the subagents and workflow agents with replies
 * @property {number} prompts
 * @property {number} replies
 * @property {number} out output tokens
 * @property {number} in input tokens, with those read from the cache and written to it
 * @property {number} waitedMs how long they waited on you, in the waits that ended
 * @property {[string, number][]} tools how many calls of each tool, the most first
 * @property {[string, number][]} models how much each model used, weighed (Reply.x), the most first
 * @property {number[]} hours how many replies in each hour from `from` on
 */

/**
 * What the replies, prompts and waits since `from` came to.
 * @param {Replies} r
 * @param {number} from
 * @param {number} now
 * @returns {Day}
 */
export function dayOf(r, from, now) {
  const replies = r.replies.filter((x) => x.t >= from);
  const sessions = new Set();
  const agents = new Set();
  /** @type {Map<string, number>} */
  const tools = new Map();
  /** @type {Map<string, number>} */
  const models = new Map();
  const hours = Array.from({ length: Math.max(1, Math.ceil((now - from) / 3_600_000)) }, () => 0);
  let out = 0;
  let input = 0;
  for (const x of replies) {
    if (x.session) sessions.add(x.session);
    if (x.agent) agents.add(`${x.session}:${x.agent}`);
    for (const name of x.tools ?? []) tools.set(name, (tools.get(name) ?? 0) + 1);
    if (x.model) models.set(x.model, (models.get(x.model) ?? 0) + x.x);
    const h = Math.floor((x.t - from) / 3_600_000);
    if (h < hours.length) hours[h]++;
    out += x.out ?? 0;
    input += x.in ?? 0;
  }
  const most = (/** @type {Map<string, number>} */ m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    from,
    sessions: sessions.size,
    agents: agents.size,
    prompts: (r.prompts ?? []).filter((p) => p.t >= from).length,
    replies: replies.length,
    out,
    in: input,
    waitedMs: (r.waits ?? []).reduce((n, w) => n + Math.max(0, w.end - Math.max(w.start, from)), 0),
    tools: most(tools),
    models: most(models),
    hours,
  };
}

/**
 * The transcripts under `root` written since `since`, with their stats and whose they are:
 * <project>/<session>.jsonl, and in <project>/<session>/subagents/ the agents' agent-<id>.jsonl and
 * those of its workflows, workflows/<run>/agent-<id>.jsonl.
 * @param {string} root
 * @param {number} since
 */
async function transcripts(root, since) {
  /** @type {{ path: string, st: import('node:fs').Stats, session: string, agent?: string }[]} */
  const found = [];
  /** @param {string} path @param {string} session @param {string} [agent] */
  const take = async (path, session, agent) => {
    const st = await statOf(path);
    if (st && st.mtimeMs >= since) found.push({ path, st, session, ...(agent ? { agent } : {}) });
  };
  /** The agents' transcripts in a folder. @param {string} dir @param {string} session */
  const agents = async (dir, session) => {
    const list = await entries(dir);
    const files = list.filter((e) => e.isFile() && AGENT_FILE.test(e.name));
    await Promise.all(files.map((e) => take(join(dir, e.name), session, e.name.slice('agent-'.length, -'.jsonl'.length))));
    return list;
  };
  /** A session's agents, and its workflows'. @param {string} dir its folder */
  const session = async (dir) => {
    const id = basename(dir);
    const list = await agents(join(dir, 'subagents'), id);
    if (!list.some((e) => e.isDirectory() && e.name === 'workflows')) return;
    const runs = (await entries(join(dir, 'subagents', 'workflows'))).filter((e) => e.isDirectory());
    await Promise.all(runs.map((r) => agents(join(dir, 'subagents', 'workflows', r.name), id)));
  };
  const projects = (await entries(root)).filter((e) => e.isDirectory());
  await Promise.all(projects.map(async (p) => {
    const dir = join(root, p.name);
    await Promise.all((await entries(dir)).map(async (e) => {
      if (e.isFile() && SESSION_FILE.test(e.name)) await take(join(dir, e.name), e.name.slice(0, -'.jsonl'.length));
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
