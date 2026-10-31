// Puts together what the monitor shows: every Claude Code session that runs, or was active
// within the window, with its state, title, folder, model, context, current activity and task
// list, and the subagents and workflow runs it started. Sources, all under the config folder (~/.claude):
// sessions/<pid>.json (the running processes and their status), projects/*/<session>.jsonl (the
// transcripts) and the agents' files beside them, and jobs/*/state.json (background sessions);
// with the desktop app's own records of its sessions for titles, settings, which are unread, and
// the app's summary of each one's last turn; and its samples of the plan's usage, carried on to
// now with what the replies in the transcripts used since.
import { join } from 'node:path';
import { SessionAgents } from './agents.js';
import { DesktopSessions, desktopDataDirs } from './desktop.js';
import { entries, JsonFiles, statOf } from './files.js';
import { clean, kindLabel, lastPart } from './format.js';
import { Jobs } from './jobs.js';
import { Ledger } from './ledger.js';
import { isRunning, looksLikeClaude, processTable, sameDomain } from './procs.js';
import { Registry } from './registry.js';
import { Transcript } from './transcript.js';
import { PlanUsage } from './usage.js';

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** How often the process table is read again for the processes' memory (ms). */
const TABLE_MAX_AGE = 10_000;
/** A transcript written this recently, by no process the registry knows, may still be live. */
const RECENT_WRITE = 60_000;
/** An agent without an end on record, quiet this long, is taken to have ended. */
const STALE_AGENT = 15 * 60_000;
/** A tool call pending this long is waited on: a command, a build, a download (ms). */
const TOOL_WAIT = 3000;
/** The tools that start an agent: what the agent does is listed under it. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * A string from the files, as it may be drawn (see clean), or undefined when there is none.
 * @param {unknown} v
 */
const safe = (v) => (typeof v === 'string' && clean(v)) || undefined;

/**
 * @typedef {import('./registry.js').RegistryEntry} RegistryEntry
 * @typedef {import('./transcript.js').Info} Info
 * @typedef {import('./transcript.js').Event} Event
 * @typedef {import('./transcript.js').Cost} Cost
 * @typedef {import('./agents.js').AgentFile} AgentFile
 * @typedef {import('./agents.js').WorkflowRun} WorkflowRun
 *
 * @typedef {'working' | 'waiting' | 'idle' | 'active' | 'running' | 'done' | 'failed' | 'stopped' | 'ended'} State
 *   working, waiting, idle: a running session's status; active: written to moments ago by a
 *   process not in the registry; running: an agent or workflow at work; the rest: over
 *
 * @typedef {'tool' | 'thinking' | 'agents' | 'waiting' | 'blocked' | 'background' | 'error' | 'summary' | 'reply' | 'prompt' | 'job' | ''} ActivityKind
 *   blocked and summary: from the desktop app's summary of the last turn; background: a
 *   command that goes on in the background of a session not at work
 *
 * @typedef {{ steps: import('./transcript.js').Step[], at: number, current: boolean }} Plan a
 *   task list as of its last change; current: changed since the last prompt, in this turn
 *
 * @typedef {{ category: string, detail: string, needs?: string }} Turn the desktop app's summary
 *   of a session's last turn: its category ('completed', 'blocked', 'review_ready'...), what it
 *   came to, and what you are to do when it is blocked
 *
 * @typedef {object} Agent
 * @property {string} key the same on every refresh
 * @property {'session' | 'subagent' | 'workflow' | 'agent'} type agent: a workflow's
 * @property {State} state
 * @property {boolean} live a process runs it
 * @property {string} title
 * @property {string} activity what it is doing, or what it did last, in one line
 * @property {ActivityKind} activityKind
 * @property {number} activityAt since when (ms; 0 when unknown)
 * @property {boolean} [inTool] it waits on a tool call it made, one that has run a while: a
 *   command, a build, a download (not one starting an agent: that agent is listed under it)
 * @property {number} lastActive when it last did anything (ms)
 * @property {number} [startedAt]
 * @property {number} [processStartedAt] when the process running the session started
 * @property {string} [sessionId]
 * @property {string} [agentId]
 * @property {string} [runId]
 * @property {number} [pid]
 * @property {number} [memKB]
 * @property {string} [cwd]
 * @property {string} [project] the folder's last part
 * @property {string} [branch]
 * @property {string} [kind] how the session was started: desktop, cli, vscode, sdk, bg
 * @property {string} [version]
 * @property {string} [model]
 * @property {string} [effort] the reasoning effort it works at: 'low', 'medium', 'high',
 *   'xhigh', 'max'
 * @property {boolean} [ultracode] a session's: the desktop app's setting, else a reminder of it
 *   read in the transcript (sent with some prompts only, so it can be missed)
 * @property {string} [permissionMode]
 * @property {number} [ctx] tokens of context in the last reply
 * @property {number} [outTokens] output tokens in the part of the transcript read
 * @property {Cost} [cost]
 * @property {string} [waitingFor]
 * @property {string} [agentType]
 * @property {string} [phase] a workflow's, or a workflow agent's
 * @property {boolean} [background] a subagent started in the background
 * @property {{ running: number, done: number, failed: number, total: number }} [counts] a workflow's agents
 * @property {number} [tokens] a finished workflow's total
 * @property {number} [durationMs] a finished workflow's
 * @property {string} [transcript]
 * @property {number} [transcriptSize]
 * @property {boolean} [archived] in the desktop app
 * @property {boolean} [unread] the desktop app shows it unread, with its blue dot: a session not
 *   at work whose last turn ended while another one was open there
 * @property {number} [openedAt] when it was last opened in the desktop app
 * @property {Turn} [turn] of a session not at work, when it sums up the transcript's last reply
 * @property {boolean} [blocked] its turn ended on something only you can do, as `turn` says
 * @property {string} [hostSessionId] the desktop app's ID for the session
 * @property {import('./jobs.js').Job} [job]
 * @property {{ summary: string, ts: number }[]} pending tool calls waiting for their result
 * @property {{ summary: string, ts: number }[]} [commands] the commands it started that go on in
 *   the background, while it runs: not known to have ended
 * @property {Plan} [plan] its task list
 * @property {Event[]} events the latest, oldest first
 * @property {Agent[]} children
 *
 * @typedef {object} Snapshot
 * @property {number} at
 * @property {string} dir
 * @property {number} windowMs
 * @property {boolean} found whether the config folder holds sessions or transcripts
 * @property {Agent[]} rows the sessions, each with its agents as children
 * @property {import('./usage.js').Usage} [usage] how much of the plan's usage limits is used, as
 *   the desktop app last sampled it, and as carried on to now
 */

/** The states of something still at work, or waiting to be. */
export const LIVE_STATES = new Set(['working', 'waiting', 'idle', 'active', 'running']);

export class Monitor {
  /**
   * @param {object} o
   * @param {string} o.dir the Claude Code config folder (~/.claude)
   * @param {number} o.windowMs how far back a session that ended still counts as recently active
   * @param {() => Promise<string[]>} [o.desktopDirs] the desktop app's data folders
   * @param {(pid: number) => boolean} [o.isRunning]
   * @param {() => Promise<import('./procs.js').ProcessTable>} [o.processTable]
   * @param {boolean} [o.wait] whether a refresh waits for what is read in the background (the
   *   replies the usage is carried on with): for a snapshot printed once
   */
  constructor({ dir, windowMs, desktopDirs = () => desktopDataDirs(), isRunning: running = isRunning, processTable: table = () => processTable(), wait = false }) {
    this.dir = dir;
    this.windowMs = windowMs;
    this.wait = wait;
    this.registry = new Registry(join(dir, 'sessions'));
    this.jobs = new Jobs(join(dir, 'jobs'));
    this.desktop = new DesktopSessions(desktopDirs);
    this.planUsage = new PlanUsage(desktopDirs, new Ledger(join(dir, 'projects')));
    this.sessionAgents = new SessionAgents();
    this.json = new JsonFiles();
    this.isRunning = running;
    this.readProcessTable = table;
    /** @type {import('./procs.js').ProcessTable} */
    this.table = new Map();
    this.tableAt = -Infinity;
    /** @type {Map<string, boolean>} whether a PID, with its start time, is Claude Code's */
    this.verified = new Map();
    /** @type {Map<string, number>} lookups of a PID the process table did not list */
    this.misses = new Map();
    /** @type {Map<string, Transcript>} */
    this.transcripts = new Map();
    /** @type {Set<string>} */
    this.usedTranscripts = new Set();
    /** @type {Set<string>} sessions seen running since the monitor started */
    this.seenLive = new Set();
    /** @type {Map<string, { mtimeMs: number, children: Agent[], used: boolean }>} agents of sessions that ended */
    this.endedAgents = new Map();
    /**
     * @type {Set<string>} the keys of agents whose transcripts are read though they are not at
     * work (those being looked at: one in the terminal, one for each web page), to show what they did
     */
    this.focus = new Set();
  }

  /**
   * Reads everything again (what changed) and returns what to show.
   * @param {number} [now]
   * @returns {Promise<Snapshot>}
   */
  async refresh(now = Date.now()) {
    this.usedTranscripts.clear();
    const [records, jobs, desktop, files, usage] = await Promise.all([
      this.registry.read(),
      this.jobs.read(),
      this.desktop.read(now),
      this.scanProjects(),
      this.planUsage.read(now, { wait: this.wait }),
    ]);
    const live = await this.liveness(records, now);
    const cutoff = now - this.windowMs;

    /** @typedef {{ id: string, records: RegistryEntry[], ended: RegistryEntry[], file?: TranscriptFile, job?: import('./jobs.js').Job }} Found */
    /** @type {Map<string, Found>} */
    const found = new Map();
    const want = (/** @type {string} */ id) => {
      let s = found.get(id);
      if (!s) found.set(id, (s = { id, records: [], ended: [] }));
      return s;
    };
    for (const r of records) if (r.sessionId && !r.spare && live.get(r)?.live) want(r.sessionId).records.push(r);
    for (const [id, f] of files) if (f.mtimeMs >= cutoff || found.has(id)) want(id).file = f;
    for (const job of jobs) {
      if (job.sessionId && (found.has(job.sessionId) || (job.updatedAt ?? 0) >= cutoff)) want(job.sessionId).job = job;
    }
    for (const r of records) if (r.sessionId && !live.get(r)?.live && found.has(r.sessionId)) want(r.sessionId).ended.push(r);

    // The window is checked again by the last record's time: a session's transcript also takes
    // records with no time (its cost, when the app quits), which change the file's.
    const rows = (await Promise.all([...found.values()].map((s) => this.sessionRows(s, live, desktop, now))))
      .flat()
      .filter((r) => r.live || r.state === 'active' || r.lastActive >= cutoff);

    for (const path of this.transcripts.keys()) if (!this.usedTranscripts.has(path)) this.transcripts.delete(path);
    for (const [dir, hit] of this.endedAgents) {
      if (!hit.used) this.endedAgents.delete(dir);
      else hit.used = false;
    }
    this.sessionAgents.sweep();
    this.json.sweep();
    return { at: now, dir: this.dir, windowMs: this.windowMs, found: files.size > 0 || records.length > 0, rows, usage };
  }

  /**
   * @typedef {{ path: string, sessionDir: string, size: number, mtimeMs: number }} TranscriptFile
   * Every session transcript, <config>/projects/<project>/<session>.jsonl, by session ID.
   * @returns {Promise<Map<string, TranscriptFile>>}
   */
  async scanProjects() {
    const root = join(this.dir, 'projects');
    /** @type {Map<string, TranscriptFile>} */
    const files = new Map();
    const projects = (await entries(root)).filter((e) => e.isDirectory());
    await Promise.all(projects.map(async (p) => {
      const dir = join(root, p.name);
      const names = (await entries(dir)).filter((e) => e.isFile() && SESSION_FILE.test(e.name)).map((e) => e.name);
      await Promise.all(names.map(async (name) => {
        const path = join(dir, name);
        const st = await statOf(path);
        if (!st) return;
        const id = name.slice(0, -'.jsonl'.length);
        const known = files.get(id);
        if (!known || st.mtimeMs > known.mtimeMs) {
          files.set(id, { path, sessionDir: path.slice(0, -'.jsonl'.length), size: st.size, mtimeMs: st.mtimeMs });
        }
      }));
    }));
    return files;
  }

  /**
   * Which registry records name a process that runs, and is Claude Code: the PID exists, and
   * the process table (read once per new PID, and every TABLE_MAX_AGE for memory) names a
   * program that can be Claude Code.
   * @param {RegistryEntry[]} records
   * @param {number} now
   * @returns {Promise<Map<RegistryEntry, { live: boolean, memKB?: number }>>}
   */
  async liveness(records, now) {
    const checks = records.map((r) => {
      const local = sameDomain(r.pidDomain);
      return { r, running: local && this.isRunning(r.pid), id: `${r.pid}:${r.procStart ?? r.startedAt ?? ''}` };
    });
    const unverified = checks.some((c) => c.running && !this.verified.has(c.id));
    if (unverified || (checks.some((c) => c.running) && now - this.tableAt > TABLE_MAX_AGE)) {
      this.table = await this.readProcessTable();
      this.tableAt = now;
    }
    /** @type {Map<RegistryEntry, { live: boolean, memKB?: number }>} */
    const out = new Map();
    const ids = new Set();
    for (const c of checks) {
      ids.add(c.id);
      const p = this.table.get(c.r.pid);
      if (c.running && !this.verified.has(c.id)) {
        if (p) this.verified.set(c.id, looksLikeClaude(p.name));
        else if (this.table.size > 0) {
          // Started after the table was read, or hidden from it: look again, three times at most.
          const misses = (this.misses.get(c.id) ?? 0) + 1;
          this.misses.set(c.id, misses);
          if (misses >= 3) this.verified.set(c.id, true);
          else this.tableAt = -Infinity;
        }
      }
      const live = c.running && this.verified.get(c.id) !== false;
      out.set(c.r, live && p ? { live, memKB: p.memKB } : { live });
    }
    for (const id of this.verified.keys()) if (!ids.has(id)) this.verified.delete(id);
    for (const id of this.misses.keys()) if (!ids.has(id)) this.misses.delete(id);
    return out;
  }

  /**
   * A transcript brought up to date.
   * @param {string} path
   * @param {{ size: number, mtimeMs: number }} st
   */
  async transcript(path, st) {
    let tx = this.transcripts.get(path);
    if (!tx) this.transcripts.set(path, (tx = new Transcript(path)));
    this.usedTranscripts.add(path);
    try {
      await tx.update(st);
    } catch {
      // Removed or locked meanwhile: keep what was read.
    }
    return tx;
  }

  /**
   * The rows for one session: one per process running it (rarely more than one), or one for a
   * session that ended.
   * @param {{ id: string, records: RegistryEntry[], ended: RegistryEntry[], file?: TranscriptFile, job?: import('./jobs.js').Job }} s
   * @param {Map<RegistryEntry, { live: boolean, memKB?: number }>} live
   * @param {Map<string, import('./desktop.js').DesktopSession>} desktop
   * @param {number} now
   * @returns {Promise<Agent[]>}
   */
  async sessionRows(s, live, desktop, now) {
    const tx = s.file ? await this.transcript(s.file.path, s.file) : null;
    const info = tx?.info;
    const isLive = s.records.length > 0;
    if (isLive) this.seenLive.add(s.id);
    const children = await this.childrenOf(s, isLive, info, now);
    const d = desktop.get(s.id);
    let titleFile;
    if (!info?.customTitle && !info?.aiTitle && !info?.agentName && !d?.title && s.file) {
      titleFile = (await this.json.read(join(s.file.sessionDir, 'custom-title.json')))?.customTitle;
    }
    const records = isLive ? s.records : [undefined];
    return records.map((record, i) => {
      const name = record?.name ?? s.ended[0]?.name;
      const derived = (record ?? s.ended[0])?.nameSource === 'derived';
      const title = [
        derived ? undefined : name, d?.title, info?.customTitle, info?.aiTitle, info?.agentName, info?.summary,
        titleFile, s.job?.name, name, tx?.head?.firstPrompt, info?.lastPrompt?.text,
      ].map(clean).find(Boolean) ?? '';
      /** @type {State} */
      let state;
      if (record) state = record.status === 'busy' ? 'working' : record.status === 'waiting' ? 'waiting' : record.status === 'idle' ? 'idle' : 'active';
      else state = !this.seenLive.has(s.id) && now - (info?.lastTs ?? 0) < RECENT_WRITE ? 'active' : 'ended';
      // At work for the registry, but the call it made asks you something.
      if (state === 'working' && askingOf(info)) state = 'waiting';
      const turn = state === 'idle' || state === 'ended' ? turnOf(d, info) : undefined;
      const act = activityOf(state, info, record, i === 0 ? children : [], turn, now);
      if (!record && s.job?.state && !act.text) {
        Object.assign(act, { kind: 'job', text: clean(`${s.job.state}: ${s.job.needs ?? s.job.detail ?? ''}`).replace(/:$/, ''), at: s.job.updatedAt ?? 0 });
      }
      const cwd = safe(record?.cwd ?? info?.cwd ?? d?.cwd ?? s.job?.cwd ?? s.ended[0]?.cwd);
      // At work, the effort of its turn; else the desktop app's setting, which its next turn takes.
      const atWork = state === 'working' || state === 'waiting' || state === 'active';
      return {
        key: i === 0 ? `s:${s.id}` : `s:${s.id}:${record?.pid}`,
        type: /** @type {const} */ ('session'),
        state,
        live: Boolean(record),
        title: title || '(new session)',
        activity: act.text,
        activityKind: act.kind,
        activityAt: act.at,
        inTool: act.inTool || undefined,
        lastActive: Math.max(info?.lastTs || (record ? 0 : s.file?.mtimeMs ?? 0), record?.statusUpdatedAt ?? 0, s.job?.updatedAt ?? 0),
        startedAt: tx?.head?.firstTs || info?.firstTs || s.job?.createdAt || record?.startedAt,
        processStartedAt: record?.startedAt,
        sessionId: clean(s.id),
        pid: record?.pid,
        memKB: record ? live.get(record)?.memKB : undefined,
        cwd,
        project: lastPart(cwd),
        branch: safe(info?.gitBranch),
        kind: kindLabel({ entrypoint: record?.entrypoint ?? info?.entrypoint ?? s.ended[0]?.entrypoint, kind: record?.kind ?? s.ended[0]?.kind }) || (s.job ? 'bg' : ''),
        version: safe(record?.version ?? info?.version),
        model: safe(info?.model ?? d?.model),
        effort: safe(atWork ? info?.effort ?? d?.effort : d?.effort ?? info?.effort),
        ultracode: (d?.ultracode ?? info?.ultracode) || undefined,
        permissionMode: safe(info?.permissionMode ?? d?.permissionMode),
        ctx: info?.ctx || undefined,
        outTokens: info?.outTokens || undefined,
        cost: info?.cost,
        waitingFor: safe(record?.waitingFor),
        transcript: s.file?.path,
        transcriptSize: s.file?.size,
        archived: d?.archived,
        unread: d ? (state === 'idle' || state === 'ended') && this.desktop.unread(d) : undefined,
        openedAt: d?.openedAt,
        turn,
        blocked: turn ? turn.category === 'blocked' : undefined,
        hostSessionId: safe(record?.hostSessionId ?? d?.id),
        job: s.job,
        pending: pendingOf(info),
        commands: record ? commandsOf(info) : undefined,
        plan: planOf(info),
        events: info?.events ?? [],
        children: i === 0 ? children : [],
      };
    });
  }

  /**
   * The subagents and workflow runs a session started that run, or were active within the
   * window. Read again on each refresh while the session runs; for one that ended, once per
   * change of its transcript.
   * @param {{ id: string, file?: TranscriptFile }} s
   * @param {boolean} live
   * @param {Info | undefined} info
   * @param {number} now
   * @returns {Promise<Agent[]>}
   */
  async childrenOf(s, live, info, now) {
    if (!s.file) return [];
    const dir = s.file.sessionDir;
    const hit = this.endedAgents.get(dir);
    const focused = [...this.focus].some((k) => k.startsWith(`a:${s.id}:`));
    let all;
    if (!live && hit && hit.mtimeMs === s.file.mtimeMs && !focused) {
      hit.used = true;
      all = hit.children;
    } else {
      const scan = await this.sessionAgents.scan(dir);
      all = await Promise.all([
        ...scan.subagents.map((f) => this.subagentRow(s.id, f, live, info, now)),
        ...scan.runs.map((run) => this.workflowRow(s.id, run, live, now)),
      ]);
      if (live) this.endedAgents.delete(dir);
      else if (!focused) this.endedAgents.set(dir, { mtimeMs: s.file.mtimeMs, children: all, used: true });
    }
    const cutoff = now - this.windowMs;
    return all.filter((c) => c.state === 'running' || c.lastActive >= cutoff).sort(byActivity);
  }

  /**
   * A subagent (the Agent tool). A background one says in its metadata when it finished or was
   * stopped; a foreground one has ended once the call that started it has its result.
   * @param {string} sessionId
   * @param {AgentFile} f
   * @param {boolean} parentLive
   * @param {Info | undefined} parent
   * @param {number} now
   * @returns {Promise<Agent>}
   */
  async subagentRow(sessionId, f, parentLive, parent, now) {
    const meta = f.meta ?? {};
    const background = meta.requestShape === 'background';
    /** @type {State} */
    let state;
    if (meta.finished) state = 'done';
    else if (meta.stoppedByUser) state = 'stopped';
    else if (!background && typeof meta.toolUseId === 'string' && parent) {
      state = !parent.pending.has(meta.toolUseId) ? 'done' : parentLive ? 'running' : 'ended';
    } else state = parentLive ? 'running' : 'ended';
    const key = `a:${sessionId}:${f.id}`;
    const tx = state === 'running' || this.focus.has(key) ? await this.transcript(f.path, f) : null;
    if (tx && state === 'running') state = settle(tx.info, f, now);
    const description = clean(meta.description);
    const agentType = clean(meta.agentType);
    return agentRow({
      key,
      type: 'subagent',
      title: description || agentType || f.id,
      state,
      f,
      tx,
      agentType,
      background,
      now,
    });
  }

  /**
   * A workflow run and its agents: what each agent did is in the run's journal, and the run's
   * record is written when it ends.
   * @param {string} sessionId
   * @param {WorkflowRun} run
   * @param {boolean} parentLive
   * @param {number} now
   * @returns {Promise<Agent>}
   */
  async workflowRow(sessionId, run, parentLive, now) {
    const status = typeof run.record?.status === 'string' ? run.record.status : undefined;
    const lastWrite = Math.max(run.journalMtime, ...run.agents.map((a) => a.mtimeMs), 0);
    /** @type {State} */
    let state;
    if (!run.record) state = parentLive && now - lastWrite < STALE_AGENT ? 'running' : 'ended';
    else if (status === 'running') state = parentLive ? 'running' : 'ended';
    else if (status === 'failed') state = 'failed';
    else if (/kill|stop|cancel|abort/i.test(status ?? '')) state = 'stopped';
    else state = 'done';
    const agents = await Promise.all(run.agents.map(async (f) => {
      const j = run.journal.get(f.id);
      /** @type {State} */
      let st = j?.state === 'done' ? 'done' : j?.state === 'failed' ? 'failed' : state === 'running' ? 'running' : 'ended';
      const key = `a:${sessionId}:${f.id}`;
      const tx = st === 'running' || this.focus.has(key) ? await this.transcript(f.path, f) : null;
      if (tx && st === 'running') st = settle(tx.info, f, now);
      return agentRow({
        key,
        type: 'agent',
        title: clean(j?.label) || clean(f.meta?.description) || f.id,
        state: st,
        f,
        tx,
        agentType: clean(f.meta?.agentType),
        phase: clean(j?.phase) || clean(f.meta?.workflowPhase) || undefined,
        now,
      });
    }));
    agents.sort(byActivity);
    const count = (/** @type {State} */ s) => agents.filter((a) => a.state === s).length;
    const counts = { running: count('running'), done: count('done'), failed: count('failed'), total: agents.length };
    const phase = agents.find((a) => a.state === 'running')?.phase ?? [...agents].sort((a, b) => b.lastActive - a.lastActive)[0]?.phase;
    const r = run.record ?? {};
    const startedAt = typeof r.startTime === 'number' ? r.startTime : Math.min(...run.agents.map((a) => a.mtimeMs), lastWrite) || undefined;
    let activity;
    if (state === 'running') {
      activity = `${phase ? `${phase}: ` : ''}${counts.running} running, ${counts.done + counts.failed}/${counts.total} done`;
    } else {
      activity = [status ?? state, `${counts.total} agent${counts.total === 1 ? '' : 's'}`, counts.failed ? `${counts.failed} failed` : ''].filter(Boolean).join(', ');
    }
    return {
      key: `w:${sessionId}:${run.runId}`,
      type: 'workflow',
      state,
      live: state === 'running',
      title: clean(run.name) || run.runId,
      activity,
      activityKind: state === 'running' ? 'agents' : '',
      activityAt: state === 'running' ? startedAt ?? 0 : 0,
      lastActive: lastWrite,
      startedAt,
      runId: run.runId,
      phase,
      counts,
      tokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
      model: safe(r.defaultModel),
      pending: [],
      events: [],
      children: agents,
    };
  }
}

/**
 * A running agent's state, corrected by its transcript: a final reply with no call pending
 * means it is done; nothing written for a long while with no call pending, that it ended.
 * @param {Info} info
 * @param {AgentFile} f
 * @param {number} now
 * @returns {State}
 */
function settle(info, f, now) {
  if (info.lastRole === 'assistant' && info.lastStop === 'end_turn' && info.pending.size === 0) return 'done';
  if (now - f.mtimeMs > STALE_AGENT && info.pending.size === 0) return 'ended';
  return 'running';
}

/**
 * A subagent's or workflow agent's row.
 * @param {{ key: string, type: 'subagent' | 'agent', title: string, state: State, f: AgentFile,
 *   tx: Transcript | null, agentType?: string, phase?: string, background?: boolean, now: number }} o
 * @returns {Agent}
 */
function agentRow({ key, type, title, state, f, tx, agentType, phase, background, now }) {
  const info = tx?.info;
  const act = activityOf(state, info, undefined, [], undefined, now);
  return {
    key,
    type,
    state,
    live: state === 'running',
    title,
    activity: act.text,
    activityKind: act.kind,
    activityAt: act.at,
    inTool: act.inTool || undefined,
    lastActive: Math.max(f.mtimeMs, info?.lastTs ?? 0),
    startedAt: tx?.head?.firstTs || info?.firstTs || undefined,
    agentId: f.id,
    agentType: agentType || undefined,
    phase,
    background,
    model: safe(info?.model),
    effort: safe(info?.effort),
    ctx: info?.ctx || undefined,
    outTokens: info?.outTokens || undefined,
    transcript: f.path,
    transcriptSize: f.size,
    pending: pendingOf(info),
    commands: state === 'running' ? commandsOf(info) : undefined,
    plan: planOf(info),
    events: info?.events ?? [],
    children: [],
  };
}

/**
 * The desktop app's summary of a session's last turn, when it sums up the transcript's last
 * reply: the app writes it a few seconds after a turn, and not after every one.
 * @param {import('./desktop.js').DesktopSession | undefined} d
 * @param {Info | undefined} info
 * @returns {Turn | undefined}
 */
function turnOf(d, info) {
  const s = d?.summary;
  if (!s?.for || s.for !== info?.lastAssistantUuid) return undefined;
  const turn = { category: clean(s.category), detail: clean(s.detail), needs: clean(s.needs) || undefined };
  return turn.detail || turn.needs ? turn : undefined;
}

/**
 * What a session waits on you for when a call it made asks you something: a question
 * (AskUserQuestion), a plan to approve (ExitPlanMode), the desktop app's offer of a session.
 * The desktop app asks these itself and keeps no file of them while they wait, nor of its
 * permission prompts, which the monitor cannot see.
 * @param {Info | undefined} info
 * @returns {{ text: string, ts: number } | undefined}
 */
function askingOf(info) {
  const calls = info ? [...info.pending.values()] : [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    let text;
    switch (c.name) {
      case 'AskUserQuestion': {
        const qs = Array.isArray(input.questions) ? input.questions : [];
        const first = clean(qs[0]?.question) || clean(qs[0]?.header);
        text = first ? `a question: ${first}${qs.length > 1 ? ` (+${qs.length - 1} more)` : ''}` : 'a question';
        break;
      }
      case 'ExitPlanMode':
        text = 'a plan to approve';
        break;
      case 'mcp__ccd_session__start_session':
        if (input.initiation === 'offer') text = clean(input.title) ? `a session offer: ${clean(input.title)}` : 'a session offer';
        break;
    }
    if (text) return { text, ts: c.ts };
  }
  return undefined;
}

/**
 * What a session or agent is doing in its state, or what it did last.
 * @param {State} state
 * @param {Info | undefined} info
 * @param {RegistryEntry | undefined} record
 * @param {Agent[]} children
 * @param {Turn} [turn] the desktop app's summary of the last turn
 * @param {number} [now]
 * @returns {{ kind: ActivityKind, text: string, at: number, inTool?: boolean }}
 */
export function activityOf(state, info, record, children, turn, now = 0) {
  if (state === 'waiting') {
    const ask = askingOf(info);
    if (ask) return { kind: 'waiting', text: `waiting: ${ask.text}`, at: ask.ts };
    return { kind: 'waiting', text: `waiting: ${clean(record?.waitingFor) || 'for you'}`, at: record?.statusUpdatedAt ?? 0 };
  }
  if (state === 'working' || state === 'running' || state === 'active') {
    const calls = info ? [...info.pending.values()] : [];
    if (calls.length) {
      const last = calls[calls.length - 1];
      const text = last.summary + (calls.length > 1 ? ` (+${calls.length - 1} more)` : '');
      return { kind: 'tool', text, at: last.ts, inTool: !AGENT_TOOLS.has(last.name) && now - last.ts >= TOOL_WAIT && !askingOf(info) };
    }
    const running = children.filter((c) => c.state === 'running');
    if (running.length && (!info || info.lastStop === 'end_turn')) {
      const since = Math.min(...running.map((c) => c.startedAt ?? c.lastActive));
      return { kind: 'agents', text: `${running.length} agent${running.length === 1 ? '' : 's'} running`, at: since };
    }
    if (state !== 'active') return { kind: 'thinking', text: 'thinking', at: info?.lastTs || record?.statusUpdatedAt || 0 };
  }
  if (info?.apiError && info.lastRole === 'assistant' && info.apiError.ts >= info.lastTs - 1000) {
    return { kind: 'error', text: info.apiError.text, at: info.apiError.ts };
  }
  const at = info?.lastReply?.ts || info?.lastTs || 0;
  if (turn?.category === 'blocked') return { kind: 'blocked', text: `blocked: ${turn.needs || turn.detail}`, at };
  // A session that runs, its turn over, with a command still going on in the background.
  const commands = record ? commandsOf(info) : [];
  if (commands.length) {
    const last = commands[commands.length - 1];
    return { kind: 'background', text: `background: ${last.summary}${commands.length > 1 ? ` (+${commands.length - 1} more)` : ''}`, at: last.ts };
  }
  if (turn?.detail) return { kind: 'summary', text: turn.detail, at };
  if (info?.lastReply) return { kind: 'reply', text: info.lastReply.text, at: info.lastReply.ts };
  if (info?.lastPrompt) return { kind: 'prompt', text: info.lastPrompt.text, at: info.lastPrompt.ts };
  return { kind: '', text: '', at: 0 };
}

/**
 * @param {Info | undefined} info
 * @returns {{ summary: string, ts: number }[]}
 */
function pendingOf(info) {
  return info ? [...info.pending.values()].map((c) => ({ summary: c.summary, ts: c.ts })) : [];
}

/**
 * @param {Info | undefined} info
 * @returns {{ summary: string, ts: number }[]}
 */
function commandsOf(info) {
  return info ? [...info.commands.values()].map((c) => ({ summary: c.summary, ts: c.ts })) : [];
}

/**
 * @param {Info | undefined} info
 * @returns {Plan | undefined}
 */
function planOf(info) {
  if (!info?.plan?.steps.length) return undefined;
  return { steps: info.plan.steps, at: info.plan.ts, current: info.plan.ts >= (info.lastPrompt?.ts ?? 0) };
}

/**
 * Running first, then the most recently active.
 * @param {Agent} a
 * @param {Agent} b
 */
function byActivity(a, b) {
  return Number(b.state === 'running') - Number(a.state === 'running') || b.lastActive - a.lastActive;
}
