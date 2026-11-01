import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlanUsage, repliesSince, sessionReset, track, usageOf, weekReset } from '../src/usage.js';
import { HOUR, makeConfig, MINUTE, NOW } from './helpers/fixture.js';

const SESSION = 5 * HOUR;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

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

/**
 * Replies at so many minutes before NOW, oldest first, each asked for as it was written, with
 * what it used; known from eight hours back.
 * @param {...[number, number]} a
 * @returns {import('../src/ledger.js').Replies}
 */
const known = (...a) => ({ from: NOW - 8 * HOUR, replies: a.map(([m, x]) => ({ t: NOW - m * MINUTE, asked: NOW - m * MINUTE, x })) });

/** A reset `m` minutes from NOW, as the session's are carried on: then, to the minute. @param {number} m */
const ends = (m) => ({ at: NOW + m * MINUTE, from: NOW + m * MINUTE, to: NOW + m * MINUTE });

/** Replies while the samples below rose 30 points: 1 point for each thousand. @type {[number, number][]} */
const ROSE = [[160, 1000], [140, 10_000], [125, 10_000], [110, 10_000]];

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

test('the session resets five hours after its window began, on the 10-minute mark at or before its first use: about the last sample before its percent rose from 0, or after a reset between the two it dropped between', () => {
  /** A window begun `m` minutes before NOW (NOW is on a mark) ends five hours on. @param {number} m */
  const on = (m) => NOW - m * MINUTE + SESSION;
  assert.deepEqual(
    sessionReset(points([135, 0], [120, 0], [105, 5], [90, 12], [75, 30])),
    { at: on(120), from: on(120), to: on(110) },
    'rose from 0: likeliest on the mark of the last 0, by the mark of the first sample after',
  );
  assert.deepEqual(sessionReset(points([137, 0], [122, 5], [107, 12])), { at: on(140), from: on(140), to: on(130) }, 'the mark before the last 0');
  assert.deepEqual(sessionReset(points([60, 80], [45, 3], [30, 9])), { at: on(50), from: on(50), to: on(50) }, 'dropped: a reset on the one mark between, and a new window on it');
  assert.deepEqual(sessionReset(points([62, 80], [47, 3], [32, 9])), { at: on(60), from: on(60), to: on(50) }, 'two marks between: likeliest the first, as the use goes on from the reset');
  // Where the samples don't show its start: within the five hours before the last sample, so on a
  // mark after the one five hours before it, and by the first sample of those it is sure of.
  assert.deepEqual(sessionReset(points([30, 10], [15, 20])), { at: on(170), from: on(310), to: on(30) }, 'the samples begin');
  assert.deepEqual(sessionReset(points([200, 0], [120, 4], [105, 6])), { at: on(260), from: on(400), to: on(120) }, 'more than 45 minutes between two samples');
  const long = Array.from({ length: 25 }, (_, i) => /** @type {[number, number]} */ ([360 - 15 * i, i + 1]));
  assert.deepEqual(sessionReset(points(...long)), { at: on(290), from: on(290), to: on(290) }, 'above 0 for five hours: a reset it grew back from came between, on the one mark left');
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
  // b's alone: begun within the five hours before its last sample. Taken with a's, b's 55% after
  // a's 90% would be a drop, and a window begun 10 minutes ago, ending 5 hours less 10 minutes on.
  assert.equal(usageOf(file)?.sessionReset?.from, NOW);
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

test('the session carried on from its last sample with what its window used since, at as many points for so much use as the samples rose by with it', () => {
  const p = { session: points([150, 0], [135, 10], [120, 20], [105, 30]), week: [] };
  assert.deepEqual(track(p, known(...ROSE, [60, 20_000]), NOW), { at: NOW, session: 50, sessionReset: ends(140), sessionPace: 0 }, 'the window the sample was in: begun 160 minutes ago');
  assert.equal(track(p, known(...ROSE, [60, 200_000]), NOW)?.session, 100, 'at most 100');
  // The same five hours earlier, its window over.
  const before = { session: points([450, 0], [435, 10], [420, 20], [405, 30]), week: [] };
  const earlier = ROSE.map(([m, x]) => /** @type {[number, number]} */ ([m + 300, x]));
  assert.deepEqual(track(before, known(...earlier, [100, 5000], [50, 5000]), NOW), { at: NOW, session: 10, sessionReset: ends(200), sessionPace: 5 }, 'a window begun since: all it used');
  assert.deepEqual(track(before, known(...earlier), NOW), { at: NOW, session: 0 }, 'no window now');
  assert.equal(track({ session: points([150, 0], [135, 3], [120, 6], [105, 9]), week: [] }, known(...ROSE), NOW), undefined, 'rose 9 points: too few to tell');
});

test('a window begins on the 10-minute mark at or before its first reply, as the server begins them: it resets five hours after the mark, and a reply after that begins the next', () => {
  // Its first reply 7 minutes past the mark 300 minutes ago: it ends now, not in 7 minutes.
  const p = { session: points([290, 0], [275, 10], [260, 20], [245, 30]), week: [] };
  const replies = /** @type {[number, number][]} */ ([[293, 1000], [280, 10_000], [265, 10_000], [250, 10_000], [60, 20_000]]);
  assert.deepEqual(track(p, known(...replies), NOW - MINUTE), { at: NOW - MINUTE, session: 50, sessionReset: ends(0), sessionPace: 20 });
  assert.deepEqual(track(p, known(...replies), NOW + 2 * MINUTE), { at: NOW + 2 * MINUTE, session: 0 }, 'over, with no reply since: no window');
  assert.deepEqual(
    track(p, known(...replies, [-1, 1000]), NOW + 2 * MINUTE),
    { at: NOW + 2 * MINUTE, session: 1, sessionReset: ends(300), sessionPace: 1 },
    'a reply a minute after the reset begins the next window, on the mark: all it used, not the last one\'s',
  );
});

test("the session's pace: the points the last hour's replies came to, as an hour's worth; of the part of it they are known for, a quarter of an hour at least", () => {
  const p = { session: points([150, 0], [135, 10], [120, 20], [105, 30]), week: [] };
  // 1 point for each thousand: 5 in the last hour, and 20 just before it.
  assert.equal(track(p, known(...ROSE, [61, 20_000], [50, 2000], [10, 3000]), NOW)?.sessionPace, 5);
  // Known for the last 20 minutes: 10 points in them, 30 an hour.
  const recent = { session: points([13, 0], [3, 10]), week: [] };
  const replies = [{ t: NOW - 12 * MINUTE, asked: NOW - 12 * MINUTE, x: 10_000 }];
  assert.equal(track(recent, { from: NOW - 20 * MINUTE, replies }, NOW)?.sessionPace, 30);
  const short = track(recent, { from: NOW - 14 * MINUTE, replies }, NOW);
  assert.deepEqual([short?.session, short?.sessionPace], [10, undefined], 'known for 14 minutes: too few to tell');
});

test('the session scaled by the rises within a window this computer\'s replies began, after the time they are known from', () => {
  const here = /** @type {[number, number][]} */ ([[150, 0], [135, 20], [120, 30], [105, 40]]);
  const used = known(...ROSE, [60, 20_000]);
  // 40 points for 30,000: 40 and 26.7.
  assert.equal(track({ session: points(...here), week: [] }, used, NOW)?.session, 67);
  assert.equal(track({ session: points([450, 0], [435, 20], [420, 30], [405, 40], ...here), week: [] }, used, NOW)?.session, 67, 'as much again earlier, none of it here: used elsewhere');
  assert.equal(track({ session: points(...here), week: [] }, { ...used, from: NOW - 125 * MINUTE }, NOW)?.session, 60, 'the last rise alone: 10 points for 10,000');
});

test('the week carried on from its last sample, or from its reset when one came since, and only with that reset known', () => {
  // 6 points for 30,000: 1 for each 5,000.
  const p = { session: [], week: points([150, 20], [135, 22], [120, 24], [105, 26]) };
  const later = { at: NOW + 2 * DAY, from: NOW + 2 * DAY - 9 * MINUTE, to: NOW + 2 * DAY + 5 * MINUTE };
  assert.deepEqual(track(p, known(...ROSE, [60, 20_000]), NOW, later), { at: NOW, week: 30, weekReset: later });
  const since = { at: NOW - 30 * MINUTE, from: NOW - 39 * MINUTE, to: NOW - 25 * MINUTE };
  assert.deepEqual(
    track(p, known(...ROSE, [60, 20_000], [20, 10_000]), NOW, since),
    { at: NOW, week: 2, weekReset: { at: since.at + WEEK, from: since.from + WEEK, to: since.to + WEEK } },
    'reset 30 minutes ago: what was used since, and the next a week on',
  );
  assert.equal(track(p, known(...ROSE), NOW), undefined, 'no reset known');
  assert.equal(track({ session: [], week: points([150, 20], [135, 21], [120, 22], [105, 24]) }, known(...ROSE), NOW, later), undefined, 'rose 4 points: too few');
});

test('the replies are needed back to the earliest rise the scales may use, or the last sample, and a window before; 8 days at most', () => {
  const session = points([150, 0], [135, 10], [120, 20], [105, 30]);
  assert.equal(repliesSince({ session, week: [] }, NOW), NOW - 150 * MINUTE - SESSION);
  assert.equal(repliesSince({ session, week: points([600, 20], [590, 22], [105, 26]) }, NOW), NOW - 600 * MINUTE - SESSION, 'the week\'s further back');
  assert.equal(repliesSince({ session: points([400, 50], [300, 60]), week: [] }, NOW), NOW - 300 * MINUTE - SESSION, 'no rise: the last sample');
  assert.equal(repliesSince({ session: points([20 * 24 * 60, 0], [20 * 24 * 60 - 15, 10]), week: [] }, NOW), NOW - 8 * DAY);
});

test("what this computer's sessions and models used of each limit, as the samples are carried on; the replies of the last half minute, as they add to the session's", async (t) => {
  const cfg = makeConfig(t);
  // The week resets 10 hours from now, as two drops a week apart tell; the session and the week
  // rose 30 and 6 points with the replies 150 to 105 minutes ago.
  const R = NOW + 10 * HOUR;
  const resets = [R - 2 * WEEK, R - WEEK].flatMap((r) => [[r - 10 * MINUTE, 0, 80], [r + 5 * MINUTE, 0, 1]]);
  cfg.planUsage([...resets, [NOW - 150 * MINUTE, 0, 20], [NOW - 135 * MINUTE, 10, 22], [NOW - 120 * MINUTE, 20, 24], [NOW - 105 * MINUTE, 30, 26]]);
  const opus = 'claude-opus-5-5';
  const replies = /** @type {[number, number, string, string][]} */ ([
    [160 * MINUTE, 1000, 'aaa', opus], [140 * MINUTE, 10_000, 'aaa', opus], [125 * MINUTE, 10_000, 'bbb', opus],
    [110 * MINUTE, 10_000, 'aaa', 'claude-sonnet-5-5'], [60 * MINUTE, 20_000, 'bbb', opus], [20_000, 500, 'aaa', opus],
  ]).map(([ago, x, session, model]) => ({ t: NOW - ago, asked: NOW - ago, x, session, model, seen: ago < MINUTE ? NOW - 5000 : NOW - ago }));
  const ledger = /** @type {import('../src/ledger.js').Ledger} */ (/** @type {unknown} */ ({ read: async () => ({ from: NOW - 8 * HOUR, replies }) }));
  const u = await new PlanUsage(async () => [cfg.desktop], ledger).read(NOW, { wait: true });
  /** Its numbers to a thousandth. @param {unknown} v */
  const round = (v) => JSON.parse(JSON.stringify(v, (_, n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n)));
  assert.deepEqual(round(u?.tracked), {
    at: NOW, session: 51, sessionReset: ends(140), sessionPace: 0.5,
    week: 30, weekReset: { at: R, from: R - 9 * MINUTE, to: R + 5 * MINUTE },
  });
  // A point of the session for each thousand, of the week for each 5,000: the session's in its
  // window, begun with the first reply; the week's since its reset, as far back as the replies are known.
  assert.deepEqual(round(u?.split), {
    session: { from: NOW - 160 * MINUTE, to: NOW, sessions: [['bbb', 30], ['aaa', 21.5]], models: [[opus, 41.5], ['claude-sonnet-5-5', 10]] },
    week: { from: NOW - 8 * HOUR, to: NOW, sessions: [['bbb', 6], ['aaa', 4.3]], models: [[opus, 8.3], ['claude-sonnet-5-5', 2]] },
  });
  assert.deepEqual(round(u?.drops), [{ t: NOW - 20_000, seen: NOW - 5000, v: 0.5, session: 'aaa' }]);
});

test('the sample carried on once the replies are read, in the background unless waited for; till then, the sample alone', async (t) => {
  const cfg = makeConfig(t);
  cfg.planUsage([[NOW - 150 * MINUTE, 0, 20], [NOW - 135 * MINUTE, 10, 22], [NOW - 120 * MINUTE, 20, 24], [NOW - 105 * MINUTE, 30, 26]]);
  /** @type {unknown[][]} */
  const asked = [];
  /** @type {import('../src/ledger.js').Replies | undefined} */
  let replies;
  const ledger = /** @type {import('../src/ledger.js').Ledger} */ (/** @type {unknown} */ ({
    read: async (/** @type {unknown[]} */ ...a) => {
      asked.push(a);
      return replies;
    },
  }));
  const usage = new PlanUsage(async () => [cfg.desktop], ledger);
  const first = await usage.read(NOW);
  assert.deepEqual(brief(first), { at: NOW - 105 * MINUTE, session: 30, week: 26 });
  assert.equal(first?.tracked, undefined, 'the replies not read yet');
  replies = known(...ROSE, [60, 20_000]);
  const second = await usage.read(NOW + 5000, { wait: true });
  assert.deepEqual(brief(second), brief(first), 'the sample as it was');
  // The week's reset is not known: the week as sampled.
  assert.deepEqual(second?.tracked, { at: NOW + 5000, session: 50, sessionReset: ends(140), sessionPace: 0 });
  const since = NOW - 150 * MINUTE - SESSION;
  assert.deepEqual(asked, [[NOW, since, { wait: false }], [NOW + 5000, since, { wait: true }]]);
});
