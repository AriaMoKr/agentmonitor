# agentmonitor

The Claude agents on this computer, live in a terminal, in a window of its own with an icon in the system tray, or in a browser here or on another computer: every Claude Code session that runs (in a terminal, the Claude desktop app's Code tab, an IDE or the background) or was active lately, what each one is doing now and how far through its task list it is, and the subagents and workflows it started. For the desktop app's sessions it also shows the app's summary of each one's last turn, which ones wait on you, and which ones the app shows as unread. At the top is how much of your plan's usage limits is used, the five-hour session's and the week's, as the desktop app last checked, carried on to now with what this computer's sessions used since, and about when each resets. Below the list, where it leaves room, the sessions are cards on a board, in columns by what they wait for; `v` turns that room to fourteen other views, from an overview (the selected session at more length, the other sessions that need you, what was said lately, and the usage at the pace it goes) and the sessions as figures at their keys to the usage as a tank the replies drip into.

```
 ● 1 working  ◐ 1 in a tool  ◆ 1 waiting  ◇ 1 blocked  • 1 unread       session ~64% resets 15:10  week ~29% resets Thu
   PROJECT          NAME                   MODEL      EFFORT    CTX CACHE ACTIVITY                         LAST KIND
>◆ shop             Release 2.0            opus 5.5   high      88k   58m waiting: permission: Bash  2m03s   2m cli
 ◇ shop             Pick the payment prov… opus 5.5   xhigh+    73k   53m blocked: choose Stripe or Adyen    7m desktop
 • infra            Plan the migration     opus 5.5   max      201k   42m plan in MIGRATION.md: three ste…  18m desktop
 ● docs             Write the API docs     sonnet 5.5 xhigh     64k       1 agent running            4m00s   2s vscode
 ● Review           └─ review-docs                                        Review: 2 running, 3/5 do… 4m00s   2s workflow
 ● Review              ├─ review:examples  sonnet 5.5 high      52k       Bash: Run the examples       41s   2s agent
 ● Review              └─ review:links     sonnet 5.5 low       24k       WebFetch: https://example.co… 6s   6s agent
 ◐ shop             Fix the flaky upload … opus 5.5   high     142k       2/4 Bash: Run the upload te… 14s  14s desktop
 ● Explore          └─ find the retry log… haiku 4.5  medium    31k       Grep: retry in src            3s   3s agent
 ◎ docs             Preview the docs site  sonnet 5.5 medium    38k   36m background: Bash: Serve … 25m00s  24m cli
 ○ shop             Triage the issues      sonnet 5.5 high      41k       Labelled 14 issues; 3 need a pe…   1h bg
 · tools            Upgrade the linter     opus 5.5   xhigh     96k       Done: eslint 10 with the flat c…   5h cli
 ↑↓ move  ⏎ details  / filter  v view  s sort:status  e ended:on  a agents:running  w window  ? help  q quit      1/12
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
      --show-archived    list the sessions archived in the desktop app too
  -1, --once             print the table once and exit
      --json             print what was found as JSON and exit
      --dir <path>       Claude Code's config folder (default: $CLAUDE_CONFIG_DIR,
                         else ~/.claude)
      --bell             ring the bell when a session starts waiting for you,
                         or finishes its turn (b turns it on or off; with
                         --serve, the page beeps)
      --view <name>      the view below the list to start with: board (the
                         default), overview, floor, bands, lanes, ticker,
                         pipeline, files, chart, share, projects, today,
                         tank, radar or spark (v and V step through them)
      --plan-price <n>   the plan's price a month, in dollars (200, say), for
                         what the week's use came to: in the list's WEEK and
                         TOTAL, the share and projects views, the tank and a
                         session's details
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
| ◇ blocked | its last turn ended on something only you can do: a question the desktop app's next-step box asks you, till you answer it or close the box, or what the app's summary of the turn says you are to do (a PR to open, say). It shows in place of idle or ended, and of unread, till you dismiss it with `x` |
| • unread | the desktop app's blue dot: a session there finished a turn that you have not opened yet. It shows in place of idle or ended, and the app clears it when you open the session (or `x` dismisses it here) |
| ◎ background | it runs, its turn is over, and it waits on what it left running: a command in the background, or an agent or a workflow it started, still at work. It shows in place of idle |
| ○ idle | it runs, and waits for your next message |
| ◌ active | its transcript was written moments ago, by a process the monitor does not know |
| · ended | its process is gone. One the desktop app archived (which ends it) is put away: it is listed only when `e` shows all that ended |
| ✓ done, ✗ failed, ■ stopped | an agent or workflow that is over |

The columns: PROJECT is the session's folder (for an agent, its type; for a workflow, the phase it is in); NAME, its title (the one you gave it, the desktop app's, Claude's, or else the first prompt); MODEL, the model of its last reply; EFFORT, the reasoning effort it works at (`low`, `medium`, `high`, `xhigh` or `max`), with a `+` when ultracode is on (`max+`, or `ultra` when no effort is known); CTX, the context of its last reply in tokens; CACHE, while it is not at work, how much longer the prompt cache keeps that context (yellow in its last ten minutes; after that, its next reply writes it all again); ACTIVITY, what it is doing, with how long that has taken; LAST, how long ago it last did anything; with the plan's price (`--plan-price`, or the agentmonitor app's menu), WEEK, what the session's use (its agents' with it) came to since the week's limit reset or your plan changed, as its details say, and TOTAL, what it came to in all its replies read here, back to the desktop app's first check of the usage (about 30 days); PID, its process; KIND, how it was started (`cli`, `desktop`, `vscode`, `sdk`, `bg` for a background session). On a narrow terminal the least needed columns go first.

ACTIVITY is the tool call it is in (`Bash: Run the tests`, `Edit: src/a.js`, `Agent: Explore: find the parser`), `thinking`, the agents it waits for, or what it waits for you to do (`waiting: a question: Which branch?`). While it works through a task list (the desktop app's, or TodoWrite's), it begins with how many of the steps are done: `2/4`. For a session that is idle or ended it is the question its last turn ended on (`blocked: Take out the 15 broadcasts?`), or the desktop app's summary of that turn (`blocked:` and what you are to do, when the turn ended on you), else its last reply, or the error that stopped it (a usage limit, say). A session that runs with a command left going on in the background, or an agent or a workflow it started still at work, shows that in place of the summary or the reply: `background: Bash: Serve the site`, `background: 1 agent running`.

The first line counts the sessions by the state they show (but those put away), and the agents at work. At its right are how much of your plan's usage limits is used, about when each resets, and the time: `session ~64%` of its limit for five hours (the current session, as `/usage` calls it), `week ~29%` of its limit for the week, yellow from 75% and red from 90%. They come from the desktop app, which checks them about every 15 minutes while it runs: the monitor carries its latest check on to now with what the sessions on this computer used since, and the `~` says so, as it is an estimate. Where it can't tell how, it shows the check as it was, and once that is 45 minutes old, how old (`2h ago`). Without the desktop app there are none. On a narrow screen the first line leaves out what is needed least first: the time, the sessions that ended and the agents at work, the title and the sessions idle, in the background or active, those at work and the resets, then those that wait for you; the usage goes last.

The app keeps no reset times, so the monitor works them out from its earlier checks, and shows one only where they pin it down. The session's limit resets five hours after its window began, which the server puts on the 10-minute mark at or before its first use, and which shows as its percent rising from 0, or dropping, between two checks: `resets 15:10` when the checks put that start within half an hour. The week's resets at the same time each week, which shows where drops of its percent agree, two of them at least: `resets Thu`, or the time once it is less than a day off and known within the hour. A percent is left out once its reset has surely come, or, with no reset known, five hours after the check for the session's, and seven days after for the week's.

To carry a check on, the monitor reads the replies in this computer's transcripts since a little before it, and weighs each one's tokens: output in full, input at its price against output's, cache writes and reads as the app's checks rose with them (writes at about their price, reads at about half of theirs), and each model at its price against Claude Opus 5.5's. The percents rose by so many points for so much of that between checks at most half an hour apart, and the latest of those rises give the rate they go on at: the session's last 60 points, within three days, and the week's last 20, within the week. The session's windows come from the replies too: once the last window is over, one begins on the 10-minute mark at or before the first reply asked for, and lasts five hours, so its reset is known to the minute while the use is all here. Only rises within such a window count, since a rise outside one was use elsewhere. A window begun since the check starts again from 0, and with no window now, the session is at `~0%`. The week is carried on only once its reset is known, and from 0 past it.

## Below the list

Where the rows leave room below them, the monitor fills it with one of fourteen views: at first the board, the sessions as cards in columns by what they wait for (`--view` starts with another), and `v` and `V` step through the others. The overview has the selected session, what needs you, what was said and the usage, each part where there is room for it:

```
 ─ ◆ shop · Release 2.0 ───────────────────────────────────────────────────────── waiting · 2m03s ─
 Waiting    permission: Bash  (2m03s)
 Tasks      3/5  ▸ Tag the release
 13:15:32     you    Tag 2.0 and push the tag once the tests pass.
 13:17:05     claude The tests pass; tagging 2.0 and pushing the tag.
 ─ Needs you ──────────────────────────────────────────────────────────────────────────────────────
 ◇ shop · Pick the payment provider  7m  choose Stripe or Adyen
 • infra · Plan the migration  18m  plan in MIGRATION.md: three steps, the schema first
 ─ Activity ───────────────────────────────────────────────────────────────────────────────────────
 13:02:47 infra            claude The plan is in MIGRATION.md: three steps, the schema first.
 13:12:30 shop             claude Both fit. Stripe or Adyen? Adyen costs less above 10k a month.
 13:15:32 shop             you    Tag 2.0 and push the tag once the tests pass.
 13:16:20 docs             you    Write the API docs from openapi.yaml.
 13:17:05 shop             claude The tests pass; tagging 2.0 and pushing the tag.

 ─ Usage ──────────────────────────────────────────────────────────────────────────────────────────
 session ███████████████│░░░░░░░░  ~64%  resets 15:10 in 1h50m · +24%/h: 100% at 14:50, 20m before
 week    ███████░░░░░░░│░░░░░░░░░  ~29%  resets Thu 10:00 in 2d20h · +7%/d: about 49% by then
```

- The selected session or agent: what it is doing, waits for or did last, in full where the list cuts it short, the commands it left running in the background, how far through its task list it is, and its latest prompts and replies.
- Needs you: the other sessions that wait for you or are blocked, with what for, and those unread, with the reply you have not read.
- Activity: what was said lately in the sessions listed, their prompts, replies and errors, the newest at the bottom.
- Usage, at the bottom: each limit as a bar of how much of it is used, marked `│` where its time has gone to (how far the session's five hours are through, and the week's seven days). Then when it resets, and its pace: the session's, the points the last hour's replies on this computer came to (`+24%/h`); the week's, what its percent rose by over the days since it reset, or since your plan changed where that is later, once a day has gone (`+7%/d`). At that pace, it says when the limit reaches 100%, in yellow, where that comes before it resets, and else about how much it comes to by then.

The rows come first. The room they leave goes first to the usage, then to the selected one, then to what needs you, and the activity takes the rest, so on a short screen there is less of it, or none. On a screen narrower than 64 columns the usage has no bars, and its lines wrap. A click on a session or an agent there opens its details, and one anywhere else selects none.

That is the overview. `v` shows the next view of the room, and `V` the one before; the footer then says which it is and what it shows, and the help lists them all, the one shown marked. The floor, as it shows the sessions of the list above:

```
 ─ Floor ───────────────────────────────────────────────────────── 2 at work · 3 for you · 2 idle ─
  ? permission: Bash  ! choose Stripe o…  • plan in MIGRATI…  1 agent running
   \o/                 \o/                  o []                o    Oo 3/5
    |                   |                  /|/                 /|_[]
   / \                 / \                 / \                 / \
 >◆ Release 2.0       ◇ Pick the paymen…  • Plan the migrat…  ⠋ Write the API d…

  >_ Run the upload…  ◎ Bash: Serve the…
    o                   o                     Z
   /|\          o      <|>                   z
   / \          |      / \                ___o
  ◐ Fix the flaky u…  ◎ Preview the doc…  ○ Triage the issu…

   · ended: Upgrade the linter 5h ago
```

| View | |
|---|---|
| overview | the selected session, what needs you, what was said lately, and the usage at its pace, as above |
| floor | each session that runs as a figure, posed by what it does: at its keys while it works, tapping its foot under what it runs while a tool call takes a while, waving when it waits for you, holding up a reply you have not read, asleep while idle. The agents it started walk beside it, and a workflow's agents at work stand in a crowd, with how far the workflow has come |
| board | the view at first: the sessions as cards in columns, needs you, working, background, idle, and on a wide screen ended. For 4 seconds a card that moved stands out, with the column it came from, and leaves a ghost there |
| bands | the floor's figures in a band for each of the board's first two columns, what needs you on top and what works under it, and the sessions of the others (in the background, idle, ended) named below, each column on a line of its own where there is room. For 4 seconds a figure that moved stands out, with the column it came from over its head, and the band it left names it. Where the room is short, a band gets fewer lines of figures, or names its sessions on its own line |
| lanes | a lane for each session over the last half hour or more, a column for each 10 seconds to 10 minutes as the width takes: its turns `█`, its tool calls that ran 3 seconds or more `▒`, the time it waited on you `?`, your prompts `▲`, and `·` while it ran idle between them |
| ticker | the tool calls of the sessions listed and of their agents: those still open first, with how long they have run, then the others, the latest first, with how long they took, `✗` where one failed |
| pipeline | each workflow, with its phases in the order they began, each agent in them a mark: at work (a spinner), done or failed; under them, the sessions' own agents |
| files | the files the sessions changed in the last hour, the latest first: how often, by whom and when, `✎` on one being changed now, and `!` on one that two sessions or more changed |
| chart | the session's percent over its five hours and the week's over its seven days, as the desktop app checked them, carried on to now, and on to the reset at its pace (yellow where that reaches 100% first). Under them, where there is room, the rate: the tokens 1% of the week came to, weighed as the usage is carried on with, over all the days the app's checks go back (about 30). At each check it is what the latest rises of the week's percent came to then, as the week is carried on, but counted only from the plan's last change before it; the line breaks at each change, where a dotted line goes down. On a tall screen, when in the day the session's limit was used over the last week |
| share | the points of each limit each session on this computer used, the most first, those the replies read here leave out (use elsewhere), and the points by model. With the plan's price (`--plan-price`, or the agentmonitor app's menu), the week's in dollars too: the week's percent of a week's price, and each session's, model's and elsewhere's points of it |
| projects | the sessions by project (their folder's last part), the most used of the week first: the points of the week each project's sessions here used, those not listed too, as a bar against the most (with the plan's price, in dollars too), how long ago one of them was last active, and its sessions listed, a glyph each, what needs you first; then what the replies read here leave out (use elsewhere). A click on a project lists its sessions alone, as the footer says, till Esc or a click on it again; one on a session's glyph opens it. `p`, or a click on the heading, shows them by folder: each project under the folders it is in, as the paths its sessions ran in say them (a drive's in any case: `C:\Git` and `c:/git` are one), and each folder with what those in it came to and when one of them was last active. A folder that holds one folder and no session shares its line with it (`git\work\`), and a session of no known folder goes by its project's name. `p` again shows them by name |
| today | what the sessions here did since midnight: the sessions, agents, prompts and replies, the time they waited on you, the tokens, the models' shares, the replies hour by hour, and the tools called, the most first |
| tank | the session's limit as a tank as full as its percent, each reply a drop as big as its points, falling in about 15 seconds after it was written; its pace (the last hour's) and its reset, and the week's tank beside it with its own. Where the session's percent is not known, as after a change of plan, when the desktop app's checks can leave it out, the replies drip into the week's tank. With the plan's price, beside the week's tank what it comes to in dollars: full (a week of the plan), as full as it is, and at its pace an hour |
| radar | each session a blip, nearer the middle the more lately it did something (rings at a minute, ten, an hour and the window), and a sweep going round that lights those that just did; the sessions beside it, the latest first |
| spark | one spark for all the sessions: it turns the faster the more of them work, waves when one needs you, sleeps when none works, and goes yellow, then red, as a limit nears |

The floor, the bands, the pipeline, the tank, the radar and the spark move of themselves: while one shows, the terminal draws it ten times a second, and a web page asks for it four times a second. A click on a session or an agent in a view opens its details, one on a project in the projects view lists its sessions alone, one on that view's heading shows the projects by folder or by name, as `p` does, and one anywhere else selects none. The views show what the monitor reads anyway: the lanes, the ticker, the pipeline and the files what was read of each transcript (its last MiB on first sight, then what was appended; its latest 200 tool calls and 100 turns), and the chart, the share, the projects, today and the tank the desktop app's checks and this computer's replies, which the monitor reads back to midnight for today, and to the first of the checks for the chart's rate (a few seconds in the background as it starts, then only what was appended).

## Details

Enter shows everything known about the selected row, and its latest events: your prompts, its replies, its tool calls and what failed, newest at the bottom. For a session blocked on a question, that includes the answers the buttons of the desktop app's next-step box give (`Answers`). For a session not at work, it includes its prompt cache: till when it keeps the context, or since when it has not, and what a reply after that adds, writing it all again (`Cache miss`).

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

Tasks is its task list: the steps done, the one in progress and those to do, and `in an earlier turn` when none changed since your last prompt. A session that runs commands in the background lists them as Background, each with how long it has run. A session that ended shows the `claude --resume` command that takes it up again, run in its folder. A desktop app session shows when you last opened it there, and an unread one shows its last turn as Unread. With the plan's price, a session shows as Plan what its points of the week's limit came to since the week reset, or since your plan changed where that is later. A blocked one shows what you are to do as Blocked, with the app's summary of the turn under it, and its title line adds the summary's category when it is not the usual one (blocked, review ready), or `dismissed` once you dismissed it with `x`. An agent's transcript is read while it works, and while it is selected, below the list or in its details, so a finished agent shows what it did too.

## Keys

| Key | |
|---|---|
| ↑ ↓, j k, PgUp PgDn, Home End | move |
| Enter, l, → | details |
| Esc, h, ←, Backspace | back, or clear the filter and the project listed alone |
| x | dismiss what the selected session's last turn left you, a question (blocked) or a reply you have not read (unread), till its next reply: it counts as neither then, and `x` again brings it back. While there is something to dismiss, the footer offers it (`x dismiss`, `x bring back`). Every view of the monitor sees it, each page of the web view too |
| / | filter: rows whose name (or the one an earlier run had), folder, model, effort, activity, session ID or PID hold the text (`ultracode` finds the sessions with it on, `archived` those the desktop app archived); a session stays when one of its agents matches |
| s | sort: by state (waiting and blocked, unread, working, in the background, idle, ended), most recent, name, project |
| e | the sessions that ended: all but those the desktop app archived (at first), none, or all (`--hide-ended` starts with none, `--show-archived` with all) |
| a | agents under their session: those at work, all, none |
| w | the window for "recently active": 1h, 6h, 24h, 3d, 7d |
| b | the bell, on or off: it rings when a session starts waiting for you, or finishes its turn (`--bell` starts with it on) |
| v, V | the next view below the list, or the one before ([Below the list](#below-the-list)) |
| p | the projects view by folder, or by name again; from another view, the projects by folder. While the projects view shows, the footer says which (`p paths:on`) |
| r | read everything again now |
| ? | help |
| Ctrl+L | draw the screen again |
| q, Ctrl+C | quit (q in the details goes back) |

In the details: ↑ ↓ and PgUp PgDn scroll the events, Home and End go to the oldest and newest, Tab and Shift+Tab go to the next and previous row, and `x` dismisses the session, as in the list. In the help, when it is taller than the screen, ↑ ↓, PgUp PgDn and Home End scroll it, with how far down it is at the bottom (`12-33/33`); any other key goes back. On a screen narrower than 88 columns its lines wrap, each under the start of what it says, so nothing is cut at the right.

The mouse: a click selects a row, and a double click opens its details. A click below the rows selects none, and the footer shows `-/12` until a key or a click selects one again: ↓ the first row, ↑ the last; but one on a session or an agent shown there ([Below the list](#below-the-list)) opens its details. The wheel moves the selection, or scrolls the events in the details, or the help. A click on a column title sorts by it (NAME, PROJECT, LAST; ACTIVITY and the state column sort by state), one on a key in the footer presses it, and one on an agent in the details opens that agent. While the monitor has the mouse, most terminals select text with Shift held (some on macOS with Option); `--no-mouse` leaves the mouse to the terminal.

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
- It only reads, as in a terminal. It answers GET and HEAD and nothing else, and what a page sends, its keys and clicks, moves only that page's view, but for `w`: the window for "recently active" is the same for every page; and `x`: a session dismissed is dismissed for every page.
- The page runs only its own script and style (its Content-Security-Policy forbids anything else), puts the text it is sent in as text, never as markup, and keeps nothing: no cookies, nothing cached.

Each page has its own view: the row selected, the filter and the project listed alone, the details open. A page that stops asking for 10 minutes is forgotten. It draws on a grid of monospace cells in a terminal's colors, dark or light as the browser prefers, and while you select text it holds still, so the selection stays.

Its title counts the sessions that wait for you: `(2) Claude agents on <computer>`. Each page has its own bell too, a short beep, which `b` turns on or off and `--bell` starts with on; it rings only for what happens once it is on. A browser lets a page sound only after a tap, a click or a key on it, so until then the page says so at the bottom. A page out of sight (in another tab, or minimized) asks every 3 seconds, for its title and its bell only, so it still beeps. One that shows a view below the list that moves of itself asks four times a second while it does.

On a phone, a tap is a click: on a row, twice to open it, below the rows to select none (or on a session there, to open it), or on a key in the footer. A finger dragged up or down takes the list's selection with it, a row for each line it goes, and the events of the details and the help, as a phone scrolls a page: up for what is further down. A tap on `/ filter` opens the phone's keyboard, and what you type shows in the footer, above the keyboard; its Enter keeps the filter, and `esc clear` clears it.

## The agentmonitor app

`desktop/` holds agentmonitor as an app, made with Electron: the web page in a window of its own, and an icon in the system tray that shows when a session needs you, with the page again in a small window by it. On Windows its taskbar button shows the plan's usage and the sessions too. Once set up it needs no terminal, and it goes on in the tray with its window closed.

On Windows, take the zip from the latest [release](https://github.com/AriaMoKr/agentmonitor/releases), unzip it anywhere, and run `agentmonitor.exe` in it. It is not signed, so Windows may say it protected your PC: More info, then Run anyway. Elsewhere, or to run it from here:

```bash
cd desktop
npm install
npm start
```

Electron is its only dependency, kept in that folder: the monitor itself has none. The first start downloads Electron's own program, about 100 MB (360 MB unpacked), once; `npx install-electron` does that ahead. The first start also puts agentmonitor in the Start menu on Windows, or in the applications menu on Linux, to start it from there after that. The app from a release and the one run here are one app: one runs at a time, they keep the same settings, and the Start menu starts the one that started last.

The window shows the page `--serve` serves, with the same keys and clicks, but q quits, as in a terminal (in the details it goes back). The monitor runs inside it and serves the page to its window alone: on 127.0.0.1, at a free port, with a new token each time. Ctrl+= and Ctrl+- make the page bigger and smaller, and Ctrl+0 sets it back; it keeps that, and where the window was.

Closing the window, or Ctrl+W, leaves agentmonitor running in the tray, and so does minimizing it, unless you turn that off. A click on the icon shows the flyout, the same page in a small window by the icon: a session opened there, with a click or Enter, opens in the window, and the flyout goes when you click elsewhere or press Esc. A double click on the icon shows the window, and so does starting agentmonitor again; on macOS a click does. q, Ctrl+Q, or Quit in the icon's menu, quits it.

The icon shows the sessions, a glyph each, up to four, what matters most first; one alone, or none, fills it:

| Icon | |
|---|---|
| ◆ yellow | a session waits for you, or is blocked |
| • blue | one is unread |
| ● green | one is at work |
| ◎ cyan | one waits on what it left running in the background |
| ○ cyan | one is idle |
| ○ grey | none runs |

Tray icon, in its menu, gives it another look: what matters most alone, its glyph; that glyph turning while one is at work; that glyph in a ring of the plan's usage, lit round from the top as far as the limit used more, colored as the taskbar button's bar (below); or how many need you, dark on yellow (9+ past nine), else what matters most.

Its tooltip counts the sessions and gives the plan's usage. Its menu lists the sessions that need you, then the unread ones (a click on one opens it in the window), and the counts and the usage under them, then these switches, which it keeps:

- Notify when a session needs you or ends its turn: a notification when the bell would ring. Off until you turn it on, and on Windows shown only while its settings let apps notify (Settings, System, Notifications).
- Flash when a session needs you or ends its turn: the window's taskbar button flashes until you bring the window to the front; with the window in the tray, the icon blinks a few seconds. On at first.
- Tray icon: its look, above.
- The plan's price a month: None at first, or $20, $100 or $200, for what the week's use came to in the list's WEEK and TOTAL, the share and projects views, the tank and a session's details, as `--plan-price` gives it. Another price, put in its `settings.json` as `planPrice`, is offered too.
- Minimize to the tray: on at first.
- Start at login, in the tray: off at first.
- In the Start menu, or In the applications menu: there after the first start. Taken out here, it stays out.

On Windows the window's taskbar button shows more:

- its bar: the plan's usage, the limit used more, green, yellow from 75% or where at its pace it would reach 100% before it resets, red from 90%. macOS shows it on the dock's icon.
- its icon, the app's. A taskbar that combines its buttons (another monitor's does at first) shows the icon of agentmonitor's entry in the Start menu instead. A pin made from the button starts agentmonitor again, by its name and with its icon.
- on its icon, how many sessions need you, dark on yellow; else, while one is unread, at work or in the background, a ring of the sessions by what they show.
- under its preview, which shows the top of the list, a button for each session but those idle, seven at most, what matters most first: a click opens it in the window.
- its jump list (a right click on it, or on agentmonitor pinned to the taskbar): the sessions that need you, those unread and those at work, each opened in the window, then Show Claude agents and Quit agentmonitor. A session taken out of it stays out, and at Quit the list goes.

How many sessions need you shows next to the icon on macOS, and as a badge where a Linux desktop shows one. `npm start -- --hidden` (from a release, `agentmonitor.exe --hidden`) starts it in the tray with the window not shown, as it starts at login, and `npm start -- --quit` (`agentmonitor.exe --quit`) quits the one that runs.

It writes only its own files:

- its settings, the sessions you dismissed with `x` (`dismissed.json`, so that they stay dismissed when it starts again) and its icons, in its folder: `%APPDATA%\agentmonitor` on Windows, `~/Library/Application Support/agentmonitor` on macOS, `~/.config/agentmonitor` on Linux. Electron keeps its caches there too.
- its Start menu shortcut, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\agentmonitor.lnk`, or on Linux `~/.local/share/applications/agentmonitor.desktop`. On Windows its notifications go with the shortcut: without it, they may not show.
- on Windows its jump list, which Windows keeps for it while it runs.
- to start at login, Windows' Run key for your account, or `~/.config/autostart/agentmonitor.desktop` on Linux.
- on Windows, once it has notified you, what Electron's notifications keep: their activator, registered for your account under `HKEY_CURRENT_USER\Software\Classes\CLSID`, and its CLSID on the Start menu shortcut, from a release agentmonitor's own. Run here, they write a shortcut of their own, `Electron.lnk`, which agentmonitor hides while its own is there: the Start menu would list agentmonitor by it, as Electron, and another monitor's taskbar would show Electron's icon.

It reads what `--serve` reads, from `$CLAUDE_CONFIG_DIR` or `~/.claude`, with "recently active" at 24 hours. It was tried on Windows 11. It should run on macOS and Linux, untried there: on macOS it offers no start at login or menu entry, which would take a packaged app, and a Linux desktop shows the icon only when it has a tray (GNOME needs an extension for one).

## Where it looks

All in Claude Code's config folder (`~/.claude`, or `$CLAUDE_CONFIG_DIR`, or `--dir`), but for the desktop app's files:

- `sessions/<pid>.json`: one for each running Claude Code process, wherever it runs, with its session, folder, title and status (busy, waiting and for what, idle). Claude Code removes it when it exits.
- `projects/<project>/<session>.jsonl`: each session's transcript. The monitor reads its last MiB on first sight (more when that holds no message, or changes a task list made before it), then only what was appended, so a refresh costs a few milliseconds however long the transcripts are. The first prompt comes from its first bytes.
- `projects/<project>/<session>/subagents/agent-<id>.jsonl` and `.meta.json`: the session's subagents. `subagents/workflows/<run>/` holds a workflow's agents and its `journal.jsonl` (which agents started, returned or failed); `workflows/<run>.json` is the run's record once it ended, and `workflows/scripts/<name>-<run>.js` its script, which gives it its name.
- `jobs/<id>/state.json`: background sessions, with what they are doing or need.
- The Claude desktop app's records of its Code tab sessions: `claude-code-sessions/<account>/<org>/local_<id>.json` in `%APPDATA%\Claude` and `%LOCALAPPDATA%\Claude-Data\<package>\` on Windows, `~/Library/Application Support/Claude` on macOS, and `~/.config/Claude` elsewhere. They give each session's title, whether it is archived, its model, effort and permission mode, whether ultracode is on, and the app's summary of its last turn. They also give when you last opened it and when its last turn started or ended, which tell which sessions are unread, and the Claude Code sessions it ran before its current one, with when it was rewound.
- The desktop app's `plan-usage-history.json`, in the same folders: how much of your plan's usage limits was used, as the app checked about every 15 minutes while it ran, for the last month or so. The monitor reads its latest check, and works out the resets from the others.
- The desktop app's Local Storage, `Local Storage/leveldb/` in the same folders: where the app's page keeps what its Code tab remembers, in Chromium's LevelDB files. The monitor reads one key there, `epitaxy.dismissedTurnReceipts`: which next-step boxes you closed. It reads each table once (they never change), then only what was appended to the log and the MANIFEST, at most every 5 seconds, and never touches its `LOCK`.
- For the usage, the transcripts again, each session's, subagent's and workflow agent's, for the tokens, model and tools of every reply since a little before the app's last check, and since midnight for today (but printed once), with the prompts typed: a long one from about that time, found by its records' times, then only what was appended, in the background and at most every 10 seconds (printed once, the monitor waits for it).

And the processes: whether each PID in `sessions/` exists (signal 0, which only asks), and the process table (`tasklist` on Windows, `ps` elsewhere), read when a new PID turns up and every 10 seconds, for the program's name and memory.

## How it decides

- A session runs when its record in `sessions/` names a process that runs here and is Claude Code (`claude`, or the `node` or `bun` that runs it). A record whose process is gone, after a crash, or whose PID is now another program's, means the session ended.
- With no record, a transcript written in the last minute is `active`: Claude Code at work without a record, an older version say. A session seen running since the monitor started and now gone has ended, however recently it wrote.
- A session at work waits on you when the tool call it is in asks you something: a question (AskUserQuestion), a plan to approve (ExitPlanMode), or a session the desktop app offers to start. In a terminal, Claude Code's record also says when it waits for a permission.
- A session or agent is in a tool when a call it made, other than one that starts an agent, has had no result for 3 seconds.
- A turn goes from a prompt, the message about a background task's end, or a reply with no prompt read before it, to the reply that ends it, an interruption or an API error; a compaction's summary is no prompt. A session waits on you from a call that asks you something until its next reply.
- The task list is the last one made, replayed from the calls that changed it and did not fail: the desktop app's `update_plan` (a new list, the next step, steps done, a step started) and `wrap_up` (which checks off the step in progress), or TodoWrite's list. Its count shows while the session is at work and no prompt came after the list last changed.
- Claude Code writes the effort with each reply: the turn's, else the session's. A session at work shows that of its turn. One that is idle or ended shows the desktop app's setting when the app has one, since its next turn takes it (it can have been changed since the last reply), else that of its last reply. An agent shows its own, from its transcript while it works or its details are open; a workflow run has none of its own.
- Ultracode can be wrong. A desktop app session shows the app's setting for it. Any other session shows it once a reminder of it turns up in the part of its transcript read. Claude Code sends that reminder after the first prompt, after about every tenth one since, and after a compaction, so the first read of a long transcript can miss it. And nothing in the transcript says when ultracode was turned off.
- A command goes on in the background from the result of the call that started it (`Command running in background with ID: …`, or moved there after its timeout) until the message about its end comes in, or TaskStop stops it. One you stop in the desktop app while the session is not at work begins no turn: its message waits for the next one, and the monitor takes it as the command's end all the same. Those of a session whose process is gone are not shown. A session that runs, its turn over, is in the background while a command of its goes on, or an agent or a workflow it started is at work.
- A session that ended is listed while its last record is within the window. That is the time written in the record, not the file's: when the desktop app quits, Claude Code appends its totals, with no time, to the transcript of each session open.
- Archiving a session in the desktop app ends it, and once it has ended it is put away: listed only when `e` shows all that ended, and counted nowhere (not in the first line, the web page's title nor the agentmonitor app's tray and taskbar), whatever the app's summary of its last turn said. While a process runs it, one resumed in a terminal say, it is listed as any other.
- A desktop app session can go on in a new Claude Code session, after a rewind say, and the app's record lists the ones it ran before. Each of these earlier runs is listed as any session that ended, but named after the session it went on in, `reviews (earlier run)` say. Its details say when the session was rewound from it, and give the title it had, which the filter also finds. It is never unread, and an archived session's earlier runs are put away with it.
- A subagent started in the background says in its metadata when it finished or was stopped. One in the foreground is done once the tool call that started it has its result. An agent whose last reply ended its turn is done, and one with no call open that wrote nothing for 15 minutes counts as ended.
- A workflow runs until its record says how it ended, or, with no record, until its session ends or nothing is written for 15 minutes. Its agents' states come from its journal.
- A desktop app session is unread when all of these hold:
  - it is not at work;
  - its last turn ended after you last opened it in the app;
  - another session was open there when that turn ended.

  This is the app's blue dot: the app marks a session unread when one of its turns ends while you are in another session, and clears the dot when you open it.
- A few seconds after a turn of a desktop app session ends, the app writes its summary of the turn: a category (completed, blocked, review ready), a few words on what it came to, and, when it is blocked, what you are to do. The monitor uses a summary while the session is not at work, and only one that names the transcript's last reply: it is not used before the app writes it, nor for a turn the app did not sum up, nor once the session went on. A blocked summary marks the session blocked.
- A desktop app session ends its turn with `wrap_up`, which fills the app's next-step box: what is now true, and when the next move is yours, a question with a button or two that answer it, or only that it is blocked. That question waits for your answer, which is your next message, so a session not at work whose last turn asked one is blocked on it until a turn begins, whatever the app's summary of the turn says; a box that says only blocked shows its recap. Closing the box with its ✕ puts the question aside: the app keeps the boxes you closed in its Local Storage, and a session whose box you closed is no longer blocked on it. Answering one does not close it there, but begins a turn. A call that failed asks nothing. Where the app draws no box (it drops a button it can't take, one with an `@` in it, say), the session asks in its reply instead, so it is still blocked.
- A turn that asks its question in its reply, with no box, has nothing to close in the desktop app, and the app offers no Mark as completed for it either: that is for its own needs-input dot, which such a turn does not get. Only the monitor counts it blocked, from the app's summary. `x` dismisses what the last turn left you, a question or a reply not read: the session counts as neither blocked nor unread, the summary says what the turn came to, and its next reply ends the dismissal, as a new turn does or an error. The dismissal is the monitor's own: the app does not know of it, so its blue dot or box stays till you open the session or close the box there. In a terminal and with `--serve` the monitor keeps its dismissals while it runs; the agentmonitor app keeps them in its folder.
- With the plan's price, a point of the week's limit is a week's worth of the price over 100: the price a month times 12, over the 52.18 weeks of a year, over 100 ($0.46 at $200 a month). A plan's price is the same however much you use it, so this is the share of it that the use took, not a bill. The session's limit, five hours of the week, gets no dollars of its own. Charges past the plan, for usage bought beyond its limits, are in no file the monitor reads.
- A session's TOTAL counts its replies read here at the week's rate now, those before a change of plan too, as if they had been under the plan you have now: an estimate of what they came to. Its use before the desktop app's first check, or elsewhere, is not in it, and the app keeps its checks for about 30 days: as it drops the oldest, the replies before the first it keeps drop out of TOTAL too, and a session that ended a month ago comes to nothing. Its details say since when (`since Oct 3`), or `in all` when it began after that check.
- A session's API cost, in its details, is Claude Code's own figure: what its replies came to at the API's prices since Claude Code began counting them (`since Sep 25`; the session's later runs go on with that count), with their tokens and the lines they changed. Claude Code saves it as a run of the session ends, so a session at work has used more since. It is not a share of the plan: a plan's limits can give far more use than its price would buy from the API, so the two can be far apart. A model of another provider's has no price Claude Code knows, and the line says so: `a model's price unknown`.
- The prompt cache keeps a conversation's context for a while after each request that reads or writes it, so that the next reply reads it for a fraction of what writing it costs. How long, each reply's usage says: an hour (as for Claude Code's sessions on a plan), or five minutes. The monitor counts from when the session's last reply was asked for: its first record's time, less the time it spent thinking. The process can quit meanwhile: a session resumed in time still reads its cache. A compaction starts the context over, so nothing is shown till its next reply. Once the cache has run out, the next reply writes the whole context again: the session's details say what that adds, in points of each limit at the rates the usage is carried on with (and at the plan's price), counting the context in full, though a part all sessions share (the system prompt and the tools) is often still cached by another.

## Limits

- These files are Claude Code's own, not a published interface, and a new version can change them. What the monitor can't read, it leaves out rather than failing.
- CTX is the context of the last reply (input, cache reads and cache writes). The output tokens are those of the part of the transcript read; the API cost in the details, and its tokens, are Claude Code's own, as it last saved them.
- It sees one config folder: one user's sessions.
- The turn summaries and the next-step box are the desktop app's: a session in a terminal or an IDE has neither, and so is never blocked.
- The usage starts from the desktop app's checks: without the app there is none. Carried on from the last one, it is an estimate, and the longer ago that check, the further off it can be. It counts only what the sessions here used, in this config folder: use since then on claude.ai, on another computer or in another config folder is missing, and so is a session window one of those began. Its rate is that of the latest rises, and it drifts when the way you work changes (the models, how much is cached). The paces below the list are guesses too: the session's is the last hour's here, and the week's its average since it reset or your plan changed (in the tank, the last hour's too), so the times they give for 100% hold only while you go on as you did. A change of plan shows where the week's percent dropped at no reset of it: the rates before it are left out, so till the new plan's checks have risen enough each limit is as last checked, and a limit the last check leaves out is not shown. The resets are worked out from the checks and the replies, and can be off. A session window begun elsewhere and used so little that the app still read 0% looks as if it began later, so its reset comes earlier than shown. A week's reset shows only once its percent was seen to drop at that time twice. `/usage` in Claude Code says them exactly.
- The desktop app's yellow dot is a session that waits on you: a permission to give, or a question to answer. Its questions, plans to approve and offers of a session are tool calls in the transcript, so they show as waiting. Its permission prompts are kept in the app's memory, in no file: a session waiting on one shows as in a tool, the call it asks about, and the time waited on them is not in today's.
- The next-step boxes you closed come from the app's page's own storage, which no file documents: if a new version of the app keeps them elsewhere, every question counts till a turn begins. A box you close counts for a few seconds more, till the app has written its storage and the monitor has read it.
- The app keeps its own list of unread sessions in the same storage, where the monitor reads only the boxes closed. The monitor works the list out from the session records instead, so it can differ from the app in two ways:
  - A dot you set by hand with Mark as unread does not show.
  - A record keeps only the last time its session was opened. The monitor remembers every opening it sees while it runs, but for the time before it started it knows only each session's last one.
- A record from another computer sharing the folder, or from Windows when run in WSL, names a process it can't check, so that session counts as ended (or active while its transcript moves).

## Development

```bash
npm test
```

`bin/agentmonitor.js` reads the options and starts `src/tui.js` (the screen, the keys and the mouse) or `src/serve.js` (the web view, with its page in `src/web/`), or prints once with `src/view.js` (what is drawn, and where a click on it goes; the views below the list but the overview are `src/panels.js`, some drawn on `src/canvas.js`). `src/viewer.js` holds what one look at the monitor shows and what keys and clicks do to it: the terminal has one, and the web view one for each page. `src/monitor.js` puts a snapshot together from `src/registry.js`, `src/transcript.js`, `src/agents.js`, `src/jobs.js`, `src/desktop.js`, `src/usage.js` (the plan's usage, carried on with the replies `src/ledger.js` reads) and `src/procs.js`. `desktop/main.js` is the agentmonitor app, around `src/serve.js`: the window, the tray and the settings; `desktop/tray.js` says what the tray shows and what to notify, `desktop/icons.js` draws its icons as PNG and ICO, and `desktop/launch.js` writes Linux's menu entries. The tests write a config folder as Claude Code does, drive the monitor through a fake terminal, ask the web view on a free port of 127.0.0.1, and check the agentmonitor app's parts that need no Electron.

`desktop/build.js` makes the app for Windows as a release has it, in `desktop/dist/`: Electron's program, named `agentmonitor.exe`, with the app beside it, then that folder as a zip, with the zip's SHA-256. `desktop/zip.js` writes the zip, so no zip program is needed. With `RCEDIT` set to the path of rcedit's `rcedit-x64.exe`, the program also gets the app's icon and name; without it, it keeps Electron's.

```bash
cd desktop
npm install
npx install-electron
npm run build
```

`.github/workflows/release.yml` releases it. When a tag `v<version>` is pushed, it runs the tests on Windows, builds the app there with rcedit, and makes a GitHub release of the zip and its SHA-256. To release, give `package.json` and `desktop/package.json` the new version and commit that, then tag it and push the tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

A version with a `-` in it, such as `0.2.0-beta.1`, makes a pre-release. Run by hand from the repository's Actions tab on a branch, the workflow builds the zip as the run's artifact and releases nothing.

## License

MIT
