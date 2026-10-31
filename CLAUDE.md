# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

agentmonitor: the Claude Code sessions on this computer (in a terminal, the desktop app's Code tab, an IDE, the background) that run or were active lately, with what each is doing, its task list and the subagents and workflows it started, live in a terminal. Node 22 or later, plain ES modules, no dependencies and no build. `README.md` covers using it, what it reads and how it decides a session's state.

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
- `src/registry.js` (`sessions/<pid>.json`), `src/transcript.js` (a transcript read as it grows), `src/agents.js` (a session's subagents and workflow runs), `src/jobs.js` (`jobs/*/state.json`), `src/desktop.js` (the desktop app's session records: its summary of each one's last turn, and from them which sessions it shows unread), `src/procs.js` (is a PID running, and is it Claude Code), `src/files.js` (folders and JSON read again only when changed).
- `src/view.js`: what is drawn, as lines for a screen size, and where a click on them goes (`hits`): pure, so the tests draw it. `src/tui.js`: the alternate screen, the keys and the mouse (`src/keys.js`; the terminal's reports in the SGR form, asked for with modes 1000 and 1006), the timers, painting the lines that changed, and every 2 seconds all of them (a terminal can lose lines without telling the program: the desktop app's Terminal panel has). `src/format.js`: terminal-safe text, widths, short forms.
- `test/helpers/fixture.js` writes a config folder as Claude Code does (times relative to `NOW`, mtimes set); `test/helpers/screen.js` is a fake TTY pair and a screen that applies what is written; `test/helpers/agents.js` makes agents and snapshots by hand.

## Claude Code's files

Undocumented, read as Claude Code 2.1.3xx writes them; a new version can change them, so a field that is missing or of another type is skipped, never an error.

- `sessions/<pid>.json`: `pid`, `sessionId`, `cwd`, `startedAt`, `procStart` or `procStartFt`, `version`, `kind` (`interactive`, or a background kind), `entrypoint` (`cli`, `claude-desktop`, `claude-vscode`, `sdk-*`, `local-agent`...), `hostSessionId` (the desktop app's `local_<id>`), `pidDomain` (`win32:<host>` on Windows), `name` and `nameSource` (`derived`: made from the prompt), `status` (`busy`, `waiting`, `idle`) with `waitingFor` and `statusUpdatedAt`, `jobId`, `spare` (a process started ahead of a session).
- Transcripts, one JSON record per line: `user` and `assistant` (with `uuid`, `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `permissionMode`). An assistant message is written one record per content block, each with the same `message.id` and the usage so far: count its output tokens once. Assistant records carry `effort` (the session's: `low`, `medium`, `high`, `xhigh`, `max`) and `perTurnEffort` (the turn's; the same so far, or null in older versions). API errors are assistant records with model `<synthetic>` and `isApiErrorMessage`. An `attachment` record of type `ultra_effort_enter` (`reminderType` `full` or `sparse`) is ultracode's reminder: after the first prompt, about every tenth since and after a compaction, only while the desktop app's setting is on (none came with a prompt naming ultracode); no record says it was turned off. `mode` and `atis-latch` records say nothing of it. Also `custom-title`, `ai-title`, `agent-name`, `summary`, `last-prompt`, `cost-state` and `system` (`compact_boundary`). `cost-state`, `last-prompt` and `bridge-session` have no time and are appended to every open transcript when the app quits: take times from records, never from the file's mtime. Records the monitor never needs (`api-request`, `file-history`, ...; some are megabytes) are skipped by their first bytes, unparsed.
- Tool calls in transcripts that the monitor follows, each from its call to its result (a result that is an error changes nothing):
  - Calls that wait on the user: `AskUserQuestion` (`questions[]` with `question`, `header`), `ExitPlanMode`, and `mcp__ccd_session__start_session` with `initiation: 'offer'`. The desktop app's permission prompts are in no file.
  - The task list: the desktop app's `mcp__ccd_turn__update_plan`. `items` (`content`, `status`: `pending`, `in_progress`, `completed`) replaces the list, and any `advance`, `done` or `start` in the same call is then ignored. `advance: true` completes the step in progress and starts the next pending one; `done: [n]` and `start: n` count from 1. `mcp__ccd_turn__wrap_up` checks off the step in progress. Claude Code's own list is `TodoWrite` (`todos[]` with `content`, `status`, `activeForm`).
  - Commands in the background: a call whose result begins `Command running in background with ID: <id>`, or `Command did not complete within its <n>s timeout and was moved to the background (ID: <id>)`. Its end is a `<task-notification>` (with `<tool-use-id>` and `<status>`), as a `user` record's string content, or, when it came in during a turn, in an `attachment` record of type `queued_command` (its `prompt`). `TaskStop` (`task_id`) or `KillShell` (`shell_id`) stops one.
- `<session>/subagents/agent-<id>.meta.json`: `agentType`, `description`, `toolUseId` (the Agent call in the session's transcript), `requestShape` (`foreground` or `background`); only a background one gets `finished` or `stoppedByUser`.
- Workflows: `<session>/subagents/workflows/<run>/` (agents, as subagents, with `workflowPhase` in their meta; `journal.jsonl`: `started` with `agentId`, `label`, `phase`, then `result` or `failed`), `<session>/workflows/<run>.json` once it ended (`status`, `workflowName`, `startTime`, `durationMs`, `totalTokens`, `defaultModel`), `<session>/workflows/scripts/<name>-<run>.js`.
- `jobs/<id>/state.json`: `sessionId`, `name`, `state`, `detail`, `needs`, `cwd`, `createdAt` and `updatedAt` (ISO), `cliVersion`.
- The desktop app's `claude-code-sessions/<account>/<org>/local_<id>.json`: `sessionId`, `cliSessionId`, `title`, `cwd`, `isArchived`, `model`, `effort`, `permissionMode`, `sessionSettings` (`ultracode: true` while ultracode is on; no `sessionSettings` when nothing was set, or for a session started elsewhere), `createdAt`, `lastActivityAt`, `lastFocusedAt` (when the session was last opened in the app, overwritten each time) and `lastTurnEdgeAt` (when a turn last started or ended). `postTurnSummary` is the app's summary of the last turn, written a few seconds after it ends and not after every one: `status_category` (`completed`, `blocked`, `review_ready`), `status_detail`, `needs_action` (empty unless blocked) and `summarizes_uuid` (the transcript record it sums up, also in `postTurnSummaryFor`). It is used only for a session not at work, and only when it names the transcript's last assistant record. The app keeps its unread list (its blue dots) in its own browser storage: `epitaxy-unread-v1` in its Local Storage (`unreadIds`, and `explicitUnreadIds` for the dots set by hand). The monitor never reads that. It works out the same list from these two fields: a session is unread when it is not at work, its last turn ended after its last opening, and another session was the last one opened when that turn ended.

## Rules

- Read only: never write under the config folder or the desktop app's, never signal a process but with signal 0. Read only the files above; never `.credentials.json` or anything else there.
- No dependencies. Keep it portable (Windows, macOS, Linux): paths in the data can be any system's (`lastPart`, `relativeTo`), processes come from `tasklist` or `ps`, and commands in docs are POSIX shell.
- All text from the files is untrusted terminal output: through `clean()` before it is drawn, and measured with `width()`, `fit()` and `truncate()` (wide characters, emoji). With `--ascii`, draw nothing but ASCII of the monitor's own (`t.sep`, `t.ellipsis`, `t.pad`).
- The screen: autowrap off, and the last line one column short, since writing the bottom right cell scrolls some terminals. Every way out puts the terminal back, with its mouse reports off.
- On Windows, Node's raw mode is the console's VT input, and the console passes the mouse's modes (1000, 1006) on to the terminal only while that is on, and does not turn them off when Node exits: raw mode on before asking for the mouse, the mouse off before leaving raw mode. In mintty Node gets pipes, not a console, so there is no full screen there. `msys2_shell.cmd -defterm -here -no-start -ucrt64` runs MSYS2's bash in the console it is started from.
- Keep a refresh cheap: transcripts are read from their tail and then only what was appended; JSON files are parsed again only when their size or mtime changes; the process table is read for a new PID and every 10 seconds.
- Tests: `node:test`, a fixture config folder with fixed times, the TUI through the fake terminal. Run `npm test` before a commit.
- Style: ES modules, JSDoc types, single quotes, a header comment in each file saying what it is for.
