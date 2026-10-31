// A Claude Code config folder for the tests, in a temporary folder: the registry, transcripts,
// subagents and workflows, background jobs and the desktop app's session records, written as
// Claude Code writes them.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const NOW = Date.parse('2026-10-29T20:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** @param {number} ms */
export const iso = (ms) => new Date(ms).toISOString();

let ids = 0;
/** A session ID: a UUID, as the transcripts' names need. */
export function sessionId() {
  ids++;
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
}

/**
 * The effort fields of an assistant record: the session's, and the turn's (the same, as
 * Claude Code writes them; null in some older versions). None when not given.
 * @param {string | undefined} effort
 * @param {string | null | undefined} perTurnEffort
 */
const efforts = (effort, perTurnEffort) => ({
  ...(effort === undefined ? {} : { effort }),
  ...(perTurnEffort === undefined ? {} : { perTurnEffort }),
});

/**
 * Transcript records, as Claude Code writes them.
 */
export const rec = {
  /** @param {string} text @param {number} at @param {object} [extra] */
  prompt: (text, at, extra = {}) => ({
    parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text },
    uuid: `u${at}`, timestamp: iso(at), cwd: 'C:\\work\\demo', sessionId: 's', version: '2.1.309', gitBranch: 'main', entrypoint: 'cli', ...extra,
  }),
  /**
   * @param {string} text @param {number} at
   * @param {{ model?: string, id?: string, ctx?: number, out?: number, effort?: string, perTurnEffort?: string | null }} [o]
   */
  reply: (text, at, { model = 'claude-opus-5-5', id = `msg_${at}`, ctx = 50_000, out = 100, effort, perTurnEffort = effort } = {}) => ({
    parentUuid: 'x', isSidechain: false, type: 'assistant', uuid: `r${at}`, timestamp: iso(at), cwd: 'C:\\work\\demo',
    ...efforts(effort, perTurnEffort),
    message: {
      model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1010, output_tokens: out },
    },
  }),
  /**
   * @param {string} toolId @param {string} name @param {object} input @param {number} at
   * @param {{ id?: string, out?: number, effort?: string, perTurnEffort?: string | null }} [o]
   */
  tool: (toolId, name, input, at, { id = `msg_${at}`, out = 50, effort, perTurnEffort = effort } = {}) => ({
    parentUuid: 'x', isSidechain: false, type: 'assistant', uuid: `t${at}`, timestamp: iso(at), cwd: 'C:\\work\\demo',
    ...efforts(effort, perTurnEffort),
    message: {
      model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }], stop_reason: 'tool_use',
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 60_000, output_tokens: out },
    },
  }),
  /** @param {string} toolId @param {number} at @param {boolean} [isError] @param {string} [text] what the result says */
  result: (toolId, at, isError = false, text = isError ? 'Exit code 1\nboom' : 'ok') => ({
    parentUuid: 'x', isSidechain: false, type: 'user', timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: isError }] },
    toolUseResult: { stdout: 'ok' },
  }),
  /**
   * The message Claude Code sends a session when a task it runs in the background ends: as a
   * prompt of its own, or (queued) taken in while a turn goes on.
   * @param {string} toolId the call that started it @param {string} taskId @param {string} status @param {number} at @param {boolean} [queued]
   */
  taskEnd: (toolId, taskId, status, at, queued = false) => {
    const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>C:\\tmp\\${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Background command ${status}</summary>\n</task-notification>`;
    return queued
      ? { parentUuid: 'x', isSidechain: false, attachment: { type: 'queued_command', prompt: text }, type: 'attachment', uuid: `q${at}`, timestamp: iso(at) }
      : { parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: `n${at}`, timestamp: iso(at) };
  },
  /** Ultracode's reminder, which comes after some prompts. @param {number} at @param {'full' | 'sparse'} [reminderType] */
  ultra: (at, reminderType = 'full') => ({
    parentUuid: 'x', isSidechain: false, attachment: { type: 'ultra_effort_enter', reminderType }, type: 'attachment', uuid: `ue${at}`, timestamp: iso(at),
  }),
  /** @param {string} text @param {number} at */
  apiError: (text, at) => ({
    type: 'assistant', uuid: `e${at}`, timestamp: iso(at), isApiErrorMessage: true, error: 'rate_limit',
    message: { model: '<synthetic>', id: `e${at}`, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } },
  }),
  /** @param {string} title */
  customTitle: (title) => ({ type: 'custom-title', customTitle: title, sessionId: 's' }),
  /** @param {string} title */
  aiTitle: (title) => ({ type: 'ai-title', aiTitle: title, sessionId: 's' }),
  /** @param {string} name */
  agentName: (name) => ({ type: 'agent-name', agentName: name, sessionId: 's' }),
  /** @param {string} text */
  lastPrompt: (text) => ({ type: 'last-prompt', lastPrompt: text, sessionId: 's' }),
  cost: () => ({
    type: 'cost-state', sessionId: 's', totalCostUSD: 1.5, totalLinesAdded: 10, totalLinesRemoved: 2, totalAPIDuration: 1000, totalDuration: 5000,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 2000, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4000 } },
  }),
};

/**
 * A config folder; removed after the test.
 * @param {import('node:test').TestContext} t
 */
export function makeConfig(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentmonitor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'claude');
  const desktop = join(root, 'desktop');
  mkdirSync(dir, { recursive: true });

  /** @param {string} path @param {string} text @param {number} [mtime] */
  const write = (path, text, mtime) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };
  /** @param {object[]} records */
  const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  return {
    root,
    dir,
    desktop,
    write,
    /**
     * A session's transcript in projects/<project>/; returns its path.
     * @param {string} id @param {object[]} records @param {{ project?: string, mtime?: number }} [o]
     */
    transcript(id, records, { project = 'C--work-demo', mtime } = {}) {
      return write(join(dir, 'projects', project, `${id}.jsonl`), jsonl(records), mtime);
    },
    /** A registry record: sessions/<pid>.json. @param {Record<string, any>} entry */
    registry(entry) {
      return write(join(dir, 'sessions', `${entry.pid}.json`), JSON.stringify({ kind: 'interactive', entrypoint: 'cli', version: '2.1.309', ...entry }));
    },
    /**
     * A subagent of a session: subagents/agent-<id>.jsonl and its .meta.json.
     * @param {string} session @param {string} agentId @param {object} meta @param {object[]} records @param {{ project?: string, mtime?: number }} [o]
     */
    subagent(session, agentId, meta, records, { project = 'C--work-demo', mtime } = {}) {
      const base = join(dir, 'projects', project, session, 'subagents');
      write(join(base, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      return write(join(base, `agent-${agentId}.jsonl`), jsonl(records), mtime);
    },
    /**
     * A workflow run: its agents, its journal, and its record when given.
     * @param {string} session @param {string} runId
     * @param {{ agents: { id: string, label: string, phase: string, records: object[], state: 'running' | 'done' | 'failed' | 'none' }[], record?: object, script?: string, mtime?: number }} o
     */
    workflow(session, runId, { agents, record, script, mtime }, project = 'C--work-demo') {
      const base = join(dir, 'projects', project, session);
      const runDir = join(base, 'subagents', 'workflows', runId);
      const journal = [{ type: 'launched' }];
      for (const a of agents) {
        write(join(runDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: a.label, workflowPhase: a.phase }));
        write(join(runDir, `agent-${a.id}.jsonl`), jsonl(a.records), mtime);
        if (a.state !== 'none') journal.push({ type: 'started', agentId: a.id, label: a.label, phase: a.phase });
        if (a.state === 'done') journal.push({ type: 'result', agentId: a.id, result: {} });
        if (a.state === 'failed') journal.push({ type: 'failed', agentId: a.id });
      }
      write(join(runDir, 'journal.jsonl'), jsonl(journal), mtime);
      if (record) write(join(base, 'workflows', `${runId}.json`), JSON.stringify({ runId, ...record }));
      if (script) write(join(base, 'workflows', 'scripts', `${script}-${runId}.js`), 'export const meta = {}');
    },
    /** A background job: jobs/<id>/state.json. @param {string} id @param {object} state */
    job(id, state) {
      return write(join(dir, 'jobs', id, 'state.json'), JSON.stringify(state));
    },
    /** The desktop app's record of a session. @param {object} session @param {number} [mtime] */
    desktopSession(session, mtime) {
      const id = /** @type {any} */ (session).sessionId ?? 'local_x';
      return write(join(desktop, 'claude-code-sessions', 'acct', 'org', `${id}.json`), JSON.stringify(session), mtime);
    },
    /**
     * The desktop app's samples of the plan's usage, as [time, session %, week %], oldest first.
     * @param {[number, number, number][]} samples @param {string} [base] the app's folder
     */
    planUsage(samples, base = desktop) {
      const json = { version: 2, samples: samples.map(([t, fh, sd]) => ({ t, org: 'org-1', u: { fh, sd } })) };
      return write(join(base, 'plan-usage-history.json'), JSON.stringify(json));
    },
  };
}
