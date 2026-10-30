# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

agentmonitor: the Claude Code sessions on this computer (in a terminal, the desktop app's Code tab, an IDE, the background) that run or were active lately, with what each is doing and the subagents and workflows it started, live in a terminal. Node 22 or later, plain ES modules, no dependencies and no build. `README.md` covers using it, what it reads and how it decides a session's state.

## Commands

```bash
node bin/agentmonitor.js          # full screen; q quits
node bin/agentmonitor.js --once   # the table, printed once (also when stdout is not a terminal)
node bin/agentmonitor.js --json   # what was found, as JSON (without the events)
npm test                          # node --test "test/*.test.js"
```

## Layout

- `bin/agentmonitor.js`: the options, then `runTui`, or one table or JSON.
- `src/monitor.js`: `Monitor.refresh(now)` puts a `Snapshot` together: sessions (one row per process running one, or one for a session that ended), each with its subagents and workflow runs as `children`, a workflow's agents as its children. `focus` is the key of an agent whose transcript is read though it is not at work (the one in the detail view).
- `src/registry.js` (`sessions/<pid>.json`), `src/transcript.js` (a transcript read as it grows), `src/agents.js` (a session's subagents and workflow runs), `src/jobs.js` (`jobs/*/state.json`), `src/desktop.js` (the desktop app's session records), `src/procs.js` (is a PID running, and is it Claude Code), `src/files.js` (folders and JSON read again only when changed).
- `src/view.js`: what is drawn, as lines for a screen size: pure, so the tests draw it. `src/tui.js`: the alternate screen, the keys (`src/keys.js`), the timers, painting only the lines that changed. `src/format.js`: terminal-safe text, widths, short forms.
- `test/helpers/fixture.js` writes a config folder as Claude Code does (times relative to `NOW`, mtimes set); `test/helpers/screen.js` is a fake TTY pair and a screen that applies what is written; `test/helpers/agents.js` makes agents and snapshots by hand.

## Claude Code's files

Undocumented, read as Claude Code 2.1.3xx writes them; a new version can change them, so a field that is missing or of another type is skipped, never an error.

- `sessions/<pid>.json`: `pid`, `sessionId`, `cwd`, `startedAt`, `procStart` or `procStartFt`, `version`, `kind` (`interactive`, or a background kind), `entrypoint` (`cli`, `claude-desktop`, `claude-vscode`, `sdk-*`, `local-agent`...), `hostSessionId` (the desktop app's `local_<id>`), `pidDomain` (`win32:<host>` on Windows), `name` and `nameSource` (`derived`: made from the prompt), `status` (`busy`, `waiting`, `idle`) with `waitingFor` and `statusUpdatedAt`, `jobId`, `spare` (a process started ahead of a session).
- Transcripts, one JSON record per line: `user` and `assistant` (with `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `permissionMode`). An assistant message is written one record per content block, each with the same `message.id` and the usage so far: count its output tokens once. API errors are assistant records with model `<synthetic>` and `isApiErrorMessage`. Also `custom-title`, `ai-title`, `agent-name`, `summary`, `last-prompt`, `cost-state` and `system` (`compact_boundary`). `cost-state`, `last-prompt` and `bridge-session` have no time and are appended to every open transcript when the app quits: take times from records, never from the file's mtime. Records the monitor never needs (`api-request`, `file-history`, ...; some are megabytes) are skipped by their first bytes, unparsed.
- `<session>/subagents/agent-<id>.meta.json`: `agentType`, `description`, `toolUseId` (the Agent call in the session's transcript), `requestShape` (`foreground` or `background`); only a background one gets `finished` or `stoppedByUser`.
- Workflows: `<session>/subagents/workflows/<run>/` (agents, as subagents, with `workflowPhase` in their meta; `journal.jsonl`: `started` with `agentId`, `label`, `phase`, then `result` or `failed`), `<session>/workflows/<run>.json` once it ended (`status`, `workflowName`, `startTime`, `durationMs`, `totalTokens`, `defaultModel`), `<session>/workflows/scripts/<name>-<run>.js`.
- `jobs/<id>/state.json`: `sessionId`, `name`, `state`, `detail`, `needs`, `cwd`, `createdAt` and `updatedAt` (ISO), `cliVersion`.
- The desktop app's `claude-code-sessions/<account>/<org>/local_<id>.json`: `sessionId`, `cliSessionId`, `title`, `cwd`, `isArchived`, `model`, `effort`, `permissionMode`, `createdAt`, `lastActivityAt`.

## Rules

- Read only: never write under the config folder or the desktop app's, never signal a process but with signal 0. Read only the files above; never `.credentials.json` or anything else there.
- No dependencies. Keep it portable (Windows, macOS, Linux): paths in the data can be any system's (`lastPart`, `relativeTo`), processes come from `tasklist` or `ps`, and commands in docs are POSIX shell.
- All text from the files is untrusted terminal output: through `clean()` before it is drawn, and measured with `width()`, `fit()` and `truncate()` (wide characters, emoji). With `--ascii`, draw nothing but ASCII of the monitor's own (`t.sep`, `t.ellipsis`, `t.pad`).
- The screen: autowrap off, and the last line one column short, since writing the bottom right cell scrolls some terminals. Every way out puts the terminal back.
- Keep a refresh cheap: transcripts are read from their tail and then only what was appended; JSON files are parsed again only when their size or mtime changes; the process table is read for a new PID and every 10 seconds.
- Tests: `node:test`, a fixture config folder with fixed times, the TUI through the fake terminal. Run `npm test` before a commit.
- Style: ES modules, JSDoc types, single quotes, a header comment in each file saying what it is for.
