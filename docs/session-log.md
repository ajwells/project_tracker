# Session log

Context for future working sessions: what was built, what broke, and why the app works the way it does. For how to use the app, see `README.md`. The code wins if this log disagrees with it.

Covers the session of 2026-11-01 to 2026-11-03. Add new sessions at the end.

## Current state (2026-11-03)

- **Last commit:** `3c8590c`, the project day unit default and the link edit fix. `1172bf8` has the calendar and working day options and the two-sided history.
- **Not committed:**
  - Fix for browser test runs hanging and its tests
  - This log
- **Tests:**
  - `npm test`: 236 pass.
  - `npm run test:browser`: 163 pass in about 19s, 30 full runs in a row clean.
  - Breakage checks on day units and the project default: 38 of 38 caught.
- **Running servers:**
  - PID 35376 on port 3000, with `SAVE_DATA` and `FIRM_LEADS` unset. It serves `public/` from disk, so client changes only need a tab reload.
  - PID 8496 on port 5173 is the user's separate Needlepoint Tracker project, not part of this app. Leave it alone.

## Environment

- **Node and npm:** WebStorm's copy, not on PATH. Prepend `C:\Users\Tabarious\AppData\Roaming\JetBrains\WebStorm2026.2\node\versions\26.13.0`.
- **Shell:** Windows. Git Bash heredocs containing apostrophes fail, so write scripts to a file instead.
- **Patch scripts:** in JavaScript's `String.replace`, `$$` in the replacement becomes `$`. Use `split/join` or a replacer function.

## Working preferences

- Commit only when asked. The user also commits on their own, so check `git log` and `git status` first.
- The user tests with real plans and questions the logic. Reproduce the case on their file before explaining it.
- The user reversed "keep SF as is" after working through a real example. Treat a decision as open if new reasoning challenges it, and say so if a request reverses an earlier one.
- Say what wasn't tested. Don't dismiss an intermittent test failure: one led to a real data-loss bug (below).

## Architecture

- **Stack:** Node ESM using `node:http` and `node:test`, with vanilla JS and hash routing on the client. There are no runtime dependencies. `puppeteer-core` (exact pin) is dev-only.
- **Shared logic:** `public/shared/` runs on both server and client.
  - `scheduler.js`: pure forward and backward pass over all projects at once
  - `store-core.js`: validation, history, import and export
  - `routes.js`: the change API
- **Two stores:** `src/store.js` (JSON file) and `public/js/local-store.js` (localStorage) both extend `StoreCore`. `public/js/ctx.js` picks one from the server's `saving` flag.
- **Panel:** `public/js/views/drawer.js` redraws with `morph()` (`util.js`), which updates the DOM in place to keep focus, scroll and clicks in progress.
- **Tests:** `test/` holds the fast logic and API tests. `browser-tests/` holds real Chrome tests, where each test gets its own server and profile.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | 3000 | Listening port |
| `APP_PASSWORD` | unset | Password protection |
| `DATA_FILE` | `data/store.json` | Server data file |
| `SAVE_DATA` | false | false: each browser stores its own data. true: the server saves and data is shared |
| `FIRM_LEADS` | true | Negative SS and SF links are firm |
| `BROWSER_TEST_CONCURRENCY` | min(16, cores/2) | Parallel browser tests |
| `CHROME_PATH` | autodetected | Chrome used by browser tests |

`SAVE_DATA` and `FIRM_LEADS` stop the server at startup on a typo. `PORT` has no such check (see open items).

## Features, in order

1. **Initial app:**
   - Multiple projects, tasks with subtasks, and FS, SS, FF and SF links with lag and lead
   - Gantt chart with drag, zoom, critical path and baseline
   - Timeline, working calendars and holidays
   - Task history, updates and current POC
   - Cross-project links with buffer tracking
   - PowerPoint copy, PNG, SVG and editable `.pptx`
   - JSON import and export, light and dark themes, and live sync between tabs
2. **Network:** removed `--lan`. `npm start` now binds `0.0.0.0` on IPv4.
3. **Phones:** Tasks page scrolling fixed, scroll position kept across redraws, add box pinned to the bottom of the screen.
4. **`SAVE_DATA`:** warning banner when off. Default changed to false, then browser storage was added so data lives in each browser when off.
5. **Links can pull tasks earlier:** `startSet === false` follows links both ways. A **Follow links** button clears a start set by hand.
6. **Track by duration or dates:** the `trackBy` and `finish` fields. Dates hold, and a link they break shows a conflict.
7. **Plain-English link sentences** in the panel, Links tab, dialog and task list tooltip, plus standing notes such as "12 working days later than this link requires".
8. **Panel beside the page** at 1100px and wider, instead of covering it.
9. **Chart highlight:** the edited task is tinted and ringed in the Gantt and timeline, and scrolled into view. Never included in exports.
10. **Firm links:** see decisions below.
11. **Two-sided history:** a center line, with posted updates on the left and recorded changes on the right, newest first.
12. **Working or calendar days:** `task.durationUnit` and `dep.lagUnit`.
13. **Project default for day units:** `project.defaultDayUnit`, in project settings.
14. **Test suites:** `npm run test:browser` added. Speed improved from 11.3s to about 2s for `npm test`, and from 132s to about 19s for browser tests.

## Bugs found and fixed

| Bug | Cause | Fix |
|---|---|---|
| Phone pages couldn't scroll | Page set not to scroll, and cards had no scrolling of their own | Page scrolls on phones |
| Pages jumped to the top | Redraws reset scroll | Scroll position kept per page |
| Gantt cramped on a sideways phone | Toolbars left 142px of height | About 280px |
| New task hidden below the pinned add box | No scroll after adding | Scrolls to the end, keeps focus |
| Add box under the last task on short lists | Layout | Stays at the bottom of the screen |
| Typing `-2` as a lag saved 0 | Field held `0-2`, and `Number(...) \|\| 0` hid the error | Select on focus, and refuse invalid input with a message |
| Many links appeared to do nothing | A link could only delay a task | Tasks without a set start follow links both ways |
| Wrong buffer on FF or SF to a summary | Used the summary's stored duration | Uses the tightest subtask |
| Wrong float across calendars | Backward pass guess could land short | Walks against the forward rule |
| Float too low on SS or SF from a summary | Every subtask treated as holding the start | Skips a subtask when another holds the summary's start |
| Clicks lost while editing a task | Panel rebuilt mid-click | `morph()` updates in place |
| Fields stale, then jumping | Redraw deferred while a field had focus | No deferred redraw, except while the pointer is pressed |
| Earlier edit undone (same-tick stale data) | Handlers held old data | `listen()` dispatcher always uses the latest handler |
| One typed date made five saves, including year `0202` | Browser reports change per segment | Typed dates save on Enter, Tab or leaving the field. Picked dates save at once |
| Timeline dots 2px off the line | Pseudo-element is content-box | Corrected offsets |
| **Link edits overwriting each other (data loss)** | Each save sends the task's whole link list, built from the last loaded data, so a second edit before the first returned undid it. Server storage on a slow connection only | Edits queue and apply to the saved list (`editLinks` in `drawer.js`). The panel shows pending edits on top |
| A calendar link resent without a unit became working days | Missing unit treated as working | An existing link keeps its unit. A new one takes the project default |

| **Browser test run could hang forever** | A restarting test server found its port taken, and its group's cleanup then stopped the already-stopped server. `stop()` checked only `exitCode`, but a killed process reports `signalCode` instead, including on Windows, so it waited for an exit that had already happened | `stop()` checks both. Restarting servers use ports below the system's handout range, and retry briefly if theirs is still busy |
| A test leaving a server running kept the test process alive | Open child process handles | `--test-force-exit` and `--test-timeout=300000` in `test:browser`, and leftover servers are killed on exit |

Test-only bugs fixed: server port clashes between parallel tests, tests inheriting concurrency, tests reading the page before it drew, and the CSP blocking a blob fetch in the export test.

The link data-loss bug showed up as one rare test failure. A test that holds saves back for 400ms reproduces it every time, and the rest of the browser suite didn't catch it.

## Design decisions

### Scheduling

- **Missing `startSet` means set by hand.** Older data never moves on upgrade. The catch is that older tasks need **Follow links** clicked one at a time. A bulk option was offered and not requested.
- **A start set by hand means "start no earlier than".** Links can push the task later, and it returns when they move back.
- **Tracked by dates: dates hold.** A broken link is a conflict rather than a move, so typed dates are never overwritten.
- **`task.start` stays synced for tasks following links,** so removing a link keeps the task where it is.
- **Critical means** a slip moves a project's finish or breaks a firm link.

### Firm links (deliberately non-standard)

- **The rule:** SS or SF with a negative lag binds both ways. Example: "test2 finishes 30 days before test1 starts".
- **Why:** the user's reasoning was that they can't go back and finish test2 after test1, so reporting it as non-critical was misleading.
- **Behavior:**
  - The successor moves with the predecessor.
  - It has no more float than the predecessor.
  - Later than the rule is a conflict and at-risk status. The predecessor isn't moved, so the user decides what gives. Pushing both ways would make tasks drive each other.
- **Dates are the same as standard.** Only conflicts, float and critical flags differ.
- **Negative FS stays non-firm,** because it usually just means "may overlap".
- **Not-firm wording:** other links say "no earlier than", so the sentence is never stronger than the rule.
- **Disclosure:** each firm link's panel row has a note that this differs from the standard, as the user asked. `FIRM_LEADS=false` restores the standard.
- **Summaries:** SS concerns the first subtask, SF the last.

### Working and calendar days

- **Granularity:** per task and per link, like Microsoft Project's elapsed days, with a project default.
- **Storage:** `lagUnit` is stored only when calendar, so older links and exports are unchanged. `durationUnit` is always set on new tasks. Missing means working everywhere.
- **Clocks:** the scheduler uses a calendar with no days off (`EVERY_DAY`) for calendar units.
- **Lag landing:** the lag's unit decides where a link lands.
  - A calendar lag can land on a day off.
  - A working-duration task then moves forward, or back on a firm link so the rule stays true.
  - A calendar-duration task stays there.
  - A working lag always lands on a working day, even for a calendar-duration task. To start curing concrete on a Saturday, both the duration and the lag must be calendar.
- **Switching units:** tracked by duration keeps the number and moves dates. Tracked by dates keeps dates and changes the number.
- **Units for float and buffer:** float uses the task's unit. A buffer is calendar if the lag or the task's duration is, because working days can't measure a task running through days off.
- **Milestones** always use working days.
- **Project default (`defaultDayUnit`):**
  - One setting covers both durations and lags, to keep settings simple.
  - It only affects new tasks and links, so changing it moves nothing and writes no history.
  - A cross-project link takes the default of the waiting task's project.

### Storage and access

- **`SAVE_DATA` defaults to false,** at the user's request. Each browser and each address has its own copy, and nothing is shared between people or devices. If `data/store.json` has projects, each browser copies them on first visit. Modes don't transfer data, so use export and import.
- **Binds to all interfaces,** at the user's request. See the security items below.

### Interface

- **Sentences say "working days" or "calendar days" explicitly,** and short labels use `d` and `cd`.
- **Highlight never appears in exports.**
- **Two-sided history** keeps strict time order rather than two independent columns.

### Testing

- **Float and critical path are checked by brute force:** actually slip each task and compare with the reported float.
- **New rules get deliberate-breakage checks.** Those scripts lived in a temporary session folder and are not in the repo.
- **Browser tests for race conditions must force the timing.** Passing runs alone didn't reveal the link bug.
- **A rare failure gets a repeat loop with a per-test limit and a watchdog,** not a rerun. A `--test-timeout` limit also applies to each whole group, so it has to allow for the slowest group.
- **The original hang itself wasn't caught with diagnostics.** The cause comes from a matching failure under time limits and a test that hung on the old code. That another test's server took the port is the likely explanation, not an observed one.

## Open items

### Security, raised and not acted on

- No password is set, and the server listens on every interface, including `192.168.8.149` and `100.99.239.3`. Anyone who can reach them can read `data/store.json`'s projects, and with `SAVE_DATA=true` can edit everything.
- DNS rebinding protection was removed along with the local-only host check. An offer to accept only IP addresses and this computer's host names is still open.
- `APP_PASSWORD` is sent unencrypted over HTTP.

### Small known issues

- `PORT` values such as `abc` or `0` silently use 3000, and `70000` or `-1` crash with a stack trace.
- There's no `HOST` variable for binding to one address.
- A summary's float is the lowest among its subtasks even with mixed units, and is labeled just "days". A summary's duration is always working days.
- Progress weighting mixes working and calendar durations.
- `project-tracker-export-2026-11-02.json` is tracked in git since `76763b5`. It's the user's test plan, and they may not want it in the repo.

### Not tested

- Physical phones, on-screen keyboards, iPhone home bar spacing and Safari or Firefox
- Dragging a Gantt bar in a browser for dates-tracked or calendar tasks (the save logic is tested directly)
- Clipboard to PowerPoint end to end in the current suite (the first build opened generated decks in PowerPoint)
- Firm note in light mode or at phone size
- Reaching the server from another device, or through Windows Firewall
