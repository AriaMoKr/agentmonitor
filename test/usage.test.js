import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { latestSample, PlanUsage } from '../src/usage.js';
import { makeConfig, MINUTE, NOW } from './helpers/fixture.js';

test('the latest of the desktop app\'s samples of the usage, in whole percent; what is not a sample is left out', () => {
  const file = {
    version: 2,
    samples: [
      { t: NOW - 30 * MINUTE, org: 'o', u: { fh: 50, sd: 20 } },
      { t: NOW - 15 * MINUTE, org: 'o', u: { fh: 64, sd: 29 } },
      { t: NOW - 45 * MINUTE, org: 'o', u: { fh: 90, sd: 99 } },
    ],
  };
  assert.deepEqual(latestSample(file), { at: NOW - 15 * MINUTE, session: 64, week: 29 }, 'the latest, wherever it is');
  assert.deepEqual(latestSample({ samples: [{ t: NOW, u: { fh: 12.6 } }] }), { at: NOW, session: 13 });
  assert.deepEqual(latestSample({ samples: [{ t: NOW, u: { sd: 100 } }] }), { at: NOW, week: 100 });
  const odd = [{ t: NOW - 1, u: { fh: 5, sd: 1 } }, { t: NOW, u: { fh: '7', sd: -1 } }, { t: '1', u: { fh: 1 } }, null, 3, { t: NOW + 1 }, { t: NOW + 2, u: null }];
  assert.deepEqual(latestSample({ samples: odd }), { at: NOW - 1, session: 5, week: 1 }, 'none of the later ones has a time and a percent');
  for (const junk of [undefined, null, 42, 'text', [], {}, { samples: {} }, { samples: [] }]) assert.equal(latestSample(junk), undefined, JSON.stringify(junk));
});

test('the latest sample in any of the app\'s folders, read again after 5 seconds, and parsed again only when a file changed', async (t) => {
  const cfg = makeConfig(t);
  const other = join(cfg.root, 'other-app');
  cfg.planUsage([[NOW - 20 * MINUTE, 40, 10], [NOW - 5 * MINUTE, 64, 29]]);
  cfg.planUsage([[NOW - 10 * MINUTE, 70, 30]], other);
  const usage = new PlanUsage(async () => [cfg.desktop, join(cfg.root, 'missing'), other]);
  assert.deepEqual(await usage.read(NOW), { at: NOW - 5 * MINUTE, session: 64, week: 29 });
  cfg.planUsage([[NOW - MINUTE, 66, 30]]);
  assert.deepEqual(await usage.read(NOW + 1000), { at: NOW - 5 * MINUTE, session: 64, week: 29 }, 'not within 5 seconds');
  assert.deepEqual(await usage.read(NOW + 5000), { at: NOW - MINUTE, session: 66, week: 30 });
  // Being written, it holds no JSON for a moment: the last good one stands.
  cfg.write(join(cfg.desktop, 'plan-usage-history.json'), '{"version":2,"samp');
  assert.deepEqual(await usage.read(NOW + 10_000), { at: NOW - MINUTE, session: 66, week: 30 });
  assert.equal(await new PlanUsage(async () => [join(cfg.root, 'missing')]).read(NOW), undefined, 'no app, no usage');
});
