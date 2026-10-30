// Whether the process a registry record names still runs, and is still Claude Code: a record
// outlives a process that crashed, and its PID can then be another program's.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { lastPart } from './format.js';

/**
 * @typedef {{ name: string, memKB: number }} ProcessInfo
 * @typedef {Map<number, ProcessInfo>} ProcessTable
 */

/**
 * Whether a process with this PID exists (EPERM: it does, but is not ours to signal).
 * @param {number} pid
 */
export function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Whether a record's PID can be looked up here. Claude Code writes the PID domain it ran in,
 * 'win32:<host>' on Windows; a record from elsewhere (Windows seen from WSL, another machine
 * sharing the folder) names a PID that means nothing here.
 * @param {string | undefined} pidDomain
 * @param {string} [platform]
 * @param {string} [host]
 */
export function sameDomain(pidDomain, platform = process.platform, host = hostname()) {
  if (!pidDomain) return true;
  if (platform === 'win32') return pidDomain.toLowerCase() === `win32:${host.toLowerCase()}`;
  return !/^win32:[^:]*$/.test(pidDomain);
}

/**
 * Whether a program can be Claude Code: its own binary, or the Node or Bun that runs it.
 * @param {string} name
 */
export function looksLikeClaude(name) {
  return /claude|node|bun/i.test(lastPart(name));
}

/**
 * The running processes' program names and memory by PID, from tasklist on Windows and ps
 * elsewhere; empty when that fails.
 * @param {string} [platform]
 * @returns {Promise<ProcessTable>}
 */
export async function processTable(platform = process.platform) {
  try {
    if (platform === 'win32') return parseTasklist(await run('tasklist', ['/FO', 'CSV', '/NH']));
    return parsePs(await run('ps', ['-A', '-o', 'pid=', '-o', 'rss=', '-o', 'comm=']));
  } catch {
    return new Map();
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000, maxBuffer: 32 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

/**
 * `tasklist /FO CSV /NH`: "name","pid","session","#","mem K" per line.
 * @param {string} text
 * @returns {ProcessTable}
 */
export function parseTasklist(text) {
  /** @type {ProcessTable} */
  const table = new Map();
  for (const line of text.split(/\r?\n/)) {
    const f = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const pid = Number(f[1]);
    if (f.length >= 5 && Number.isInteger(pid)) table.set(pid, { name: f[0], memKB: Number(f[4].replace(/\D/g, '')) || 0 });
  }
  return table;
}

/**
 * `ps -A -o pid= -o rss= -o comm=`: pid, resident KB and the command per line.
 * @param {string} text
 * @returns {ProcessTable}
 */
export function parsePs(text) {
  /** @type {ProcessTable} */
  const table = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { name: m[3], memKB: Number(m[2]) });
  }
  return table;
}
