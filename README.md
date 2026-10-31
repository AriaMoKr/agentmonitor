# agentmonitor

The Claude agents on this computer, live in a terminal, in a window of its own with an icon in the system tray, or in a browser here or on another computer: every Claude Code session that runs (in a terminal, the Claude desktop app's Code tab, an IDE or the background) or was active lately, what each one is doing now and how far through its task list it is, and the subagents and workflows it started. For the desktop app's sessions it also shows the app's summary of each one's last turn, which ones wait on you, and which ones the app shows as unread. At the top is how much of your plan's usage limits is used, the five-hour session's and the week's, as the desktop app last checked, carried on to now with what this computer's sessions used since, and about when each resets.

```
 ● 1 working  ◐ 1 in a tool  ◆ 1 waiting  ◇ 1 blocked  • 1 unread       session ~64% resets 15:10  week ~29% resets Thu
   PROJECT          NAME                      MODEL      EFFORT    CTX ACTIVITY                            LAST KIND
>◆ shop             Release 2.0               opus 5.5   high      88k waiting: permission: Bash     2m03s   2m cli
 ◇ shop             Pick the payment provider opus 5.5   xhigh+    73k blocked: choose Stripe or Adyen       7m desktop
 • infra            Plan the migration        opus 5.5   max      201k plan in MIGRATION.md: three steps,…  18m desktop
 ● docs             Write the API docs        sonnet 5.5 xhigh     64k 1 agent running               4m00s   2s vscode
 ● Review           └─ review-docs                                     Review: 2 running, 3/5 done   4m00s   2s workflow
 ● Review              ├─ review:examples     sonnet 5.5 high      52k Bash: Run the examples          41s   2s agent
 ● Review              └─ review:links        sonnet 5.5 low       24k WebFetch: https://example.com/a… 6s   6s agent
 ◐ shop             Fix the flaky upload test opus 5.5   high     142k 2/4 Bash: Run the upload tests  14s  14s desktop
 ● Explore          └─ find the retry logic   haiku 4.5  medium    31k Grep: retry in src               3s   3s agent
 ◎ docs             Preview the docs site     sonnet 5.5 medium    38k background: Bash: Serve the… 25m00s  24m cli
 ○ shop             Triage the issues         sonnet 5.5 high      41k Labelled 14 issues; 3 need a perso…   1h bg
 · tools            Upgrade the linter        opus 5.5   xhigh     96k Done: eslint 10 with the flat conf…   5h cli
 ↑↓ move  ⏎ details  / filter  s sort:status  e ended:on  a agents:running  w window  b bell:off  ? help  q quit  1/12
```

It only reads: Claude Code's own files, and which processes run. It changes nothing and needs no setup in Claude Code.

## Running it

Node 22 or later; there are no dependencies.

```bash
node bin/agentmonitor.js
```

For an `agentmonitor` command, run `npm link` in this folder.

In a terminal it runs full screen until you press q, reading everything again each second. When its output is not a terminal (a pipe, a file) it prints the table once instead, as `--once` does, and `--json` prints what it found as JSON. `--serve` shows it as a web page instead ([In a browser](#in-a-browser)), and `desktop/` holds it as an app with a window and a tray icon, to start from the Start menu with no terminal ([The agentmonitor app](#the-agentmonitor-app)).

On Windows it needs a console, which Windows Terminal, the console window, VS Code's terminal and the Claude desktop app's Terminal panel give programs whatever shell runs in them. MSYS2's bash runs there too: `C:\msys64\msys2_shell.cmd -defterm -here -no-start -ucrt64` starts it in the terminal it is run from. mintty (MSYS2, Git Bash, Cygwin) gives programs pipes instead, so there agentmonitor prints the table once and exits.

It draws every line again every 2 seconds, since a terminal can lose lines without telling the program (the desktop app's Terminal panel has), and Ctrl+L draws the screen again at once.

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
                         or finishes its turn (b turns it on or off; with
                         --serve, the page beeps)
      --ascii            draw with ASCII only
      --color, --no-color  colors on or off (default: on in a terminal,
                         off with NO_COLOR set)
      --no-mouse         leave the mouse to the terminal (to select text)
      --serve            serve the list and the details as a web page instead,
                         read only, at an address it prints, which holds a token
      --host <address>   where --serve listens: 127.0.0.1 (the default) is this
                         computer only; 0.0.0.0, every network it is on (then
                         its address is printed as a QR code too, for a phone)
      --port <n>         --serve's port (default 7420; 0 for any free one)
      --token <t>        the token in --serve's address, to keep it the same
                         (16 or more letters, digits, - and _; default: random)
  -v, --version
  -h, --help
```

Times are written as `30s`, `5m`, `2h`, `1d` or `1w`.

## The list

Each session is a row, with the agents it started under it: its subagents (the Agent tool) and its workflow runs, and a workflow's agents under the workflow. By default only the agents at work are listed; `a` lists all of them, or none.

| State | |
|---|---|
| ● working | the session is at work (a spinner while it lasts); for an agent, running |
| ◐ in a tool | it waits on a tool call it made, one that has run 3 seconds or more: a command, a build, a download (a slower spinner) |
| ◆ waiting | it needs you: a permission (in a terminal), a question to answer, a plan to approve, a session the desktop app offers to start |
| ◇ blocked | its last turn ended on something only you can do, a question to answer or a PR to open, as the desktop app's summary of the turn says. It shows in place of idle or ended, and of unread |
| • unread | the desktop app's blue dot: a session there finished a turn that you have not opened yet. It shows in place of idle or ended, and the app clears it when you open the session |
| ◎ background | it runs, its turn is over, and it waits on what it left running: a command in the background, or an agent or a workflow it started, still at work. It shows in place of idle |
| ○ idle | it runs, and waits for your next message |
| ◌ active | its transcript was written moments ago, by a process the monitor does not know |
| · ended | its process is gone |
| ✓ done, ✗ failed, ■ stopped | an agent or workflow that is over |

The columns: PROJECT is the session's folder (for an agent, its type; for a workflow, the phase it is in); NAME, its title (the one you gave it, the desktop app's, Claude's, or else the first prompt); MODEL, the model of its last reply; EFFORT, the reasoning effort it works at (`low`, `medium`, `high`, `xhigh` or `max`), with a `+` when ultracode is on (`max+`, or `ultra` when no effort is known); CTX, the context of its last reply in tokens; ACTIVITY, what it is doing, with how long that has taken; LAST, how long ago it last did anything; PID, its process; KIND, how it was started (`cli`, `desktop`, `vscode`, `sdk`, `bg` for a background session). On a narrow terminal the least needed columns go first.

ACTIVITY is the tool call it is in (`Bash: Run the tests`, `Edit: src/a.js`, `Agent: Explore: find the parser`), `thinking`, the agents it waits for, or what it waits for you to do (`waiting: a question: Which branch?`). While it works through a task list (the desktop app's, or TodoWrite's), it begins with how many of the steps are done: `2/4`. For a session that is idle or ended it is the desktop app's summary of its last turn (`blocked:` and what you are to do, when the turn ended on you), else its last reply, or the error that stopped it (a usage limit, say). A session that runs with a command left going on in the background, or an agent or a workflow it started still at work, shows that in place of the summary or the reply: `background: Bash: Serve the site`, `background: 1 agent running`.

The first line counts the sessions by the state they show, and the agents at work. At its right are how much of your plan's usage limits is used, about when each resets, and the time: `session ~64%` of its limit for five hours (the current session, as `/usage` calls it), `week ~29%` of its limit for the week, yellow from 75% and red from 90%. They come from the desktop app, which checks them about every 15 minutes while it runs: the monitor carries its latest check on to now with what the sessions on this computer used since, and the `~` says so, as it is an estimate. Where it can't tell how, it shows the check as it was, and once that is 45 minutes old, how old (`2h ago`). Without the desktop app there are none. On a narrow screen the first line leaves out what is needed least first: the time, the sessions that ended and the agents at work, the title and the sessions idle, in the background or active, those at work and the resets, then those that wait for you; the usage goes last.

The app keeps no reset times, so the monitor works them out from its earlier checks, and shows one only where they pin it down. The session's limit resets five hours after its window began, which shows as its percent rising from 0, or dropping, between two checks: `resets 15:10`, to five minutes, when the checks put that start within half an hour. The week's resets at the same time each week, which shows where drops of its percent agree, two of them at least: `resets Thu`, or the time once it is less than a day off and known within the hour. A percent is left out once its reset has surely come, or, with no reset known, five hours after the check for the session's, and seven days after for the week's.

To carry a check on, the monitor reads the replies in this computer's transcripts since a little before it, and weighs each one's tokens: output in full, input at its price against output's, cache writes and reads as the app's checks rose with them (writes at about their price, reads at about half of theirs), and each model at its price against Claude Opus 5.5's. The percents rose by so many points for so much of that between checks at most half an hour apart, and the latest of those rises give the rate they go on at: the session's last 60 points, within three days, and the week's last 20, within the week. The session's windows come from the replies too: one begins with the first reply asked for once the last window is over, and lasts five hours, so its reset is known closely. Only rises within such a window count, since a rise outside one was use elsewhere. A window begun since the check starts again from 0, and with no window now, the session is at `~0%`. The week is carried on only once its reset is known, and from 0 past it.

## Details

Enter shows everything known about the selected row, and its latest events: your prompts, its replies, its tool calls and what failed, newest at the bottom.

```
 ◐ Fix the flaky upload test                                                        in a tool · 14s
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

 Tasks  2/4 done
   ✓ Find why the upload test fails
   ✓ Make the retry wait for the server
   ▸ Run the upload tests
   ○ Check the other retries in src

 Agents  1 agent · 1 running
 ● Explore          find the retry logic           31k Grep: retry in src                    3s   3s

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

Tasks is its task list: the steps done, the one in progress and those to do, and `in an earlier turn` when none changed since your last prompt. A session that runs commands in the background lists them as Background, each with how long it has run. A session that ended shows the `claude --resume` command that takes it up again, run in its folder. A desktop app session shows when you last opened it there, and an unread one shows its last turn as Unread. A blocked one shows what you are to do as Blocked, with the app's summary of the turn under it, and its title line adds the summary's category when it is not the usual one (blocked, review ready). An agent's transcript is read while it works, and when its details are open, so a finished agent shows what it did too.

## Keys

| Key | |
|---|---|
| ↑ ↓, j k, PgUp PgDn, Home End | move |
| Enter, l, → | details |
| Esc, h, ←, Backspace | back, or clear the filter |
| / | filter: rows whose name, folder, model, effort, activity, session ID or PID hold the text (`ultracode` finds the sessions with it on); a session stays when one of its agents matches |
| s | sort: by state (waiting and blocked, unread, working, in the background, idle, ended), most recent, name, project |
| e | show or hide the sessions that ended |
| a | agents under their session: those at work, all, none |
| w | the window for "recently active": 1h, 6h, 24h, 3d, 7d |
| b | the bell, on or off: it rings when a session starts waiting for you, or finishes its turn (`--bell` starts with it on) |
| r | read everything again now |
| ? | help |
| Ctrl+L | draw the screen again |
| q, Ctrl+C | quit (q in the details goes back) |

In the details: ↑ ↓ and PgUp PgDn scroll the events, Home and End go to the oldest and newest, and Tab and Shift+Tab go to the next and previous row. In the help, when it is taller than the screen, ↑ ↓, PgUp PgDn and Home End scroll it, with how far down it is at the bottom (`12-33/33`); any other key goes back. On a screen narrower than 88 columns its lines wrap, each under the start of what it says, so nothing is cut at the right.

The mouse: a click selects a row, and a double click opens its details. A click below the rows selects none, and the footer shows `-/12` until a key or a click selects one again: ↓ the first row, ↑ the last. The wheel moves the selection, or scrolls the events in the details, or the help. A click on a column title sorts by it (NAME, PROJECT, LAST; ACTIVITY and the state column sort by state), one on a key in the footer presses it, and one on an agent in the details opens that agent. While the monitor has the mouse, most terminals select text with Shift held (some on macOS with Option); `--no-mouse` leaves the mouse to the terminal.

## In a browser

`--serve` shows the list and the details as a web page, which keeps itself up to date and takes the same keys and clicks (but q: a page is closed, not quit):

```bash
node bin/agentmonitor.js --serve
```

It prints the page's address and runs until Ctrl+C. It listens on 127.0.0.1, so only this computer can open the page. To open it from another computer on your network, have it listen on every interface:

```bash
node bin/agentmonitor.js --serve --host 0.0.0.0
```

It then prints an address for each of this computer's network addresses, such as `http://192.168.1.20:7420/…/`: open one on the other computer. The likeliest comes first, and virtual networks' last (WSL's, a virtual machine's, Docker's), since only this computer reaches them. Under the addresses it draws the first as a QR code, which a phone's camera opens, so a phone need not type the token. The code takes colors, to be black on white whatever the terminal's theme, so it is left out when they are off (with `--no-color` or `NO_COLOR`, or when the output is not a terminal); `--ascii` draws it with spaces, twice as large. On Windows, the first time Node.js listens there, Windows asks whether to let it take connections, and other computers reach it once you allow it on private networks. `--port` sets the port: 7420, unless you give another, or 0 for any free one.

What keeps it to you:

- Every address begins with a random token, which only the printed addresses hold (and the QR code of the first): without it, every request gets a 404. A new token is made each time it starts, unless you give one with `--token` (16 or more letters, digits, `-` and `_`), which keeps a bookmark working. Anyone with the address sees everything the monitor shows, your prompts and folders among it, so give it only to whom you would show your screen.
- It is plain HTTP: on a network shared with others, they can read what goes by, the token too. Use `--host 0.0.0.0` on networks you trust.
- It only reads, as in a terminal. It answers GET and HEAD and nothing else, and what a page sends, its keys and clicks, moves only that page's view, but for `w`: the window for "recently active" is the same for every page.
- The page runs only its own script and style (its Content-Security-Policy forbids anything else), puts the text it is sent in as text, never as markup, and keeps nothing: no cookies, nothing cached.

Each page has its own view: the row selected, the filter, the details open. A page that stops asking for 10 minutes is forgotten. It draws on a grid of monospace cells in a terminal's colors, dark or light as the browser prefers, and while you select text it holds still, so the selection stays.

Its title counts the sessions that wait for you: `(2) Claude agents on <computer>`. Each page has its own bell too, a short beep, which `b` turns on or off and `--bell` starts with on; it rings only for what happens once it is on. A browser lets a page sound only after a tap, a click or a key on it, so until then the page says so at the bottom. A page out of sight (in another tab, or minimized) asks every 3 seconds, for its title and its bell only, so it still beeps.

On a phone, a tap is a click: on a row, twice to open it, below the rows to select none, or on a key in the footer. A finger dragged up or down takes the list's selection with it, a row for each line it goes, and the events of the details and the help, as a phone scrolls a page: up for what is further down. A tap on `/ filter` opens the phone's keyboard, and what you type shows in the footer, above the keyboard; its Enter keeps the filter, and `esc clear` clears it.

## The agentmonitor app

`desktop/` holds agentmonitor as an app, made with Electron: the web page in a window of its own, and an icon in the system tray that shows when a session needs you. Once set up it needs no terminal, and it goes on in the tray with its window closed.

```bash
cd desktop
npm install
npm start
```

Electron is its only dependency, kept in that folder: the monitor itself has none. The first start downloads Electron's own program, about 100 MB (360 MB unpacked), once; `npx install-electron` does that ahead. It also puts agentmonitor in the Start menu on Windows, or in the applications menu on Linux, to start it from there after that.

The window shows the page `--serve` serves, with the same keys and clicks, but q quits, as in a terminal (in the details it goes back). The monitor runs inside it and serves the page to its window alone: on 127.0.0.1, at a free port, with a new token each time. Ctrl+= and Ctrl+- make the page bigger and smaller, and Ctrl+0 sets it back; it keeps that, and where the window was.

Closing the window, or Ctrl+W, leaves agentmonitor running in the tray, and so does minimizing it, unless you turn that off. A click on the icon shows the window again, and so does starting agentmonitor again. q, Ctrl+Q, or Quit in the icon's menu, quits it.

The icon shows what matters most now:

| Icon | |
|---|---|
| ◆ yellow | a session waits for you, or is blocked |
| • blue | one is unread |
| ● green | one is at work |
| ◎ cyan | one waits on what it left running in the background |
| ○ cyan | the sessions that run are idle |
| ○ grey | none runs |

Its tooltip counts the sessions and gives the plan's usage. Its menu lists the sessions that need you, then the unread ones (a click on one shows the window), and the counts and the usage under them, then these switches, which it keeps:

- Notify when a session needs you or ends its turn: a notification when the bell would ring. Off until you turn it on, and on Windows shown only while its settings let apps notify (Settings, System, Notifications).
- Minimize to the tray: on at first.
- Start at login, in the tray: off at first.
- In the Start menu, or In the applications menu: there after the first start. Taken out here, it stays out.

How many sessions need you shows on the window's taskbar button on Windows, next to the icon on macOS, and as a badge where a Linux desktop shows one. `npm start -- --hidden` starts it in the tray with the window not shown, as it starts at login, and `npm start -- --quit` quits the one that runs.

It writes only its own files:

- its settings and its icons, in its folder: `%APPDATA%\agentmonitor` on Windows, `~/Library/Application Support/agentmonitor` on macOS, `~/.config/agentmonitor` on Linux. Electron keeps its caches there too.
- its Start menu shortcut, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\agentmonitor.lnk`, or on Linux `~/.local/share/applications/agentmonitor.desktop`. On Windows its notifications go with the shortcut: without it, they may not show.
- to start at login, Windows' Run key for your account, or `~/.config/autostart/agentmonitor.desktop` on Linux.

It reads what `--serve` reads, from `$CLAUDE_CONFIG_DIR` or `~/.claude`, with "recently active" at 24 hours. It was tried on Windows 11. It should run on macOS and Linux, untried there: on macOS it offers no start at login or menu entry, which would take a packaged app, and a Linux desktop shows the icon only when it has a tray (GNOME needs an extension for one).

## Where it looks

All in Claude Code's config folder (`~/.claude`, or `$CLAUDE_CONFIG_DIR`, or `--dir`), but for the desktop app's files:

- `sessions/<pid>.json`: one for each running Claude Code process, wherever it runs, with its session, folder, title and status (busy, waiting and for what, idle). Claude Code removes it when it exits.
- `projects/<project>/<session>.jsonl`: each session's transcript. The monitor reads its last MiB on first sight (more when that holds no message, or changes a task list made before it), then only what was appended, so a refresh costs a few milliseconds however long the transcripts are. The first prompt comes from its first bytes.
- `projects/<project>/<session>/subagents/agent-<id>.jsonl` and `.meta.json`: the session's subagents. `subagents/workflows/<run>/` holds a workflow's agents and its `journal.jsonl` (which agents started, returned or failed); `workflows/<run>.json` is the run's record once it ended, and `workflows/scripts/<name>-<run>.js` its script, which gives it its name.
- `jobs/<id>/state.json`: background sessions, with what they are doing or need.
- The Claude desktop app's records of its Code tab sessions: `claude-code-sessions/<account>/<org>/local_<id>.json` in `%APPDATA%\Claude` and `%LOCALAPPDATA%\Claude-Data\<package>\` on Windows, `~/Library/Application Support/Claude` on macOS, and `~/.config/Claude` elsewhere. They give each session's title, whether it is archived, its model, effort and permission mode, whether ultracode is on, and the app's summary of its last turn. They also give when you last opened it and when its last turn started or ended, which tell which sessions are unread.
- The desktop app's `plan-usage-history.json`, in the same folders: how much of your plan's usage limits was used, as the app checked about every 15 minutes while it ran, for the last month or so. The monitor reads its latest check, and works out the resets from the others.
- For the usage, the transcripts again, each session's, subagent's and workflow agent's, for the tokens of every reply since a little before the app's last check: a long one from about that time, found by its records' times, then only what was appended, in the background and at most every 10 seconds (printed once, the monitor waits for it).

And the processes: whether each PID in `sessions/` exists (signal 0, which only asks), and the process table (`tasklist` on Windows, `ps` elsewhere), read when a new PID turns up and every 10 seconds, for the program's name and memory.

## How it decides

- A session runs when its record in `sessions/` names a process that runs here and is Claude Code (`claude`, or the `node` or `bun` that runs it). A record whose process is gone, after a crash, or whose PID is now another program's, means the session ended.
- With no record, a transcript written in the last minute is `active`: Claude Code at work without a record, an older version say. A session seen running since the monitor started and now gone has ended, however recently it wrote.
- A session at work waits on you when the tool call it is in asks you something: a question (AskUserQuestion), a plan to approve (ExitPlanMode), or a session the desktop app offers to start. In a terminal, Claude Code's record also says when it waits for a permission.
- A session or agent is in a tool when a call it made, other than one that starts an agent, has had no result for 3 seconds.
- The task list is the last one made, replayed from the calls that changed it and did not fail: the desktop app's `update_plan` (a new list, the next step, steps done, a step started) and `wrap_up` (which checks off the step in progress), or TodoWrite's list. Its count shows while the session is at work and no prompt came after the list last changed.
- Claude Code writes the effort with each reply: the turn's, else the session's. A session at work shows that of its turn. One that is idle or ended shows the desktop app's setting when the app has one, since its next turn takes it (it can have been changed since the last reply), else that of its last reply. An agent shows its own, from its transcript while it works or its details are open; a workflow run has none of its own.
- Ultracode can be wrong. A desktop app session shows the app's setting for it. Any other session shows it once a reminder of it turns up in the part of its transcript read. Claude Code sends that reminder after the first prompt, after about every tenth one since, and after a compaction, so the first read of a long transcript can miss it. And nothing in the transcript says when ultracode was turned off.
- A command goes on in the background from the result of the call that started it (`Command running in background with ID: …`, or moved there after its timeout) until the message about its end comes in, or TaskStop stops it. Those of a session whose process is gone are not shown. A session that runs, its turn over, is in the background while a command of its goes on, or an agent or a workflow it started is at work.
- A session that ended is listed while its last record is within the window. That is the time written in the record, not the file's: when the desktop app quits, Claude Code appends its totals, with no time, to the transcript of each session open.
- A subagent started in the background says in its metadata when it finished or was stopped. One in the foreground is done once the tool call that started it has its result. An agent whose last reply ended its turn is done, and one with no call open that wrote nothing for 15 minutes counts as ended.
- A workflow runs until its record says how it ended, or, with no record, until its session ends or nothing is written for 15 minutes. Its agents' states come from its journal.
- A desktop app session is unread when all of these hold:
  - it is not at work;
  - its last turn ended after you last opened it in the app;
  - another session was open there when that turn ended.

  This is the app's blue dot: the app marks a session unread when one of its turns ends while you are in another session, and clears the dot when you open it.
- A few seconds after a turn of a desktop app session ends, the app writes its summary of the turn: a category (completed, blocked, review ready), a few words on what it came to, and, when it is blocked, what you are to do. The monitor uses a summary while the session is not at work, and only one that names the transcript's last reply: it is not used before the app writes it, nor for a turn the app did not sum up, nor once the session went on. A blocked summary marks the session blocked.

## Limits

- These files are Claude Code's own, not a published interface, and a new version can change them. What the monitor can't read, it leaves out rather than failing.
- CTX is the context of the last reply (input, cache reads and cache writes). The output tokens are those of the part of the transcript read; the totals in the details are Claude Code's own, as it last saved them.
- It sees one config folder: one user's sessions.
- The turn summaries are the desktop app's: a session in a terminal or an IDE has none, and so is never blocked.
- The usage starts from the desktop app's checks: without the app there is none. Carried on from the last one, it is an estimate, and the longer ago that check, the further off it can be. It counts only what the sessions here used, in this config folder: use since then on claude.ai, on another computer or in another config folder is missing, and so is a session window one of those began. Its rate is that of the latest rises, and it drifts when the way you work changes (the models, how much is cached). The resets are worked out from the checks and the replies, and can be off. A session window begun elsewhere and used so little that the app still read 0% looks as if it began later, so its reset comes earlier than shown. A week's reset shows only once its percent was seen to drop at that time twice. `/usage` in Claude Code says them exactly.
- The desktop app's yellow dot is a session that waits on you: a permission to give, or a question to answer. Its questions, plans to approve and offers of a session are tool calls in the transcript, so they show as waiting. Its permission prompts are kept in the app's memory, in no file: a session waiting on one shows as in a tool, the call it asks about.
- The app keeps its own list of unread sessions in its browser storage, which the monitor does not read. The monitor works the list out from the session records instead, so it can differ from the app in two ways:
  - A dot you set by hand with Mark as unread does not show.
  - A record keeps only the last time its session was opened. The monitor remembers every opening it sees while it runs, but for the time before it started it knows only each session's last one.
- A record from another computer sharing the folder, or from Windows when run in WSL, names a process it can't check, so that session counts as ended (or active while its transcript moves).

## Development

```bash
npm test
```

`bin/agentmonitor.js` reads the options and starts `src/tui.js` (the screen, the keys and the mouse) or `src/serve.js` (the web view, with its page in `src/web/`), or prints once with `src/view.js` (what is drawn, and where a click on it goes). `src/viewer.js` holds what one look at the monitor shows and what keys and clicks do to it: the terminal has one, and the web view one for each page. `src/monitor.js` puts a snapshot together from `src/registry.js`, `src/transcript.js`, `src/agents.js`, `src/jobs.js`, `src/desktop.js`, `src/usage.js` (the plan's usage, carried on with the replies `src/ledger.js` reads) and `src/procs.js`. `desktop/main.js` is the agentmonitor app, around `src/serve.js`: the window, the tray and the settings; `desktop/tray.js` says what the tray shows and what to notify, `desktop/icons.js` draws its icons as PNG and ICO, and `desktop/launch.js` writes Linux's menu entries. The tests write a config folder as Claude Code does, drive the monitor through a fake terminal, ask the web view on a free port of 127.0.0.1, and check the agentmonitor app's parts that need no Electron.

## License

MIT
