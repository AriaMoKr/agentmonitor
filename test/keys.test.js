import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKeys } from '../src/keys.js';

/** The keys' names, with ctrl- and alt- in front of those typed with them. @param {string} data */
const names = (data) => parseKeys(data).map((k) => (k.ctrl ? `ctrl-${k.name}` : k.name === 'alt' ? `alt-${k.ch}` : k.name));

test('arrows, Home, End, Page Up and Down, in the forms terminals send', () => {
  assert.deepEqual(names('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
  assert.deepEqual(names('\x1bOA\x1bOB\x1bOC\x1bOD'), ['up', 'down', 'right', 'left']);
  assert.deepEqual(names('\x1b[H\x1b[F\x1bOH\x1bOF\x1b[1~\x1b[4~\x1b[7~\x1b[8~'), ['home', 'end', 'home', 'end', 'home', 'end', 'home', 'end']);
  assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[3~\x1b[2~\x1b[Z'), ['pageup', 'pagedown', 'delete', 'insert', 'backtab']);
  assert.deepEqual(names('\x1b[1;5A\x1b[99~'), ['unknown', 'unknown']);
});

test('characters, Enter, Tab, Backspace and control keys', () => {
  assert.deepEqual(parseKeys('jK/'), [{ name: 'j', ch: 'j' }, { name: 'K', ch: 'K' }, { name: '/', ch: '/' }]);
  assert.deepEqual(names('\r'), ['enter']);
  assert.deepEqual(names('\n'), ['enter']);
  assert.deepEqual(names('\r\n'), ['enter']);
  assert.deepEqual(names('\r\r'), ['enter', 'enter']);
  assert.deepEqual(names('\t\x7f\b'), ['tab', 'backspace', 'backspace']);
  assert.deepEqual(names('\x03\x0c\x1a'), ['ctrl-c', 'ctrl-l', 'ctrl-z']);
  assert.deepEqual(parseKeys('😀é'), [{ name: '😀', ch: '😀' }, { name: 'é', ch: 'é' }]);
});

test('Escape alone, twice, and before a character (Alt)', () => {
  assert.deepEqual(names('\x1b'), ['escape']);
  assert.deepEqual(names('\x1b\x1b'), ['escape', 'escape']);
  assert.deepEqual(names('\x1bx'), ['alt-x']);
  assert.deepEqual(names('\x1b['), ['escape', '[']);
  assert.deepEqual(names('jj\x1b[B'), ['j', 'j', 'down']);
});
