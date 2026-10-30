import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRunning, looksLikeClaude, parsePs, parseTasklist, processTable, sameDomain } from '../src/procs.js';

test('parseTasklist reads tasklist /FO CSV /NH', () => {
  const table = parseTasklist([
    '"System Idle Process","0","Services","0","8 K"',
    '"claude.exe","4242","Console","1","312,456 K"',
    '"node.exe","77","Console","1","45.120 K"',
    '',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n'));
  assert.deepEqual(table.get(4242), { name: 'claude.exe', memKB: 312_456 });
  assert.deepEqual(table.get(77), { name: 'node.exe', memKB: 45_120 });
  assert.deepEqual(table.get(0), { name: 'System Idle Process', memKB: 8 });
  assert.equal(table.size, 3);
});

test('parsePs reads ps -A -o pid= -o rss= -o comm=', () => {
  const table = parsePs('    1  1024 /sbin/launchd\n 4242 312456 /usr/local/bin/claude\n   88  2048 Google Chrome Helper\n\n');
  assert.deepEqual(table.get(4242), { name: '/usr/local/bin/claude', memKB: 312_456 });
  assert.deepEqual(table.get(88), { name: 'Google Chrome Helper', memKB: 2048 });
  assert.equal(table.size, 3);
});

test('looksLikeClaude: Claude Code, or the Node or Bun that runs it', () => {
  for (const name of [
    'claude.exe', 'claude', '/usr/local/bin/claude', 'node.exe', '/usr/bin/node', 'bun',
    'C:\\Program Files\\nodejs\\node.exe', '/Applications/Claude.app/Contents/MacOS/Claude',
  ]) assert.ok(looksLikeClaude(name), name);
  for (const name of ['notepad.exe', 'bash', '/home/claude/bin/bash', 'python3']) assert.ok(!looksLikeClaude(name), name);
});

test('sameDomain: a record written on Windows names a process here only on its own computer', () => {
  assert.equal(sameDomain(undefined, 'win32', 'PC'), true);
  assert.equal(sameDomain('win32:pc', 'win32', 'PC'), true);
  assert.equal(sameDomain('win32:other', 'win32', 'PC'), false);
  assert.equal(sameDomain('win32:pc', 'linux', 'pc'), false, 'Windows seen from WSL');
  assert.equal(sameDomain('linux:abc', 'linux', 'pc'), true);
});

test('isRunning', () => {
  assert.equal(isRunning(process.pid), true);
  for (const pid of [0, -1, 1.5, NaN]) assert.equal(isRunning(pid), false, String(pid));
  assert.equal(isRunning(2_147_483_646), false);
});

test('processTable lists this process', async () => {
  const me = (await processTable()).get(process.pid);
  assert.ok(me, 'this process is listed');
  assert.ok(looksLikeClaude(me.name), me.name);
  assert.ok(me.memKB > 0);
});
