// Claude Code's registry of running sessions: <config>/sessions/<pid>.json, written by every
// Claude Code process while it runs (in a terminal, the desktop app's Code tab, an IDE, or the
// background) and removed when it exits. Each names its session, folder and title, and its
// status: 'busy', 'waiting' (and what for: a permission, an answer) or 'idle'.
import { join } from 'node:path';
import { entries, JsonFiles } from './files.js';

/**
 * @typedef {object} RegistryEntry
 * @property {number} pid
 * @property {string} [sessionId]
 * @property {string} [cwd]
 * @property {number} [startedAt] when the process started (ms)
 * @property {string} [procStart] the process's start time as the OS gives it (to tell a reused PID)
 * @property {string} [version] Claude Code's
 * @property {string} [kind] 'interactive', or a background kind
 * @property {string} [entrypoint] 'cli', 'claude-desktop', 'claude-vscode', 'sdk-cli'...
 * @property {string} [hostSessionId] the desktop app's ID for the session
 * @property {string} [pidDomain] where the PID means something: 'win32:<host>' on Windows
 * @property {string} [name] the session's title
 * @property {string} [nameSource]
 * @property {string} [status] 'busy', 'waiting' or 'idle'
 * @property {string} [waitingFor] with 'waiting': what for
 * @property {number} [updatedAt]
 * @property {number} [statusUpdatedAt]
 * @property {string} [jobId] a background job's
 * @property {boolean} spare a process started ahead of a session, not running one yet
 */

export class Registry {
  /** @param {string} dir <config>/sessions */
  constructor(dir) {
    this.dir = dir;
    this.files = new JsonFiles();
  }

  /** @returns {Promise<RegistryEntry[]>} */
  async read() {
    const names = (await entries(this.dir)).filter((e) => e.isFile() && /^\d+\.json$/.test(e.name)).map((e) => e.name);
    const raws = await Promise.all(names.map((name) => this.files.read(join(this.dir, name))));
    this.files.sweep();
    /** @type {RegistryEntry[]} */
    const out = [];
    raws.forEach((raw, i) => {
      if (raw && typeof raw === 'object') out.push(toEntry(raw, Number(names[i].slice(0, -5))));
    });
    return out;
  }
}

/**
 * A registry record with each field checked.
 * @param {Record<string, any>} o
 * @param {number} pidFromName
 * @returns {RegistryEntry}
 */
export function toEntry(o, pidFromName) {
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined);
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    pid: Number.isInteger(o.pid) && o.pid > 0 ? o.pid : pidFromName,
    sessionId: str(o.sessionId),
    cwd: str(o.cwd),
    startedAt: num(o.startedAt),
    procStart: str(o.procStartFt) ?? str(o.procStart),
    version: str(o.version),
    kind: str(o.kind),
    entrypoint: str(o.entrypoint),
    hostSessionId: str(o.hostSessionId),
    pidDomain: str(o.pidDomain),
    name: str(o.name),
    nameSource: str(o.nameSource),
    status: str(o.status),
    waitingFor: str(o.waitingFor),
    updatedAt: num(o.updatedAt),
    statusUpdatedAt: num(o.statusUpdatedAt),
    jobId: str(o.jobId),
    spare: o.spare === true,
  };
}
