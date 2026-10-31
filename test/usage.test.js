import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlanUsage, sessionReset, usageOf, weekReset } from '../src/usage.js';
import { HOUR, makeConfig, MINUTE, NOW } from './helpers/fixture.js';

const SESSION = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

/**
 * A usage's time and percents, without its resets.
 * @param {import('../src/usage.js').Usage | undefined} u
 */
const brief = (u) => u && { at: u.at, ...(u.session !== undefined ? { session: u.session } : {}), ...(u.week !== undefined ? { week: u.week } : {}) };

/**
 * Percents at so many minutes before NOW, oldest first.
 * @param {...[number, number]} a
 */
const points = (...a) => a.map(([m, v]) => ({ t: NOW - m * MINUTE, v }));

test('the latest of the desktop app\'s samples of the usage, in whole percent; what is not a sample is left out', () => {
  const file = {
    version: 2,
    samples: [
      { t: NOW - 30 * MINUTE, org: 'o', u: { fh: 50, sd: 20 } },
      { t: NOW - 15 * MINUTE, org: 'o', u: { fh: 64, sd: 29 } },
      { t: NOW - 45 * MINUTE, org: 'o', u: { fh: 90, sd: 99 } },
    ],
  };
  assert.deepEqual(brief(usageOf(file)), { at: NOW - 15 * MINUTE, session: 64, week: 29 }, 'the latest, wherever it is');
  assert.deepEqual(brief(usageOf({ samples: [{ t: NOW, u: { fh: 12.6 } }] })), { at: NOW, session: 13 });
  assert.deepEqual(brief(usageOf({ samples: [{ t: NOW, u: { sd: 100 } }] })), { at: NOW, week: 100 });
  const odd = [{ t: NOW - 1, u: { fh: 5, sd: 1 } }, { t: NOW, u: { fh: '7', sd: -1 } }, { t: '1', u: { fh: 1 } }, null, 3, { t: NOW + 1 }, { t: NOW + 2, u: null }];
  assert.deepEqual(brief(usageOf({ samples: odd })), { at: NOW - 1, session: 5, week: 1 }, 'none of the later ones has a time and a percent');
  for (const junk of [undefined, null, 42, 'text', [], {}, { samples: {} }, { samples: [] }]) assert.equal(usageOf(junk), undefined, JSON.stringify(junk));
});

test('the session resets five hours after its window began: about the last sample before its percent rose from 0, or between the two it dropped between', () => {
  assert.deepEqual(
    sessionReset(points([135, 0], [120, 0], [105, 5], [90, 12], [75, 30])),
    { at: NOW - 120 * MINUTE + SESSION, from: NOW - 120 * MINUTE + SESSION, to: NOW - 105 * MINUTE + SESSION },
    'rose from 0: likeliest with the last 0, by the first sample after',
  );
  assert.deepEqual(
    sessionReset(points([60, 80], [45, 3], [30, 9])),
    { at: NOW - 52.5 * MINUTE + SESSION, from: NOW - 60 * MINUTE + SESSION, to: NOW - 45 * MINUTE + SESSION },
    'dropped, a reset and a new window: likeliest halfway',
  );
  // Where the samples don't show its start: within the five hours before the last sample, and by
  // the first sample of those it is sure of.
  /** @param {number} first minutes before NOW @param {number} last */
  const unknown = (first, last) => ({ at: (NOW - last * MINUTE - SESSION + NOW - first * MINUTE) / 2 + SESSION, from: NOW - last * MINUTE, to: NOW - first * MINUTE + SESSION });
  assert.deepEqual(sessionReset(points([30, 10], [15, 20])), unknown(30, 15), 'the samples begin');
  assert.deepEqual(sessionReset(points([200, 0], [120, 4], [105, 6])), unknown(120, 105), 'more than 45 minutes between two samples');
  const long = Array.from({ length: 25 }, (_, i) => /** @type {[number, number]} */ ([360 - 15 * i, i + 1]));
  assert.deepEqual(sessionReset(points(...long)), unknown(285, 0), 'above 0 for five hours: a reset it grew back from came between');
  assert.equal(sessionReset(points([30, 5], [15, 0])), undefined, 'at 0%, no window');
  assert.equal(sessionReset([]), undefined);
});

test('the week resets at the time of the week two drops or more agree on, on the hour in it', () => {
  const R = NOW - 10 * HOUR; // a Thursday, 10:00 UTC
  /** In time order. @param {{ t: number, v: number }[]} p */
  const sorted = (p) => [...p].sort((a, b) => a.t - b.t);
  /** Samples at 80% before these resets and 1% after. @param {number[]} resets */
  const around = (resets) => resets.flatMap((r) => [{ t: r - 10 * MINUTE, v: 80 }, { t: r + 5 * MINUTE, v: 1 }]);
  /** The reset at r, as those samples pin it down. @param {number} r */
  const at = (r) => ({ at: r, from: r - 9 * MINUTE, to: r + 5 * MINUTE });
  assert.deepEqual(weekReset(around([R - 2 * WEEK, R - WEEK, R])), at(R + WEEK), 'the last just came: the next is a week on');
  assert.deepEqual(weekReset([...around([R - 2 * WEEK, R - WEEK]), { t: R - HOUR, v: 70 }]), at(R), 'not yet this week');
  assert.equal(weekReset([...around([R - WEEK]), { t: R - HOUR, v: 70 }]), undefined, 'a drop alone');
  assert.equal(weekReset(points([60, 30], [30, 29], [15, 31])), undefined, 'no drop: 1 point down is not one');
  const once = around([R - WEEK - 2 * 24 * HOUR - 3 * HOUR]);
  assert.deepEqual(weekReset(sorted([...around([R - 2 * WEEK, R - WEEK]), ...once, { t: R - HOUR, v: 70 }])), at(R), 'a reset once, on another day, outvoted');
  assert.deepEqual(weekReset(sorted([...around([R - 3 * WEEK]), ...once, ...around([R - 2 * WEEK - 2 * 24 * HOUR - 3 * HOUR]), { t: R - HOUR, v: 70 }])), at(R - 2 * 24 * HOUR - 3 * HOUR + WEEK), 'two agree');
  // Far apart, the samples around each drop: what they agree on, on the hour nearest its middle.
  const wide = [{ t: R - 2 * WEEK - 18 * HOUR, v: 70 }, { t: R - 2 * WEEK + 2 * HOUR, v: 0 }, { t: R - WEEK - 3 * HOUR, v: 60 }, { t: R - WEEK + 15 * HOUR, v: 4 }, { t: R - HOUR, v: 50 }];
  assert.deepEqual(weekReset(wide), { at: R, from: R - 3 * HOUR + MINUTE, to: R + 2 * HOUR });
  // At the turn of the week as the minutes count it (Thursday, 0:00 UTC).
  const T = R - 10 * HOUR;
  assert.deepEqual(weekReset([...around([T - WEEK, T]), { t: T + HOUR, v: 5 }]), at(T + WEEK));
  assert.equal(weekReset([]), undefined);
});

test('the resets come from the samples of the latest one\'s org', () => {
  const file = {
    samples: [
      { t: NOW - 30 * MINUTE, org: 'b', u: { fh: 50, sd: 20 } },
      { t: NOW - 20 * MINUTE, org: 'a', u: { fh: 90, sd: 90 } },
      { t: NOW - 10 * MINUTE, org: 'b', u: { fh: 55, sd: 21 } },
    ],
  };
  // Taken with a's, b's 55% after a's 90% would be a drop: a window begun 20 minutes ago.
  assert.equal(usageOf(file)?.sessionReset?.from, NOW - 10 * MINUTE);
});

test('the latest sample in any of the app\'s folders, read again after 5 seconds, and worked out again only when a file changed', async (t) => {
  const cfg = makeConfig(t);
  const other = join(cfg.root, 'other-app');
  cfg.planUsage([[NOW - 20 * MINUTE, 40, 10], [NOW - 5 * MINUTE, 64, 29]]);
  cfg.planUsage([[NOW - 10 * MINUTE, 70, 30]], other);
  const usage = new PlanUsage(async () => [cfg.desktop, join(cfg.root, 'missing'), other]);
  assert.deepEqual(brief(await usage.read(NOW)), { at: NOW - 5 * MINUTE, session: 64, week: 29 });
  cfg.planUsage([[NOW - MINUTE, 66, 30]]);
  assert.deepEqual(brief(await usage.read(NOW + 1000)), { at: NOW - 5 * MINUTE, session: 64, week: 29 }, 'not within 5 seconds');
  const read = await usage.read(NOW + 5000);
  assert.deepEqual(brief(read), { at: NOW - MINUTE, session: 66, week: 30 });
  // Being written, it holds no JSON for a moment: the last good one stands, not worked out again.
  cfg.write(join(cfg.desktop, 'plan-usage-history.json'), '{"version":2,"samp');
  assert.equal(await usage.read(NOW + 10_000), read);
  assert.equal(await new PlanUsage(async () => [join(cfg.root, 'missing')]).read(NOW), undefined, 'no app, no usage');
});
