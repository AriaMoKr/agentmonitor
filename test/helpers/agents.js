// Agents and snapshots made by hand, for the tests of what the monitor draws.
import { HOUR, MINUTE, NOW } from './fixture.js';

/**
 * @typedef {import('../../src/monitor.js').Agent} Agent
 * @typedef {import('../../src/monitor.js').Snapshot} Snapshot
 */

/**
 * An agent with every field the views read; `o` sets those a test is about.
 * @param {Partial<Agent>} o
 * @returns {Agent}
 */
export function agent(o) {
  const title = o.title ?? 'untitled';
  return {
    key: `s:${title}`, type: 'session', state: 'idle', live: true, title,
    activity: '', activityKind: '', activityAt: 0, lastActive: NOW - MINUTE,
    pending: [], events: [], children: [],
    ...o,
  };
}

/**
 * @param {Agent[]} rows
 * @param {Partial<Snapshot>} [o]
 * @returns {Snapshot}
 */
export function snapshot(rows, o = {}) {
  return { at: NOW, dir: '/home/me/.claude', windowMs: 24 * HOUR, found: true, rows, ...o };
}
