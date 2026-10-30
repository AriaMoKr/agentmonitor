// The agents a session starts, kept beside its transcript in <project>/<session>/: subagents
// (the Agent tool) as subagents/agent-<id>.jsonl with agent-<id>.meta.json, and workflow runs as
// subagents/workflows/<run>/ (each agent's transcript and meta, and journal.jsonl: which agents
// started, returned or failed), with workflows/<run>.json, the run's record once it ended, and
// workflows/scripts/<name>-<run>.js, its script.
import { join } from 'node:path';
import { entries, JsonFiles, statOf, TextFiles } from './files.js';

/**
 * @typedef {object} AgentFile
 * @property {string} id
 * @property {string} path the agent's transcript
 * @property {number} size
 * @property {number} mtimeMs
 * @property {Record<string, any> | null} meta agentType, description, toolUseId, requestShape
 *   ('foreground' or 'background'), workflowPhase, and finished or stoppedByUser once it ended
 *
 * @typedef {{ state: 'running' | 'done' | 'failed', label?: string, phase?: string }} JournalEntry
 *
 * @typedef {object} WorkflowRun
 * @property {string} runId
 * @property {string} [name]
 * @property {Record<string, any> | null} record workflows/<run>.json: status, workflowName,
 *   startTime, durationMs, agentCount, totalTokens...
 * @property {Map<string, JournalEntry>} journal by agent ID
 * @property {number} journalMtime
 * @property {AgentFile[]} agents
 */

export class SessionAgents {
  constructor() {
    this.json = new JsonFiles();
    this.text = new TextFiles();
  }

  /**
   * @param {string} sessionDir <project>/<session>
   * @returns {Promise<{ subagents: AgentFile[], runs: WorkflowRun[] }>}
   */
  async scan(sessionDir) {
    const subDir = join(sessionDir, 'subagents');
    const recordsDir = join(sessionDir, 'workflows');
    const scripts = (await entries(join(recordsDir, 'scripts'))).map((e) => e.name);
    const runDirs = (await entries(join(subDir, 'workflows'))).filter((e) => e.isDirectory());
    const [subagents, runs] = await Promise.all([
      this.agentFiles(subDir),
      Promise.all(runDirs.map(async (e) => {
        const dir = join(subDir, 'workflows', e.name);
        const journalPath = join(dir, 'journal.jsonl');
        const journalStat = await statOf(journalPath);
        const [lines, record, agents] = await Promise.all([
          this.text.lines(journalPath, journalStat),
          this.json.read(join(recordsDir, `${e.name}.json`)),
          this.agentFiles(dir),
        ]);
        const script = scripts.find((n) => n.endsWith(`-${e.name}.js`));
        const name = typeof record?.workflowName === 'string' ? record.workflowName : script?.slice(0, -(e.name.length + 4));
        /** @type {WorkflowRun} */
        const run = { runId: e.name, name, record, journal: parseJournal(lines), journalMtime: journalStat?.mtimeMs ?? 0, agents };
        return run;
      })),
    ]);
    return { subagents, runs };
  }

  /**
   * The agent transcripts in a folder, with their metadata, oldest first.
   * @param {string} dir
   * @returns {Promise<AgentFile[]>}
   */
  async agentFiles(dir) {
    const found = await Promise.all((await entries(dir)).map(async (e) => {
      const m = /^agent-(.+)\.jsonl$/.exec(e.name);
      if (!m || !e.isFile()) return null;
      const path = join(dir, e.name);
      const [st, meta] = await Promise.all([statOf(path), this.json.read(join(dir, `agent-${m[1]}.meta.json`))]);
      return st ? { id: m[1], path, size: st.size, mtimeMs: st.mtimeMs, meta: meta && typeof meta === 'object' ? meta : null } : null;
    }));
    return /** @type {AgentFile[]} */ (found.filter(Boolean)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  /** Forgets the files not read since the last sweep. */
  sweep() {
    this.json.sweep();
    this.text.sweep();
  }
}

/**
 * A workflow's journal: which agents started (with their label and phase), returned or failed.
 * @param {string[]} lines
 * @returns {Map<string, JournalEntry>}
 */
export function parseJournal(lines) {
  /** @type {Map<string, JournalEntry>} */
  const agents = new Map();
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o.agentId !== 'string') continue;
    const known = agents.get(o.agentId);
    if (o.type === 'started') agents.set(o.agentId, { state: 'running', label: o.label, phase: o.phase });
    else if (o.type === 'result') agents.set(o.agentId, { ...known, state: 'done' });
    else if (o.type === 'failed') agents.set(o.agentId, { ...known, state: 'failed' });
  }
  return agents;
}
