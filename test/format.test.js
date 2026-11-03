import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ago, bytes, clean, clock, dollars, durationLabel, elapsed, fit, kindLabel, lastPart, parseDuration,
  relativeTo, shortModel, timeOfDay, tokens, toolName, toolSummary, truncate, weekday, width,
} from '../src/format.js';

test('clean takes out escape sequences and control characters, and makes one line', () => {
  assert.equal(clean('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(clean('title\x1b]0;evil\x07 here'), 'title here');
  assert.equal(clean('a\nb\tc\r\nd'), 'a b c d');
  assert.equal(clean('  many   spaces  '), 'many spaces');
  assert.equal(clean('bidi \u202eesrever\u202c ok'), 'bidi esrever ok');
  assert.equal(clean('bell\x07 and \x9b c1'), 'bell and c1');
  assert.equal(clean(undefined), '');
  assert.equal(clean(null), '');
  assert.equal(clean(42), '42');
});

test('width counts terminal columns', () => {
  assert.equal(width('hello'), 5);
  assert.equal(width(''), 0);
  assert.equal(width('日本語'), 6);
  assert.equal(width('한국'), 4);
  assert.equal(width('😀'), 2);
  assert.equal(width('e\u0301'), 1);
  assert.equal(width('👨‍👩‍👧'), 2);
  assert.equal(width('🇯🇵'), 2);
  assert.equal(width('●○◆✓·'), 5);
  assert.equal(width('⠋'), 1);
  assert.equal(width('©'), 1);
  assert.equal(width('❤️'), 2);
});

test('truncate cuts to a width and ends with an ellipsis', () => {
  assert.equal(truncate('hello world', 20), 'hello world');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello world', 8, '~'), 'hello w~');
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello', 0), '');
  assert.equal(truncate('hello', 1), '…');
  assert.equal(truncate('日本語テキスト', 7), '日本語…');
  assert.equal(truncate('日本語テキスト', 6), '日本…');
  assert.ok(width(truncate('日本語テキスト', 6)) <= 6);
  assert.equal(truncate('ab😀cd', 4), 'ab…');
});

test('fit pads or cuts to an exact width', () => {
  assert.equal(fit('abc', 5), 'abc  ');
  assert.equal(fit('abc', 5, 'right'), '  abc');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('日本語', 5), '日本…');
  assert.equal(width(fit('日本語', 4)), 4);
  assert.equal(fit('x', 0), '');
});

test('ago and elapsed', () => {
  assert.equal(ago(0), 'now');
  assert.equal(ago(-5000), 'now');
  assert.equal(ago(NaN), 'now');
  assert.equal(ago(42_000), '42s');
  assert.equal(ago(5 * 60_000 + 10_000), '5m');
  assert.equal(ago(3 * 3_600_000), '3h');
  assert.equal(ago(47 * 3_600_000), '47h');
  assert.equal(ago(50 * 3_600_000), '2d');
  assert.equal(elapsed(0), '0s');
  assert.equal(elapsed(-1), '0s');
  assert.equal(elapsed(59_999), '59s');
  assert.equal(elapsed(185_000), '3m05s');
  assert.equal(elapsed(3_720_000), '1h02m');
  assert.equal(elapsed(51 * 3_600_000), '2d03h');
});

test('parseDuration and durationLabel', () => {
  assert.equal(parseDuration('90'), 90_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1.5d'), 129_600_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration(' 2H '), 7_200_000);
  assert.throws(() => parseDuration('soon'), /not a duration/);
  assert.throws(() => parseDuration('-5m'), /not a duration/);
  assert.equal(durationLabel(30 * 60_000), '30m');
  assert.equal(durationLabel(24 * 3_600_000), '24h');
  assert.equal(durationLabel(72 * 3_600_000), '3d');
  assert.equal(durationLabel(7 * 86_400_000), '7d');
  assert.equal(durationLabel(45_000), '45s');
});

test('tokens and bytes', () => {
  assert.equal(tokens(0), '');
  assert.equal(tokens(undefined), '');
  assert.equal(tokens(950), '950');
  assert.equal(tokens(1000), '1k');
  assert.equal(tokens(9_499), '9.5k');
  assert.equal(tokens(9_960), '10k');
  assert.equal(tokens(112_400), '112k');
  assert.equal(tokens(999_499), '999k');
  assert.equal(tokens(999_600), '1M');
  assert.equal(tokens(1_234_000), '1.2M');
  assert.equal(tokens(25_000_000), '25M');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(822_041), '803 KB');
  assert.equal(bytes(53_125_220), '50.7 MB');
  assert.equal(bytes(3 * 1024 ** 3), '3 GB');
});

test('dollars: whole ones as they are, else to the cent', () => {
  assert.deepEqual([200, 45.9968, 17.5, 10.1193, 0.46, 0.005, 0.004, 0].map(dollars), ['$200', '$46', '$17.50', '$10.12', '$0.46', '$0.01', '<$0.01', '$0']);
});

test('shortModel', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'opus 5.5');
  assert.equal(shortModel('claude-sonnet-4-5-20250929'), 'sonnet 4.5');
  assert.equal(shortModel('claude-haiku-4-5'), 'haiku 4.5');
  assert.equal(shortModel('claude-opus-4-1-20250805'), 'opus 4.1');
  assert.equal(shortModel('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'opus 4.1');
  assert.equal(shortModel('claude-sonnet-4-5[1m]'), 'sonnet 4.5 1M');
  assert.equal(shortModel('claude-fable-5'), 'fable 5');
  assert.equal(shortModel('gemma4:26b'), 'gemma4:26b');
  assert.equal(shortModel('<synthetic>'), '');
  assert.equal(shortModel(undefined), '');
});

test('kindLabel', () => {
  assert.equal(kindLabel({ entrypoint: 'claude-desktop', kind: 'interactive' }), 'desktop');
  assert.equal(kindLabel({ entrypoint: 'local-agent' }), 'desktop');
  assert.equal(kindLabel({ entrypoint: 'claude-vscode' }), 'vscode');
  assert.equal(kindLabel({ entrypoint: 'cli' }), 'cli');
  assert.equal(kindLabel({ entrypoint: 'sdk-ts' }), 'sdk');
  assert.equal(kindLabel({ entrypoint: 'cli', kind: 'bg' }), 'bg');
  assert.equal(kindLabel({ entrypoint: 'claude-jetbrains' }), 'jetbrains');
  assert.equal(kindLabel({}), '');
});

test('lastPart and relativeTo take paths of any system', () => {
  assert.equal(lastPart('C:\\git\\my\\claude\\pv'), 'pv');
  assert.equal(lastPart('/home/me/project/'), 'project');
  assert.equal(lastPart(''), '');
  assert.equal(relativeTo('C:\\git\\demo\\src\\a.js', 'C:\\git\\demo'), 'src\\a.js');
  assert.equal(relativeTo('c:\\GIT\\demo\\src\\a.js', 'C:\\git\\demo\\'), 'src\\a.js');
  assert.equal(relativeTo('C:\\git\\demo2\\a.js', 'C:\\git\\demo'), 'C:\\git\\demo2\\a.js');
  assert.equal(relativeTo('/home/me/p/a.js', '/home/me/p'), 'a.js');
  assert.equal(relativeTo('/home/me/P/a.js', '/home/me/p'), '/home/me/P/a.js');
  assert.equal(relativeTo('/x/a.js', undefined), '/x/a.js');
});

test('toolName and toolSummary', () => {
  assert.equal(toolName('Bash'), 'Bash');
  assert.equal(toolName('mcp__Claude_Browser__navigate'), 'Claude_Browser:navigate');
  assert.equal(toolName('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch'), 'batch');
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run the tests' }), 'Bash: Run the tests');
  assert.equal(toolSummary('Bash', { command: 'npm test\necho done' }), 'Bash: npm test echo done');
  assert.equal(toolSummary('Edit', { file_path: 'C:\\w\\d\\src\\a.js' }, 'C:\\w\\d'), 'Edit: src\\a.js');
  assert.equal(toolSummary('Grep', { pattern: 'TODO', path: '/p/src' }, '/p'), 'Grep: TODO in src');
  assert.equal(toolSummary('Agent', { subagent_type: 'Explore', description: 'find the parser' }), 'Agent: Explore: find the parser');
  assert.equal(toolSummary('Workflow', { script: "export const meta = { name: 'review-changes', description: 'x' }" }), 'Workflow: review-changes');
  assert.equal(toolSummary('WebSearch', { query: 'node raw mode' }), 'WebSearch: node raw mode');
  assert.equal(toolSummary('mcp__Claude_Browser__navigate', { url: 'https://example.com' }), 'Claude_Browser:navigate: https://example.com');
  assert.equal(toolSummary('TodoWrite', { todos: [] }), 'TodoWrite: the to-do list');
  assert.equal(toolSummary('Mystery', {}), 'Mystery');
  assert.equal(toolSummary('Mystery', null), 'Mystery');
  assert.equal(toolSummary('Bash', { command: 'echo \x1b[31mred' }), 'Bash: echo red');
});

test('clock shows the time today, and the date on other days', () => {
  const now = new Date(2026, 9, 29, 21, 30, 0).getTime();
  assert.equal(clock(new Date(2026, 9, 29, 9, 5, 7).getTime(), now), '09:05:07');
  assert.equal(clock(new Date(2026, 9, 28, 23, 59, 0).getTime(), now), 'Oct 28 23:59');
  assert.equal(clock(0, now), '');
});

test('timeOfDay and weekday: a moment\'s local time to the minute, and its day', () => {
  assert.equal(timeOfDay(new Date(2026, 9, 29, 9, 5, 59).getTime()), '09:05');
  assert.equal(timeOfDay(new Date(2026, 9, 29, 23, 0, 0).getTime()), '23:00');
  assert.equal(weekday(new Date(2026, 9, 29, 12, 0, 0).getTime()), 'Thu');
  assert.equal(weekday(new Date(2026, 10, 1, 0, 0, 0).getTime()), 'Sun');
});
