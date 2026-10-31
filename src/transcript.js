// Claude Code's transcripts, read as they grow: <config>/projects/<project>/<session>.jsonl for
// a session, and subagents/**/agent-<id>.jsonl beside it for the agents it starts. A Transcript
// reads the tail on first sight and after that only what was appended, and keeps what the
// monitor shows: when the agent last did something, its model, effort and context, whether it
// was reminded that ultracode is on, the tool calls still waiting for a result, the commands it
// runs in the background, its task list, the last prompt and reply, the titles and the latest
// events.
import { open } from 'node:fs/promises';
import { readRange } from './files.js';
import { clean, toolSummary } from './format.js';

/** How much of a transcript is read on first sight: enough for the current turn. */
export const TAIL_BYTES = 1 << 20;
const MAX_TAIL_BYTES = 64 << 20;
/** How far back a first read goes for the start of a task list it saw changed. */
const PLAN_TAIL_BYTES = 16 << 20;
const HEAD_BYTES = 64 << 10;
const MAX_EVENTS = 200;
const MAX_TEXT = 400;
const MAX_STEPS = 30;
// How a tool call's result begins when its command went on in the background, with its task ID
// (a command's own output that says so further on is not taken for it).
const TO_BACKGROUND = /^\s*Command (?:running in background with ID|did not complete [^\n]{0,80}?moved to the background \(ID): ?([\w-]+)/;
// Records the monitor never needs, some of them megabytes long: skipped without being parsed.
const SKIP = /^\{"type":"(?:api-request|file-history|atis-latch|frame-link|artifact-|mode"|bridge-session|queue-operation)/;

/**
 * @typedef {{ ts: number, kind: 'prompt' | 'reply' | 'tool' | 'error' | 'info', text: string }} Event
 * @typedef {{ name: string, input: any, ts: number, summary: string }} PendingTool
 * @typedef {{ summary: string, ts: number, taskId: string }} Command a command that went on in
 *   the background (run_in_background, or past its timeout), from when its call was made
 * @typedef {'pending' | 'in_progress' | 'completed'} StepStatus
 * @typedef {{ text: string, status: StepStatus }} Step
 * @typedef {{ steps: Step[], ts: number }} Plan a task list: the desktop app's (update_plan) or
 *   Claude Code's own (TodoWrite), as of its last change
 * @typedef {{ usd: number, input: number, output: number, cacheRead: number, cacheWrite: number,
 *   linesAdded: number, linesRemoved: number, apiMs: number, durationMs: number }} Cost
 * @typedef {ReturnType<typeof emptyInfo>} Info
 */

/** What a transcript says, as far as it has been read. */
export function emptyInfo() {
  return {
    /** user and assistant records read */
    messages: 0,
    /** @type {string | undefined} */ sessionId: undefined,
    /** @type {string | undefined} */ agentId: undefined,
    /** @type {string | undefined} */ cwd: undefined,
    /** @type {string | undefined} */ gitBranch: undefined,
    /** @type {string | undefined} */ version: undefined,
    /** @type {string | undefined} */ entrypoint: undefined,
    /** @type {string | undefined} */ permissionMode: undefined,
    /** @type {string | undefined} */ effort: undefined,
    /** a reminder that ultracode is on was read: Claude Code sends one with some prompts, not all */
    ultracode: false,
    /** the earliest and the latest time a record read was written (ms) */
    firstTs: 0,
    lastTs: 0,
    /** @type {string | undefined} the model of the last real reply */
    model: undefined,
    /** the context the last reply was given, in tokens: input, cache reads and cache writes */
    ctx: 0,
    /** output tokens of the replies read */
    outTokens: 0,
    /** @type {string | undefined} */ lastMessageId: undefined,
    lastMessageOut: 0,
    /** @type {Map<string, PendingTool>} tool calls without a result yet, by tool use ID */
    pending: new Map(),
    /** @type {Set<string>} the tool use IDs read, so a call with a result can be told from one not read */
    seenTools: new Set(),
    /** @type {Map<string, Command>} commands in the background not known to have ended, by tool use ID */
    commands: new Map(),
    /** @type {Plan | undefined} */ plan: undefined,
    /** a change to a task list made before the part read, and none made since */
    planMissed: false,
    /** @type {{ text: string, ts: number } | undefined} */ lastPrompt: undefined,
    /** @type {{ text: string, ts: number } | undefined} */ lastReply: undefined,
    /** @type {{ text: string, ts: number } | undefined} the last API error, such as a usage limit */
    apiError: undefined,
    /** @type {'user' | 'assistant' | undefined} */ lastRole: undefined,
    /** @type {string | undefined} the last reply's stop reason: 'tool_use', 'end_turn'... */
    lastStop: undefined,
    /** @type {string | undefined} the uuid of the last assistant record, which the desktop app's turn summary names */
    lastAssistantUuid: undefined,
    /** @type {string | undefined} */ customTitle: undefined,
    /** @type {string | undefined} */ aiTitle: undefined,
    /** @type {string | undefined} */ agentName: undefined,
    /** @type {string | undefined} */ summary: undefined,
    /** @type {Cost | undefined} the last cost-state record: Claude Code's own totals */
    cost: undefined,
    /** human prompts read */
    prompts: 0,
    /** @type {Event[]} the latest events, oldest first */
    events: [],
  };
}

export class Transcript {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    /** the file's size when last read; -1 before the first read */
    this.size = -1;
    this.mtimeMs = 0;
    /** where reading began: 0 once the whole file has been read */
    this.start = 0;
    /** where the next read starts */
    this.offset = 0;
    /** @type {Buffer | null} the start of a line not finished yet */
    this.carry = null;
    this.info = emptyInfo();
    /** @type {{ firstTs: number, firstPrompt: string } | null} from the file's first bytes */
    this.head = null;
  }

  /**
   * Reads what changed since the last call: the tail on the first, then what was appended (the
   * tail again when the file shrank, or grew by more than a few tails at once).
   * @param {{ size: number, mtimeMs: number }} stat the file's, from fs.stat
   * @returns {Promise<boolean>} whether anything changed
   */
  async update(stat) {
    if (stat.size === this.size && stat.mtimeMs === this.mtimeMs) return false;
    const fh = await open(this.path, 'r');
    try {
      const appended = this.size >= 0 && stat.size >= this.offset && stat.size - this.offset <= 4 * TAIL_BYTES;
      if (!appended) await this.readTail(fh, stat.size);
      else if (stat.size > this.offset) {
        const buf = await readRange(fh, this.offset, stat.size);
        this.offset += buf.length;
        this.consume(this.carry ? Buffer.concat([this.carry, buf]) : buf, false);
      }
      if (!this.head || stat.size < this.size || (!this.head.firstPrompt && stat.size <= 4 * HEAD_BYTES)) {
        this.head = await readHead(fh, stat.size);
      }
    } finally {
      await fh.close();
    }
    this.size = stat.size;
    this.mtimeMs = stat.mtimeMs;
    return true;
  }

  /**
   * Reads the last TAIL_BYTES, or more while that holds no message (records can be megabytes),
   * or while it changes a task list made before it.
   * @param {import('node:fs/promises').FileHandle} fh
   * @param {number} size
   */
  async readTail(fh, size) {
    for (let tail = TAIL_BYTES; ; tail *= 4) {
      const start = Math.max(0, size - tail);
      this.info = emptyInfo();
      this.carry = null;
      this.start = start;
      const buf = await readRange(fh, start, size);
      this.offset = start + buf.length;
      this.consume(buf, start > 0);
      if (start === 0 || tail >= MAX_TAIL_BYTES) return;
      if (this.info.messages > 0 && !(this.info.planMissed && tail < PLAN_TAIL_BYTES)) return;
    }
  }

  /**
   * Reads the complete lines in `buf` and keeps the unfinished last one for the next read.
   * @param {Buffer} buf
   * @param {boolean} skipFirst whether `buf` starts inside a line
   */
  consume(buf, skipFirst) {
    let pos = 0;
    if (skipFirst) {
      const nl = buf.indexOf(10);
      if (nl < 0) {
        this.carry = null;
        return;
      }
      pos = nl + 1;
    }
    for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
      if (nl > pos) readLine(this.info, buf, pos, nl);
      pos = nl + 1;
    }
    this.carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : null;
  }
}

/**
 * When the transcript began and its first prompt, from its first HEAD_BYTES.
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} size
 */
async function readHead(fh, size) {
  const buf = await readRange(fh, 0, Math.min(size, HEAD_BYTES));
  const info = emptyInfo();
  let pos = 0;
  for (let nl = buf.indexOf(10); nl >= 0 && info.prompts === 0; nl = buf.indexOf(10, pos)) {
    if (nl > pos) readLine(info, buf, pos, nl);
    pos = nl + 1;
  }
  return { firstTs: info.firstTs, firstPrompt: info.events.find((e) => e.kind === 'prompt')?.text ?? '' };
}

/**
 * Reads one JSONL line into `info`; a line that is not JSON (one being written) is skipped.
 * @param {Info} info
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 */
function readLine(info, buf, start, end) {
  if (SKIP.test(buf.toString('latin1', start, Math.min(end, start + 40)))) return;
  let rec;
  try {
    rec = JSON.parse(buf.toString('utf8', start, end));
  } catch {
    return;
  }
  if (rec && typeof rec === 'object') readRecord(info, rec);
}

/**
 * Takes one transcript record into `info`.
 * @param {Info} info
 * @param {Record<string, any>} rec
 */
export function readRecord(info, rec) {
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || 0 : 0;
  if (ts) {
    if (!info.firstTs || ts < info.firstTs) info.firstTs = ts;
    if (ts > info.lastTs) info.lastTs = ts;
  }
  switch (rec.type) {
    case 'user':
    case 'assistant':
      info.messages++;
      for (const k of /** @type {const} */ (['sessionId', 'agentId', 'cwd', 'gitBranch', 'version', 'entrypoint', 'permissionMode'])) {
        if (typeof rec[k] === 'string' && rec[k]) info[k] = rec[k];
      }
      // The effort of the turn, else the session's.
      for (const effort of [rec.perTurnEffort, rec.effort]) {
        if (typeof effort === 'string' && effort) {
          info.effort = effort;
          break;
        }
      }
      if (rec.type === 'user') readUser(info, rec, ts);
      else readAssistant(info, rec, ts);
      break;
    case 'custom-title':
      if (typeof rec.customTitle === 'string') info.customTitle = rec.customTitle;
      break;
    case 'ai-title':
      if (typeof rec.aiTitle === 'string') info.aiTitle = rec.aiTitle;
      break;
    case 'agent-name':
      if (typeof rec.agentName === 'string') info.agentName = rec.agentName;
      break;
    case 'summary':
      if (typeof rec.summary === 'string') info.summary = rec.summary;
      break;
    case 'last-prompt':
      // Written again and again, without a time: only for a prompt older than what was read.
      if (typeof rec.lastPrompt === 'string' && !info.lastPrompt) {
        const text = promptText(rec.lastPrompt);
        if (text) info.lastPrompt = { text: text.slice(0, MAX_TEXT), ts: 0 };
      }
      break;
    case 'cost-state':
      info.cost = costOf(rec);
      break;
    case 'system':
      if (rec.subtype === 'compact_boundary') addEvent(info, ts, 'info', 'conversation compacted');
      break;
    case 'attachment':
      // A message that came in while a turn went on, such as a background task's end.
      if (rec.attachment?.type === 'queued_command' && typeof rec.attachment.prompt === 'string') taskEnded(info, rec.attachment.prompt, ts);
      // Ultracode's reminder, with its first prompt and about every tenth after (none says it ended).
      else if (rec.attachment?.type === 'ultra_effort_enter') info.ultracode = true;
      break;
  }
}

/**
 * @param {Info} info
 * @param {Record<string, any>} rec
 * @param {number} ts
 */
function readUser(info, rec, ts) {
  info.lastRole = 'user';
  const content = rec.message?.content;
  if (typeof content === 'string') {
    taskEnded(info, content, ts);
    if (!rec.isMeta) addPrompt(info, content, ts);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part?.type === 'tool_result') {
      const call = info.pending.get(part.tool_use_id);
      info.pending.delete(part.tool_use_id);
      if (part.is_error) {
        // Its lines kept apart: 'Exit code 1 / 2 tests failed'.
        const text = textOf(part.content).replace(/<\/?tool_use_error>/g, '').trim();
        const why = clean(text.replace(/\s*\n\s*/g, ' / ')).slice(0, 120);
        addEvent(info, ts, 'error', `${call ? call.summary : 'a tool call'} failed${why ? `: ${why}` : ''}`);
      } else if (call) {
        readResult(info, part.tool_use_id, call, textOf(part.content), ts);
      }
    } else if (part?.type === 'text' && !rec.isMeta && !rec.toolUseResult) {
      addPrompt(info, part.text, ts);
    }
  }
}

/**
 * What a tool call that worked changed: a command that went on in the background, one stopped,
 * a task list.
 * @param {Info} info
 * @param {string} id the tool use ID
 * @param {PendingTool} call
 * @param {string} text its result
 * @param {number} ts
 */
function readResult(info, id, call, text, ts) {
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const bg = TO_BACKGROUND.exec(text);
  if (bg) {
    info.commands.set(id, { summary: call.summary, ts: call.ts, taskId: bg[1] });
    if (info.commands.size > 32) info.commands.delete(/** @type {string} */ (info.commands.keys().next().value));
  }
  switch (call.name) {
    case 'TaskStop':
    case 'KillShell': {
      const task = String(input.task_id ?? input.shell_id ?? '');
      for (const [k, c] of info.commands) if (c.taskId === task) info.commands.delete(k);
      break;
    }
    case 'TodoWrite':
      if (Array.isArray(input.todos)) setPlan(info, input.todos, ts);
      break;
    case 'mcp__ccd_turn__update_plan':
      changePlan(info, input, ts);
      break;
    case 'mcp__ccd_turn__wrap_up':
      // It checks off the list: the step in progress is done.
      if (info.plan?.steps.some((s) => s.status === 'in_progress')) {
        const steps = info.plan.steps.map((s) => (s.status === 'in_progress' ? { ...s, status: /** @type {StepStatus} */ ('completed') } : s));
        info.plan = { steps, ts };
      }
      break;
  }
}

/**
 * A background task's end, from the message Claude Code sends the session about it: the
 * command that went on in the background (by its call's tool use ID) is over.
 * @param {Info} info
 * @param {string} text
 * @param {number} ts
 */
function taskEnded(info, text, ts) {
  if (!text.startsWith('<task-notification>')) return;
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const command = id ? info.commands.get(id) : undefined;
  if (!id || !command) return;
  info.commands.delete(id);
  const status = clean(/<status>([^<]*)<\/status>/.exec(text)?.[1]) || 'ended';
  addEvent(info, ts, 'info', `${command.summary}: ${status} in the background`);
}

/**
 * A new task list.
 * @param {Info} info
 * @param {unknown[]} items each { content, status }
 * @param {number} ts
 */
function setPlan(info, items, ts) {
  const steps = items.slice(0, MAX_STEPS).map((i) => {
    const o = /** @type {Record<string, unknown>} */ (i && typeof i === 'object' ? i : {});
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    return { text: clean(o.content).slice(0, MAX_TEXT), status: /** @type {StepStatus} */ (status) };
  });
  info.plan = { steps, ts };
  info.planMissed = false;
}

/**
 * A change to the desktop app's task list (update_plan): the whole list (items), or the next
 * step (advance), or steps done (done) and the one started (start), 1-based.
 * @param {Info} info
 * @param {Record<string, any>} input
 * @param {number} ts
 */
function changePlan(info, input, ts) {
  if (Array.isArray(input.items)) return setPlan(info, input.items, ts);
  if (!info.plan) {
    info.planMissed = true;
    return;
  }
  const steps = info.plan.steps.map((s) => ({ ...s }));
  const set = (/** @type {unknown} */ n, /** @type {StepStatus} */ status) => {
    if (typeof n === 'number' && steps[n - 1]) steps[n - 1].status = status;
  };
  if (input.advance === true) {
    const doing = steps.findIndex((s) => s.status === 'in_progress');
    if (doing >= 0) steps[doing].status = 'completed';
    const after = steps.findIndex((s, i) => i > doing && s.status === 'pending');
    const next = after >= 0 ? after : steps.findIndex((s) => s.status === 'pending');
    if (next >= 0) steps[next].status = 'in_progress';
  }
  for (const n of Array.isArray(input.done) ? input.done : []) set(n, 'completed');
  set(input.start, 'in_progress');
  info.plan = { steps, ts };
}

/**
 * @param {Info} info
 * @param {Record<string, any>} rec
 * @param {number} ts
 */
function readAssistant(info, rec, ts) {
  info.lastRole = 'assistant';
  if (typeof rec.uuid === 'string') info.lastAssistantUuid = rec.uuid;
  const m = rec.message ?? {};
  const real = typeof m.model === 'string' && m.model !== '<synthetic>';
  if (real) info.model = m.model;
  if (typeof m.stop_reason === 'string') info.lastStop = m.stop_reason;
  const u = m.usage;
  if (real && u) {
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    if (ctx) info.ctx = ctx;
    // Each content block is a record of its own, with the message's usage so far.
    const out = u.output_tokens || 0;
    if (m.id && m.id === info.lastMessageId) {
      if (out > info.lastMessageOut) info.outTokens += out - info.lastMessageOut;
      info.lastMessageOut = Math.max(out, info.lastMessageOut);
    } else {
      info.outTokens += out;
      info.lastMessageId = m.id;
      info.lastMessageOut = out;
    }
  }
  if (rec.isApiErrorMessage) {
    const text = clean(textOf(m.content)) || clean(rec.error) || 'API error';
    info.apiError = { text: text.slice(0, MAX_TEXT), ts };
    addEvent(info, ts, 'error', text);
    return;
  }
  if (!Array.isArray(m.content)) return;
  for (const part of m.content) {
    if (part?.type === 'tool_use' && typeof part.id === 'string') {
      const name = String(part.name ?? 'tool');
      const summary = toolSummary(name, part.input, info.cwd);
      info.pending.set(part.id, { name, input: part.input, ts, summary });
      if (info.pending.size > 64) info.pending.delete(/** @type {string} */ (info.pending.keys().next().value));
      info.seenTools.add(part.id);
      if (info.seenTools.size > 4096) info.seenTools.delete(/** @type {string} */ (info.seenTools.values().next().value));
      addEvent(info, ts, 'tool', summary);
    } else if (part?.type === 'text') {
      const text = clean(part.text);
      if (text) {
        info.lastReply = { text: text.slice(0, MAX_TEXT), ts };
        addEvent(info, ts, 'reply', text);
      }
    }
  }
}

/**
 * @param {Info} info
 * @param {unknown} raw
 * @param {number} ts
 */
function addPrompt(info, raw, ts) {
  const text = promptText(raw);
  if (!text) return;
  if (text.startsWith('[Request interrupted')) {
    addEvent(info, ts, 'info', 'interrupted');
    return;
  }
  info.prompts++;
  info.lastPrompt = { text: text.slice(0, MAX_TEXT), ts };
  addEvent(info, ts, 'prompt', text);
}

/**
 * @param {Info} info
 * @param {number} ts
 * @param {Event['kind']} kind
 * @param {string} text
 */
function addEvent(info, ts, kind, text) {
  info.events.push({ ts, kind, text: clean(text).slice(0, MAX_TEXT) });
  if (info.events.length > MAX_EVENTS) info.events.shift();
}

/**
 * What a person typed, from a user message's text: a slash command as '/name args', a shell
 * command (the ! prefix) as '! command', system reminders and command output dropped.
 * @param {unknown} raw
 */
export function promptText(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const command = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(s)?.[1] ?? '';
    return clean(`${command[1]} ${args}`);
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return clean(`! ${bash[1]}`);
  if (/^\s*<(?:local-command-|bash-stdout|bash-stderr|task-notification)/.test(s)) return '';
  return clean(s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''));
}

/**
 * The text of message content: a string, or the text parts of a list.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join(' ');
}

/**
 * Claude Code's running totals for a session, from a cost-state record.
 * @param {Record<string, any>} rec
 * @returns {Cost}
 */
function costOf(rec) {
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cost = {
    usd: n(rec.totalCostUSD), input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    linesAdded: n(rec.totalLinesAdded), linesRemoved: n(rec.totalLinesRemoved),
    apiMs: n(rec.totalAPIDuration), durationMs: n(rec.totalDuration),
  };
  for (const u of Object.values(rec.modelUsage ?? {})) {
    cost.input += n(u?.inputTokens);
    cost.output += n(u?.outputTokens);
    cost.cacheRead += n(u?.cacheReadInputTokens);
    cost.cacheWrite += n(u?.cacheCreationInputTokens);
  }
  return cost;
}
