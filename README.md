# agentmonitor

The Claude agents on this computer, live in a terminal: every Claude Code session that runs (in a terminal, the Claude desktop app's Code tab, an IDE or the background) or was active lately, what each one is doing now, the subagents and workflows it started, and which ones the desktop app shows as unread.

```
 Claude agents  ● 2 working  ◆ 1 waiting  • 1 unread  ○ 1 idle  · 1 ended  3 agents at work                    21:14:05
   NAME                         PROJECT          KIND     MODEL        CTX ACTIVITY                                 LAST
>◆ Release 2.0                  shop             cli      opus 5.5     88k waiting: permission: Bash          2m03s   2m
 • Plan the migration           infra            desktop  opus 5.5    201k The plan is in MIGRATION.md: three step…  18m
 ● Write the API docs           docs             vscode   sonnet 5.5   64k 1 agent running                    4m00s   2s
 ● └─ review-docs               Review           workflow                  Review: 2 running, 3/5 done        4m00s   2s
 ●    ├─ review:examples        Review           agent    sonnet 5.5   52k Bash: Run the examples               41s   2s
 ●    └─ review:links           Review           agent    sonnet 5.5   24k WebFetch: https://example.com/api/v2  6s   6s
 ● Fix the flaky upload test    shop             desktop  opus 5.5    142k Bash: Run the upload tests           14s  14s
 ● └─ find the retry logic      Explore          agent    haiku 4.5    31k Grep: retry in src                    3s   3s
 ○ Triage the issues            shop             bg       sonnet 5.5   41k Labelled 14 issues; 3 need a person to …   1h
 · Upgrade the linter           tools            cli      opus 5.5     96k Done: eslint 10 with the flat config.      5h
 ↑↓ move  ⏎ details  / filter  s sort:status  e ended:on  a agents:running  w window  ? help  q quit              1/10
```

It only reads: Claude Code's own files, and which processes run. It changes nothing and needs no setup in Claude Code.

## Running it

Node 22 or later; there are no dependencies.

```bash
node bin/agentmonitor.js
```

For an `agentmonitor` command, run `npm link` in this folder.

In a terminal it runs full screen until you press q, reading everything again each second. When its output is not a terminal (a pipe, a file) it prints the table once instead, as `--once` does, and `--json` prints what it found as JSON.

On Windows it works in Windows Terminal and the console. In mintty (MSYS2, Git Bash, Cygwin) Node may not see a terminal, and agentmonitor then prints the table once and exits: run it as `winpty node bin/agentmonitor.js` there, or from Windows Terminal.

## Options

```
  -s, --since <time>     how far back "recently active" reaches (default 24h)
  -i, --interval <time>  how often to read everything again (default 1s)
  -a, --agents <which>   agents listed under their session: running (default),
                         all, or none
  -e, --hide-ended       list only the sessions that run
  -1, --once             print the table once and exit
      --json             print what was found as JSON and exit
      --dir <path>       Claude Code's config folder (default: $CLAUDE_CONFIG_DIR,
                         else ~/.claude)
      --bell             ring the bell when a session starts waiting for you,
                         or finishes its turn
      --ascii            draw with ASCII only
      --color, --no-color  colors on or off (default: on in a terminal,
                         off with NO_COLOR set)
  -v, --version
  -h, --help
```

Times are written as `30s`, `5m`, `2h`, `1d` or `1w`.

## The list

Each session is a row, with the agents it started under it: its subagents (the Agent tool) and its workflow runs, and a workflow's agents under the workflow. By default only the agents at work are listed; `a` lists all of them, or none.

| State | |
|---|---|
| ● working | the session is at work (a spinner while it lasts); for an agent, running |
| ◆ waiting | it needs you: a permission, an answer |
| • unread | the desktop app's blue dot: a session there finished a turn that you have not opened yet. It shows in place of idle or ended, and the app clears it when you open the session |
| ○ idle | it runs, and waits for your next message |
| ◌ active | its transcript was written moments ago, by a process the monitor does not know |
| · ended | its process is gone |
| ✓ done, ✗ failed, ■ stopped | an agent or workflow that is over |

The columns: NAME is the session's title (the one you gave it, the desktop app's, Claude's, or else the first prompt); PROJECT, its folder (for an agent, its type; for a workflow, the phase it is in); KIND, how it was started (`cli`, `desktop`, `vscode`, `sdk`, `bg` for a background session); CTX, the context of its last reply in tokens; ACTIVITY, what it is doing, with how long that has taken; LAST, how long ago it last did anything; PID, its process. On a narrow terminal the least needed columns go first.

ACTIVITY is the tool call it is in (`Bash: Run the tests`, `Edit: src/a.js`, `Agent: Explore: find the parser`), `thinking`, the agents it waits for, or what it waits for you to do. For a session that is idle or ended it is its last reply, or the error that stopped it (a usage limit, say).

## Details

Enter shows everything known about the selected row, and its latest events: your prompts, its replies, its tool calls and what failed, newest at the bottom.

```
 ● Fix the flaky upload test                                                          working · 14s
────────────────────────────────────────────────────────────────────────────────────────────────────
 Doing      Bash: Run the upload tests  (14s)
 Session    6f1c2a9e-0b7d-4c55-9e3a-2d8f4b1c7e60 · desktop · Claude Code 2.1.309
 Folder     /home/me/src/shop · branch fix-upload
 Process    pid 21344 · up 2h07m · 402 MB
 Model      claude-opus-5-5 · effort high · permissions acceptEdits
 Context    142k tokens · 18k output tokens in the part read
 Started    19:08:05 (2h ago)
 Last       21:13:51 (14s ago)
 Transcript /home/me/.claude/projects/-home-me-src-shop/6f1c2a9e-0b7d-4c55-9e3a-2d8f4b1c7e60.jsonl…

 Agents  1 agent · 1 running
 ● find the retry logic         Explore            31k Grep: retry in src                    3s   3s

 Activity
 21:08:05     you    The upload test fails about one run in ten. Find out why and fix it.
 21:08:15     tool   Agent: Explore: find the retry logic
 21:09:05     tool   Read: src/upload.js
 21:10:05     claude The retry waits a fixed 100 ms, and the fake server sometimes takes longer to…
 21:11:05     tool   Edit: src/upload.js
 21:12:05     tool   Bash: Run the upload tests
 21:12:35     error  Bash: Run the upload tests failed: Exit code 1 / 1 failing: upload retries af…
 21:13:25     tool   Edit: test/upload.test.js
 21:13:51     tool   Bash: Run the upload tests

 esc back  ↑↓ scroll  home/end  tab next
```

A session that ended shows the `claude --resume` command that takes it up again, run in its folder. A desktop app session shows when you last opened it there, and an unread one shows its last reply as Unread. An agent's transcript is read while it works, and when its details are open, so a finished agent shows what it did too.

## Keys

| Key | |
|---|---|
| ↑ ↓, j k, PgUp PgDn, Home End | move |
| Enter, l, → | details |
| Esc, h, ←, Backspace | back, or clear the filter |
| / | filter: rows whose name, folder, model, activity, session ID or PID hold the text; a session stays when one of its agents matches |
| s | sort: by state (waiting, unread, working, idle, ended), most recent, name, project |
| e | show or hide the sessions that ended |
| a | agents under their session: those at work, all, none |
| w | the window for "recently active": 1h, 6h, 24h, 3d, 7d |
| r | read everything again now |
| ? | help |
| q, Ctrl+C | quit (q in the details goes back) |

In the details: ↑ ↓ and PgUp PgDn scroll the events, Home and End go to the oldest and newest, and Tab and Shift+Tab go to the next and previous row.

## Where it looks

All in Claude Code's config folder (`~/.claude`, or `$CLAUDE_CONFIG_DIR`, or `--dir`), but for the desktop app's records:

- `sessions/<pid>.json`: one for each running Claude Code process, wherever it runs, with its session, folder, title and status (busy, waiting and for what, idle). Claude Code removes it when it exits.
- `projects/<project>/<session>.jsonl`: each session's transcript. The monitor reads its last MiB on first sight (more when that holds no message), then only what was appended, so a refresh costs a few milliseconds however long the transcripts are. The first prompt comes from its first bytes.
- `projects/<project>/<session>/subagents/agent-<id>.jsonl` and `.meta.json`: the session's subagents. `subagents/workflows/<run>/` holds a workflow's agents and its `journal.jsonl` (which agents started, returned or failed); `workflows/<run>.json` is the run's record once it ended, and `workflows/scripts/<name>-<run>.js` its script, which gives it its name.
- `jobs/<id>/state.json`: background sessions, with what they are doing or need.
- The Claude desktop app's records of its Code tab sessions: `claude-code-sessions/<account>/<org>/local_<id>.json` in `%APPDATA%\Claude` and `%LOCALAPPDATA%\Claude-Data\<package>\` on Windows, `~/Library/Application Support/Claude` on macOS, and `~/.config/Claude` elsewhere. They give each session's title, whether it is archived, and its model, effort and permission mode. They also give when you last opened it and when its last turn started or ended, which tell which sessions are unread.

And the processes: whether each PID in `sessions/` exists (signal 0, which only asks), and the process table (`tasklist` on Windows, `ps` elsewhere), read when a new PID turns up and every 10 seconds, for the program's name and memory.

## How it decides

- A session runs when its record in `sessions/` names a process that runs here and is Claude Code (`claude`, or the `node` or `bun` that runs it). A record whose process is gone, after a crash, or whose PID is now another program's, means the session ended.
- With no record, a transcript written in the last minute is `active`: Claude Code at work without a record, an older version say. A session seen running since the monitor started and now gone has ended, however recently it wrote.
- A session that ended is listed while its last record is within the window. That is the time written in the record, not the file's: when the desktop app quits, Claude Code appends its totals, with no time, to the transcript of each session open.
- A subagent started in the background says in its metadata when it finished or was stopped. One in the foreground is done once the tool call that started it has its result. An agent whose last reply ended its turn is done, and one with no call open that wrote nothing for 15 minutes counts as ended.
- A workflow runs until its record says how it ended, or, with no record, until its session ends or nothing is written for 15 minutes. Its agents' states come from its journal.
- A desktop app session is unread when all of these hold:
  - it is not at work;
  - its last turn ended after you last opened it in the app;
  - another session was open there when that turn ended.

  This is the app's blue dot: the app marks a session unread when one of its turns ends while you are in another session, and clears the dot when you open it.

## Limits

- These files are Claude Code's own, not a published interface, and a new version can change them. What the monitor can't read, it leaves out rather than failing.
- CTX is the context of the last reply (input, cache reads and cache writes). The output tokens are those of the part of the transcript read; the totals in the details are Claude Code's own, as it last saved them.
- It sees one config folder: one user's sessions.
- The app keeps its own list of unread sessions in its browser storage, which the monitor does not read. The monitor works the list out from the session records instead, so it can differ from the app in two ways:
  - A dot you set by hand with Mark as unread does not show.
  - A record keeps only the last time its session was opened. The monitor remembers every opening it sees while it runs, but for the time before it started it knows only each session's last one.
- A record from another computer sharing the folder, or from Windows when run in WSL, names a process it can't check, so that session counts as ended (or active while its transcript moves).

## Development

```bash
npm test
```

`bin/agentmonitor.js` reads the options and starts `src/tui.js` (the screen and the keys) or prints once with `src/view.js` (what is drawn). `src/monitor.js` puts a snapshot together from `src/registry.js`, `src/transcript.js`, `src/agents.js`, `src/jobs.js`, `src/desktop.js` and `src/procs.js`. The tests write a config folder as Claude Code does, and drive the monitor through a fake terminal.

## License

MIT
