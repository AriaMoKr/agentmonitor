import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION, versionAt } from '../src/version.js';

/** The version in a package.json of this repository. @param {string} path from test/ */
const versionIn = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version;

test("agentmonitor's version is its package.json's, and the agentmonitor app's the same", () => {
  assert.equal(VERSION, versionIn('../package.json'));
  assert.equal(versionIn('../desktop/package.json'), VERSION, 'as the release workflow wants them: its program carries that one');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("a package.json's version, or '' where it has none fit to draw", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmonitor-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'package.json');
  /** @param {string} text the file's */
  const at = (text) => {
    writeFileSync(file, text);
    return versionAt(file);
  };
  assert.equal(at('{"name":"x","version":"1.2.3-beta.1+build.5"}'), '1.2.3-beta.1+build.5');
  assert.equal(at('{"name":"x"}'), '', 'none');
  assert.equal(at('{"version":3}'), '', 'not a string');
  assert.equal(at('{"version":""}'), '');
  assert.equal(at('{"version":"1.2.3\\u001b[31m"}'), '', 'an escape, which the screen would take as its own');
  assert.equal(at('{"version":"1.2.3 beta"}'), '', 'a space');
  assert.equal(at(`{"version":"${'1'.repeat(41)}"}`), '', 'longer than any');
  assert.equal(at('{"version":'), '', 'not JSON');
  assert.equal(at('null'), '', 'JSON, but no object');
  assert.equal(versionAt(join(dir, 'missing.json')), '', 'no file');
});
