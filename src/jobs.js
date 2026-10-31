// Background sessions run by Claude Code's daemon: <config>/jobs/<id>/state.json, with what the
// job is doing ('working', 'blocked' on a question...), its title and the session it runs.
import { join } from 'node:path';
import { entries, JsonFiles } from './files.js';
import { clean } from './format.js';

/**
 * @typedef {object} Job
 * @property {string} id the job folder's name (the daemon's short ID)
 * @property {string} [sessionId]
 * @property {string} [name]
 * @property {string} [state] 'working', 'blocked', 'done'...
 * @property {string} [detail]
 * @property {string} [needs] what a blocked job asks
 * @property {string} [cwd]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 * @property {string} [version]
 */

export class Jobs {
  /** @param {string} dir <config>/jobs */
  constructor(dir) {
    this.dir = dir;
    this.files = new JsonFiles();
  }

  /** @returns {Promise<Job[]>} */
  async read() {
    const ids = (await entries(this.dir)).filter((e) => e.isDirectory()).map((e) => e.name);
    const raws = await Promise.all(ids.map((id) => this.files.read(join(this.dir, id, 'state.json'))));
    this.files.sweep();
    /** @type {Job[]} */
    const jobs = [];
    raws.forEach((o, i) => {
      if (o && typeof o === 'object') jobs.push(toJob(ids[i], o));
    });
    return jobs;
  }
}

/**
 * @param {string} id
 * @param {Record<string, any>} o
 * @returns {Job}
 */
export function toJob(id, o) {
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined);
  // What is drawn as it is, safe to.
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' && clean(v)) || undefined;
  const time = (/** @type {unknown} */ v) => (typeof v === 'string' ? Date.parse(v) || undefined : typeof v === 'number' ? v : undefined);
  return {
    id: clean(id),
    sessionId: str(o.sessionId),
    name: text(o.name),
    state: text(o.state),
    detail: text(o.detail),
    needs: text(o.needs),
    cwd: str(o.cwd),
    createdAt: time(o.createdAt),
    updatedAt: time(o.updatedAt),
    version: str(o.cliVersion),
  };
}
