# Session log

Context for future working sessions: what was built, what broke, and why the app works the way it does. For how to use the app, see `README.md`. The code wins if this log disagrees with it.

Covers the sessions of 2026-11-01 to 2026-11-23. Add new sessions at the end.

## Current state (2026-11-23)

- **Last commit:** `68f9a72` (2026-11-23), made by the user: dragging milestones and drag-to-reorder, quieter history, holidays and lead/lag on the Gantt, and their fixes.
- **Not committed:** the single-file build (2026-11-24, `scripts/build-static.js`, `browser-tests/static.test.js`), the fix for fields reverting while a save is out (2026-11-24, `morph` and `saving` in `util.js`, `api` in `ctx.js`), lead/lag labels kept inside the chart, the test race fixes, their README entries, and these updates to the log.
- **The user's plans:** exports live in `debug/`, which is in `.gitignore`. `debug/project-tracker-export-2026-11-23.json` is the CSP V3 plan, and `debug/project-tracker-export-2026-11-02.json` the earlier test plan. Reproduce questions on these.
- **Tests:**
  - `npm test`: 284 pass.
  - `npm run test:browser`: 248 pass in about 25s.
  - `npm run build:static` writes `dist/project-tracker.html` (about 800 KB). `dist/` is in `.gitignore`.
- **Running servers:** none on port 3000 as of 2026-11-22. The server serves `public/` from disk, so client changes only need a tab reload, but `public/shared/` also runs in the server, so it needs a restart after scheduler changes when `SAVE_DATA` is on. Port 5173 is the user's separate Needlepoint Tracker project, not part of this app. Leave it alone.

## Problems to handle

Found 2026-11-22 and deliberately left for later. Details are in that session's entry below. Remove an item here once it's fixed.

1. **Too much float when a summary's subtasks are linked to each other.** The SS and SF rule in the backward pass (`scheduler.js`, "A summary starts with its first subtask") takes the summary's other subtasks to stay put while one slips. If one of them is linked after the slipping subtask, it moves along, and the slip reaches the link after all. This was already broken before 2026-11-22.
   - Reproduce: random plan 451 with summary tasks (`randomPlan(451, { summaries: true })` in `test/critical-path.test.js`). t2 reports 60 days, and slipping it 60 moves the finish.
   - Tried and backed out: ignoring subtasks linked after the slipping one. That gave tasks negative float with nothing broken (plan 114), and narrowing the rule broke plan 935. A fix probably needs to work out where a linked subtask would actually be pushed.
2. **Float a little short when calendars differ.** A predecessor of a task that's already behind is measured against that task's position. When the two sides of the broken link have different days off, the first days of push can land on days the link doesn't count, so the float comes out short by those days. It's never too long. Different days off means a weekend one project works and the other doesn't, a holiday in only one project, or a calendar-day task or lag against working days.
   - Reproduce: random plan 923 with every option (`calendars: [{}, { workWeekends: true }], summaries: true, dates: true`). t0 reports 9 days, and the link only gets worse from day 12, because days 10 and 11 land on a weekend. No case with holidays has been reproduced yet, and none has been looked for: the random "holidays" plans have no fixed-date tasks, so they can't reach it. Adding `dates: true` to that kind would.
3. **The task that's too late isn't at risk.** On the Tasks page and the overview, only the fixed task shows "At risk". The task that has to move shows "On track", though the panel and charts say it's behind. Likely fix: `healthOf` in `scheduler.js` treats negative float as at risk. Check the overview's at-risk list and the project card counts afterwards.
4. **No red arrow for a link on a summary.** When a link sits on a summary and one of its subtasks breaks it, the arrow stays normal, because the conflict is recorded on the subtask (`brokenLink` in `chart/gantt.js`). The badge still shows on the subtask.
5. **Negative float is checked loosely.** The brute-force check can't confirm the amount, because moving one task can be held up by another task's set start. Only hand-worked tests check the amounts. A stronger check would move the task together with what it drives.
6. **Not tested:** the PowerPoint file with conflict badges opened in PowerPoint, conflict marks on phones, and the portfolio Gantt with conflicts.
7. **Intermittent browser test failure:** "typing -2 after a double click saves -2" (`browser-tests/scheduling.test.js`, server storage) failed once in 4 full runs on 2026-11-23, then passed 12 times alone and in 3 more full runs. It double-clicks the lag field and types, with no dialog involved, so it isn't the dialog change made that day. The data-loss bug in the bug table also first showed as one rare failure, so look into it: run it in a loop under load with a per-test limit, as the Testing decisions describe.
   - Seen again 2026-11-23 while testing reorder: 1 failure in 9 full runs.
8. **A click straight after a bar drag can be ignored.** The bar drag in `mountGantt` (`views/charts.js`) ignores the click after a drag with a `dragged` flag cleared by `setTimeout(0)`. A browser can run that timer late (background or busy pages), and the next real click on the chart is dropped. Reorder had the same pattern and failed 2 of 4 full runs because of it; it now ends its guard on the next click or press instead (`swallowClick` in `reorder.js`). Bar drags haven't been seen failing, but should get the same fix. The "timers run late" test in `browser-tests/reorder.test.js` shows how to test it.

**Finding more:** the suite tries 200 random plans per kind, which misses items 1 and 2. To run 5,000, copy the test with `sed 's/seed <= 200;/seed <= 5000;/' test/critical-path.test.js > test/zz-stress.tmp.test.js`, run it with `node --test`, then delete the copy. It takes about a minute. Items 1 and 2 are the only failures expected.

Older open items (security, `PORT` checks, mixed day units in summaries and progress, edits that skip the date preview) are under **Open items** further down and in the 2026-11-03 session.

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
15. **Dragging milestones and reordering tasks (2026-11-23):** milestones drag along the Gantt like bars (move only). Tasks drag up and down a project's Gantt names and Tasks tab. See that session's entry.
16. **Quieter history (2026-11-23):** quick edits merge, early edits fold into "created", **Still planning**, and **Show every change**. See that session's entry.
17. **Holidays and lead/lag on the Gantt (2026-11-23):** shaded holiday bands and lag labels on links, each with a toolbar box. See that session's entry.
18. **Single-file build (2026-11-24):** `npm run build:static` makes one HTML file that runs with no server. See that session's entry.

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
| A click right after a reorder drag was lost (2026-11-23, found in testing) | The guard that ignores the drop's own click was taken off by `setTimeout(0)`, which a busy or background page can run late, so it ate the next real click. Showed as 2 failures in 4 full browser runs | The guard ends on the first click or the next press, with no timer |
| A field showed its old value while its save was out, and putting it back meanwhile was lost (2026-11-24, server storage, found when a new history test failed once in a full run) | A redraw from older data, which comes right after a change, put the old value in the field until the reply. Clearing it back to that value then looked like nothing typed, so the reply wrote the change back over it | A field the person changes counts as showing that value, and keeps it while any save is out (`saving.count`, kept by `api`) |
| A dialog closed when highlighting text and letting go past its edge (2026-11-23). Reported as project settings closing while highlighting a holiday with the task panel open | A press that starts inside and is released on the backdrop reaches the dialog as a click, and any click on the dialog itself closed it. The panel doesn't matter: it happens alone too | `openDialog` closes only when the press also started on the backdrop |

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
- **Critical means** a slip moves a project's finish, breaks a firm link, or breaks a link into a task that won't move (set by hand or tracked by dates). The last was added 2026-11-22; see that session.

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
- **Holidays and float:** holidays are per project and count only where working days do, unless the project has **Calendar days skip holidays** on (2026-11-23 session). A working-day task's float skips its own project's holidays and weekends. A calendar-day task's float counts every day, or every day but holidays with the setting on, so without it holidays change it only by moving its dates. A link's lag counts on the waiting task's project calendar, and the predecessor's float on its own. Checked on the CSP V3 plan on 2026-11-23: adding Dec 24, Dec 25, Dec 31 and Jan 1 as holidays changed nothing in calendar days, and in working days took Raytheon Flight Orders from 23 to 19.
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
- ~~`project-tracker-export-2026-11-02.json` is tracked in git since `76763b5`.~~ The user removed it in `ec6e3ad` and moved their exports to the ignored `debug/` folder. It's still in git history before that commit.

### Not tested

- Physical phones, on-screen keyboards, iPhone home bar spacing and Safari or Firefox
- Dragging a Gantt bar in a browser for dates-tracked or calendar tasks (the save logic is tested directly)
- Clipboard to PowerPoint end to end in the current suite (the first build opened generated decks in PowerPoint)
- Firm note in light mode or at phone size
- Reaching the server from another device, or through Windows Firewall

## Session of 2026-11-03: date change preview

The user asked for a warning before a date change shifts other tasks, and chose to stop for Apply whenever another task would move, rather than only for serious changes.

### How it works

- **Dry run:** `public/shared/preview.js` runs the real `updateTask` on a throwaway `StoreCore` and compares the schedules, so the preview can't disagree with saving. It needs no server call in either storage mode.
- **Held state:** `public/js/held-edit.js` holds one waiting edit. It belongs to the open task, and is worked out afresh whenever `ctx.data` changes.
- **Panel:** the Start and Finish fields show the waiting date, and a card under them lists conflicts, finishes, this task, moved tasks and cross-project buffers, in that order, as a long list scrolls.
- **Gantt:** dragging shows outlines of where other tasks would go and a count in the tooltip. Releasing opens the panel with the card, and the outlines stay until Apply or Cancel. Esc abandons a drag, which is new.

### Decisions

- **Stops for:** another task moving, or a new conflict on another task, since a task tracked by dates shows the effect as a conflict and not a move.
- **Doesn't stop for:** a conflict on the edited task alone, a shrinking cross-project buffer alone, or the project finish moving with no other task affected. The card does show these when it appears.
- **Refused edits** skip the preview and go to the save as before, so the existing messages still appear.
- **Dropped without saving:** closing the panel or opening another task drops a waiting date. Esc cancels it first and closes the panel on the next press.
- **Outlines aren't in the chart's drawing,** so they can't reach an export.
- **Shifts are said in calendar days,** the only measure that means the same for tasks with different units.

### Bug found by the new tests

| Bug | Cause | Fix |
|---|---|---|
| A waiting date came back on reopening a task | Closing the panel on a page with no chart never re-checked the waiting edit | `renderDrawer` checks it on every draw |

### Testing

- `test/preview.test.js` and `browser-tests/held-edit.test.js` are new, and the existing drag test now presses Apply.
- Breakage checks: 22 of 23 caught, after strengthening two tests that missed. The one left, counting only start changes as moves, appears to make no difference, because a task that isn't being edited keeps its length when it moves.
- Against `project-tracker-export-2026-11-02.json`, moving each task a week each way gave the same result as saving. That plan has only 3 tasks that aren't summaries, so it's a light check.

### Open items

- **Other edits still save at once,** even when they shift tasks: duration, day unit, Track by, Follow links, milestone, manual, status, link edits, task moves and deletes.
- **Not tested:** real pickers (tests set the value and send the change event), touch screens, the Timeline page showing a waiting change (it has no outlines), and plans of hundreds of tasks, where the preview runs on each day of a drag.

## Session of 2026-11-20: action items

The user asked for tasks without dates as an action item tracker, with a task's name, current POC, status, progress, notes, history and updates.

### How it works

- **Storage:** a separate `project.actions` list, not tasks with a flag. Each item has `id`, `name`, `notes`, `status`, `progress`, `pocName`, `pocContact`, `createdAt` and `history`. Older data without the list reads as empty, and the export format and `SCHEMA_VERSION` are unchanged.
- **Store:** `createAction`, `updateAction`, `addActionUpdate` and `deleteAction` in `store-core.js`. History records the same fields' changes with the same labels as tasks, and `normalizeStatus` is shared, so status and progress behave the same.
- **API:** `POST /api/projects/:id/actions`, `PATCH` and `DELETE /api/actions/:id`, and `POST /api/actions/:id/updates`. Task routes return 404 for an action item's id, and the other way round.
- **Page:** an **Action items** tab after Tasks (`views/actions.js`). It has search, POC and status filters, a **Show completed** box, the latest posted update, the last activity time, and an add box like the Tasks page's.
- **Panel:** `ctx.taskId` names either kind, and `renderDrawer` builds `buildActionDrawer` when the id is an action item's. `historySection` takes the item's API path and is shared.
- **Elsewhere:** POC suggestions include action items' POCs. Project cards on the overview show the open count. The delete project warning counts them.

### Decisions

- **A separate list rather than a task flag,** because tasks reach the scheduler, charts, links, exports, progress and the date preview. A flag would need a guard in each, and one missed would put a dateless item on a chart.
- **Kept off the schedule, charts and project progress.** Nothing in the scheduler sees them.
- **Ids are unique across tasks and action items,** checked on import and given new ids on a merge clash, since the panel opens either by id.
- **POC contact is included,** as it sits beside Current POC on tasks.
- **Not added:** due dates, ordering, links to tasks, an all-projects action list, and action items in PowerPoint exports. None were asked for.

### Testing

- `test/actions.test.js` (12) and `browser-tests/actions.test.js` (3 in each storage mode) are new.
- Breakage checks: 3 of 3 caught (updates posted to the task route, the completed filter ignored, and import id clashes not renamed).
- Screenshots at 1280px and on a 390px phone: no sideways scroll, and on a phone the five tabs fit and items show as cards.
- **Screenshot gotcha:** a fresh browser profile against the real port 3000 server copies `data/store.json` in on its first visit, which can overwrite test data loaded straight after. Wait after the first load, or use a test server.

### Not tested

- Physical phones, and the panel with a very long history
- Restarting the running port 3000 server with `SAVE_DATA=true` (the API tests cover server storage)

## Session of 2026-11-22: float into fixed-date tasks, and conflict marks

The user asked why Aircraft Integration in their CSP V3 plan had 10 days of float when it must finish before Flight Test 2, which has fixed dates. They then pointed out that conflicts weren't clear on the Gantt or Timeline either.

### Float into fixed-date tasks

- **Cause:** the backward pass skipped every pinned task (set by hand, tracked by dates or complete), a rule from the initial build. A fixed task's links never limited its predecessors, which were measured against the project finish instead. Slipping Aircraft Integration a day moved no finish but broke the link and put Flight Test 2 at risk.
- **Rule now:** a link into a task set by hand or tracked by dates limits the predecessor against where that task actually sits. A predecessor already too late gets negative float. Complete tasks still limit nothing.
- **CSP V3:** Aircraft Integration went from 10 to 0 (critical), and Raytheon Flight Orders from 47 to 37.
- **The user chose** to make this the rule with no setting to turn it off, since the old numbers were wrong rather than a different convention.

### Decisions

- **A task already behind is measured from where it sits,** not from its late date. Otherwise its lateness passes back through links with room to spare, giving tasks far from the break too little float (random plan 4 showed this). The usual planning-tool convention, which passes negative float down the whole chain, was considered and not used, because this app's float means what a real slip does.
- **So negative float means** how far a task must come earlier to mend the links it breaks itself. The tasks driving it show 0 and critical, not the same negative number.
- **A summary's FS or FF link:** a subtask's limit is never earlier than the latest finish among the others, since it can't move the summary's finish until it finishes last. This only matters once the link is broken.

### Conflict marks

- **Gantt:** a round red **!** on the top left corner of the bar, a red **!** before the name in the label column, and the broken arrow drawn red and dashed, over the other arrows. Tooltips say which side of the link the task is on, and how many days behind.
- **Timeline:** the badge goes inside the bar's left end, or just left of a bar too short for it. Both sides of a broken link are marked, since the Timeline has no arrows.
- **Legends:** a Conflict entry, on screen and in exports, only when a conflict is shown.
- **Toggle:** the user chose a **Conflicts** box on both toolbars, on by default, and exports follow it. It isn't saved between visits, like the Critical path box.
- **Panel:** the task that's too late gets a red callout naming the fixed task and how far earlier it must finish, and a "N days behind" pill.
- **Firm links:** a broken firm link marks the successor only, which is the late one, worded "Later than its firm link to ... allows".
- **Same red as critical,** told apart by shape.

### Testing

- `test/critical-path.test.js`: the slip check now counts a link newly broken or broken further, not just a moved finish, and allows negative float. Added the CSP V3 case, negative float for both kinds of fixed task, and a complete task.
- `browser-tests/conflicts.test.js` (4) is new: Gantt marks, label, arrow, legend and tooltips, the toggle, the Timeline, and the panel callout.
- Breakage checks: 4 of 4 caught (fixed tasks skipped again, the summary finish rule removed, behind tasks measured by their late date, the toggle ignored for arrows).
- Screenshots of the CSP V3 plan with Aircraft Integration a day late, light and dark, including the export preview.

### Open items

All moved to **Problems to handle** near the top of this log, so there's one list to keep up to date.

## Session of 2026-11-23: calendar days that skip holidays

The user asked why TU/EU Checkout at Crane in the CSP V3 plan had 10 days of float despite holidays Dec 19 to 27. Every task and link in that plan counts calendar days, which ran through holidays, so the holidays changed nothing. Slipping Crane 10 days moved nothing, and 11 broke the link into Aircraft Integration, so the float was right. The user then asked for an option for a calendar-day project to use holidays too.

### How it works

- **Setting:** `project.calendar.calendarDaysSkipHolidays`, a box labeled **Calendar days skip holidays** under Holidays in project settings. Stored only when on, so older plans and exports are unchanged, and the export format and `SCHEMA_VERSION` are unchanged.
- **Scheduler:** `makeCalendar` now gives each project calendar a `calendarDays` clock. It's the shared every-day clock, or with the setting on and at least one holiday, a clock of every day but the holidays. `durationClock`, `lagClock` and the buffer clock use it, so durations, lags, float and buffers all follow. Calendar-unit clocks are recognized by a `calendarUnit` flag rather than by being the one every-day clock.
- **Store:** `cleanCalendar` keeps the flag. A calendar change already reschedules and records "Rescheduled after a change to the project calendar", so nothing else was needed.
- **CSP V3 with the setting on:** Crane runs Dec 11 to Jan 2 and has 1 day of float. Nothing breaks.

### Decisions

- **Weekends still count.** The setting only takes holidays out of calendar days. Every day except holidays for working days too is what **Work on weekends** already does.
- **One setting covers durations and lags,** like the day unit default, to keep settings simple.
- **A calendar lag counts the waiting task's project's holidays,** as a working lag counts its calendar. A calendar-day task counts its own project's.
- **Milestones and working days are unaffected.**
- **Labels still say "calendar days"** with the setting on.
- **Changing the setting moves tasks without the date preview,** like any other calendar change.

### Testing

- `test/day-units.test.js`: 8 new tests. They cover durations, a start set on a holiday, lags across two projects, what the setting leaves alone, float and buffers, dates-tracked spans, 400 random plans checked against real slips, and the store (saved only when on, export and import, rescheduling with history).
- `browser-tests/layout.test.js`: the box saves, shows as saved when reopened, and clears.
- Breakage checks: 5 of 5 caught (setting ignored, lags ignoring it, buffer unit judged by clock identity, buffers counted through holidays, the store dropping it).
- Screenshot of the settings dialog with the CSP V3 plan.

## Session of 2026-11-23 (later): dragging milestones and reordering tasks

The user first asked why TU/EU Checkout at Crane (1.4) in CSP V3 had 1 day of float. It's right: CSP V3's holidays stop at Dec 27, so Fri Jan 1 is a working day. A milestone can sit on its predecessor's finish day, so Crane can finish Jan 1, "system at campbell" stays on its set Jan 1, and SIMO still starts Mon Jan 4. Getting 0 needs both Jan 1 as a holiday and **Follow links** on the milestone; the holiday alone pushes the milestone to Jan 4 and makes a conflict. The user then asked whether a task can start on its milestone predecessor's day: no, FS from a milestone starts the next working day, as in Microsoft Project; SS gives the same day. A per-project "milestones at the start of the day" setting was offered and not taken up.

Then the user asked for milestones to drag on the Gantt like tasks, and for tasks to drag into a new order on the Gantt and Tasks tab.

### How it works

- **Milestones:** `taskRow` in `chart/gantt.js` now lets milestones drag, and the diamond carries `drag`. `mountGantt` moves them only (no right-edge resize), draws a dashed diamond as the ghost, and the tip says "Date:". A milestone saves `start` only, even if `trackBy` is `dates`. The date preview and Apply work as for bars.
- **Store:** `moveTask` takes `before`, `after` or `into` with a `targetId` in the same project. Before or after takes the target's parent; into makes it the target's first subtask. It refuses moves next to or under the task itself or its subtasks, into a milestone, and across projects. History records a parent change, as indent does. The route passes `body.targetId`.
- **Client:** `public/js/reorder.js` holds the drop rule (`placement`) and the drag (`dragToReorder`): 5px to start, a line where the task would go, auto-scroll near the edges, Esc cancels, and drops that leave the task in place send nothing. The Gantt uses the label column on a project's own chart, not the portfolio, and not the other projects' rows at the end. The Tasks tab uses whole rows, except buttons, and is off while filtered.

### Decisions

- **Top half drops above, bottom half below,** and the bottom half of an open summary goes first inside it, so the line between a summary and its first subtask means the same from either side. The bottom half of a summary's last subtask stays inside the summary; the top half of the next top-level row leaves it.
- **Mouse only,** like bar drags: on touch a swipe must scroll. The panel's move and indent buttons remain for touch.
- **Reordering saves at once,** without the date preview, like the move buttons, even though a new parent can change inherited links.

### Testing

- `test/api.test.js`: before, after and into, summaries bringing subtasks, history, and each refusal.
- `browser-tests/reorder.test.js` (new, in `test:browser`), 11 scenarios in both storage modes: dragging milestones (saves, Esc, no resize, waits for Apply when others follow), Gantt reorder (above, into a summary, a summary with subtasks, onto its own subtasks, Esc), Tasks tab reorder (below, leaving a summary, filtered), clicks after drags, and a click straight after a drag with timers running late.
- Breakage checks: with milestone drag and the reorder request switched off, 16 of 20 scenarios failed; the 4 that passed check that nothing changes. The late-timer test fails on the timer guard and passes with the fix.
- Logic 274 pass. Browser 227 pass in 4 full runs in a row after the fix.

### Not tested

- Dragging in a long list that needs auto-scroll, dragging on the Gantt with the label column narrowed on a small window, and dark mode looks of the drop line.

## Session of 2026-11-23 (later still): quieter history

The user said the history fills up just entering a plan. The CSP V3 export had 109 entries across 7 tasks: dates tried back and forth (Aircraft Integration's start flipped about 20 times), settings undone, and each setup step logged alone. Five ways were suggested and the user chose four: merge quick edits, fold early edits into "created", a planning phase, and a display that can show every change. The fifth, checking whether arrow keys on date fields save each step, wasn't chosen.

### How it works

- **`addHistory` in `store-core.js`** takes the project and finds an entry to merge into (`mergeTarget`). The merged entry keeps the first `from` and latest `to` of each field, drops fields that ended where they started, records `lastAt`, and keeps each step in `steps` (each with its own author). It keeps at most 100 steps, the first and the latest, and counts the rest in `stepsDropped`.
- **Rules:** an edit merges into the last entry if it's by the same person, within 10 minutes (`MERGE_WINDOW_MS`) of that entry's last change, and that entry is an edit with no note or the "created" entry. Edits with a note (links removed by a delete) stand alone. A reschedule caused by another task merges only with an earlier one for the same cause. One caused by the task's own edit (`selfCaused`) joins that edit. Posted updates always stand alone and end a run.
- **Planning:** `project.planning`, stored only when on. New projects get it unless the request says otherwise. `setBaseline` turns it off, and `updateProject` takes it. While it's on, every edit and every reschedule of a task goes into its "created" entry, whoever makes it, however late, and past posted updates. Imports keep it only when `true`, so older exports and the sample projects aren't in planning.
- **Import:** `parseHistory` keeps `lastAt`, `steps` and `stepsDropped`, and cleans each step like an entry. `SCHEMA_VERSION` is unchanged.
- **Panel (`drawer.js`):** each entry shows where things ended up, with a time range and an "N edits" button that opens its steps (`ctx.openSteps`). **Show every change** (`ctx.historyDetail`) lists every step as its own entry instead. Entries left with nothing changed are hidden unless it's ticked. A "created" entry lists what it was set up with, without the "from". In planning, a note says changes are kept in "created". The count in the heading counts what's shown.
- **Settings:** a **Still planning** box under History in project settings, ticked for new projects.

### Decisions

- **Merge in the store, keeping steps,** so the four choices fit together: the stored list is short, nothing is lost, and "Show every change" can still show it all. Exports don't shrink much, since steps are kept.
- **The window slides:** it's measured from the entry's last change, so a long session of steady edits is one entry. Steps show the detail.
- **Planning keeps changes in "created" rather than recording nothing,** so nothing is lost and turning it off needs no clean-up.
- **Existing projects aren't put in planning,** and existing history isn't rewritten.
- **Different people never merge,** except in planning. Everyone without a name is "Anonymous", so their edits do merge with each other.

### Testing

- `test/history.test.js` (new, 10 tests) uses mock timers for the window. It covers merging, fields put back, people, gaps and updates ending a run, folding into "created", reschedules caused by other tasks and by the task itself, planning and baselines, the setting both ways, the 100-step cap, import and export with junk steps, and action items.
- Tests that check one entry per edit now make projects with `planning: false` and move the mock clock past the window (`actions`, `dependencies`, `task-tracking`, `day-units`). `api.test.js` makes its projects with planning off, and its history test now checks edits folding into "created".
- `browser-tests/history.test.js` (new, both storage modes) covers one entry with its steps, **Show every change** with edits put back, and a new project in planning until it's switched off in settings. `browser-tests/actions.test.js` now expects the item's set-up edits in "created".
- Breakage checks: with merging off, 8 of 10 logic tests and 6 of 6 browser tests failed. With planning off, 2 logic tests failed, and the browser planning test failed once a posted update was put between its edits. Before that change it passed, because quick edits fold into "created" anyway.
- Logic 284 pass. Browser 233 pass in 3 full runs in a row. Screenshot of a merged entry opened, in the dark theme.

### Not tested

- Phones, the light theme, a project switched into planning with long existing histories, and two people editing one task at once in planning.

### Open items

- The user's CSP V3 history is unchanged, since existing history isn't rewritten. A one-off "tidy history" using the same rules was offered.

## Session of 2026-11-23 (evening): holidays and lead/lag on the Gantt

The user asked for holidays to show on the Gantt chart, and for each dependency's lead or lag days to show on it.

### How it works

- **`layoutGantt`** takes `holidays` (ISO dates) and `showLags`. Links now carry `lag` and `lagUnit` (`projectRows` and `portfolioRows`).
- **Holidays:** days in view are grouped into runs (`runsOf`). Each run is one rect under everything, drawn above the weekend shading, with a "Holiday: …" or "Holidays: … – …" tooltip and a 4px mark along the bottom of the date header. Colors are `pal.holiday` and `pal.holidayMark`. They show at every zoom, in SVG, PNG and PowerPoint (no `skipPptx`), and in the export legend when a run is in view.
- **Lead/lag labels:** for a link with a nonzero lag, a small outlined label ("+3d", "−2d" with a real minus sign, "+7cd") sits in the waiting task's row, just above the arrow's end. It's to the left of the bar for links into a start (FS, SS) and to the right for links into a finish (FF, SF).
- **Several labeled links into one side of a task** (fixed the same evening, after the user saw them stacked on top of each other): those arrows share their end, so `lagLabelsFor` puts each label where its own arrow leaves its predecessor instead, above the line, or below it if the arrow turns up. Only labels that can't go at their end compete for a start. If they share a start too, the label goes beside the arrow's upright part. Any label that would still touch another moves along, away from its bar.
- **Beside a milestone,** a label on its right side (an arrow leaving it, or an FF or SF arrow reaching it) starts after the milestone's date, which is drawn there. The milestone's geometry records where its date ends (`clearRight`). Fixed after the user saw a label overlapping the date; 2 scenarios (Fit, Day) check the gap, and fail on the code before. The label takes the arrow's color: red when critical or broken, blue across projects, gray otherwise. Labels are drawn over the arrows so a line never cuts through one.
- **Toolbar:** **Lead/lag** (`ctx.gantt.lags`) on every Gantt. **Holidays** (`ctx.gantt.holidays`) only on a project's chart, and only when it has holidays. Both default on and go to exports through the export spec. The screen legend shows "Holiday" when bands are drawn.

### Decisions

- **Only a project's own chart shows holidays,** since each project has its own. The portfolio chart shows none.
- **No label on links without a lead or lag,** so plain FS links stay uncluttered.
- **Weekends are still shaded even when a project works weekends.** That was already so and wasn't changed. Worth fixing alongside this if it comes up.

### Testing

- `browser-tests/gantt-marks.test.js` (new, 4 scenarios): bands merged and labeled with the header mark and legend, in the export and off with the box; none for a project without holidays or on the portfolio; labels in each unit, in the export, off and back with the box; and labels beside the arrow's end, clear of the bar. Exports are read by catching the preview's SVG blob as the page makes it, since the page's security policy blocks fetching blobs.
- Breakage checks: lag labels off failed 2, holidays off failed 1 (the rest don't involve holidays), and the export not passing holidays failed 1.
- For the stacking fix, 3 more scenarios (Fit, Day and Week) with tasks waiting on two or three others: every label shows, none overlap, and each sits just past its own predecessor's bar in its row. With every label put at its arrow's end, the overlap check alone passed (the nudging spreads them out) but the placement check failed, so the test checks which arrow a label belongs to, not only that labels are apart.
- Logic 284 pass. Browser 242 pass in 2 full runs in a row after the milestone fix. Screenshots of CSP V3 at week zoom and a lag sample at day zoom (dark), and both exports (light).

### Not tested

- The PowerPoint file opened in PowerPoint, phones, labels when arrows crowd together at fit zoom, and a lag label falling off the right edge of the chart.

## Session of 2026-11-24: a version that runs without the server

The user asked for a static version that runs without the server.

### How it works

- **`scripts/build-static.js`** (`npm run build:static`, or with an output path) writes `dist/project-tracker.html`. It puts `styles.css` in a `<style>`, the favicon in a data URL, and PptxGenJS and the app's 23 modules into one loader script, with the PptxGenJS license in a comment.
- **Modules from disk:** browsers won't load modules for a `file://` page, and a single file can't hold separate ones. The loader makes a blob URL of each module and adds an import map from each module's place in the app to its blob, then imports `js/app.js`. The build rewrites only import paths, making them absolute under a made-up address (`https://project-tracker.invalid/`) that the import map matches. Nothing is fetched from it. Every source goes in as JSON with `<` escaped, so nothing in it can end the script early.
- **The app:** the loader sets `window.PROJECT_TRACKER_STATIC`, which `ctx.js` exports as `STATIC`. With it, `refresh` starts from a "not saving" state without fetching `/api/state`, and `listenForChanges` skips the server's event stream but keeps syncing other tabs through storage events. Everything else already worked without a server through `LocalStore`. The banner says "Saved only in this browser." The sidebar logo now uses the page's icon link, since it was the one file still asked for by path.

### Decisions

- **One file** over a folder for a static host, since it also opens from disk and is easy to pass around.
- **Blob modules with an import map** over writing a bundler, so the code runs exactly as written. Only import paths change.
- **Firm leads stay on,** as the server's default. There's no setting for them in the file.
- **`dist/` isn't kept in git.** It's built from the code.

### Found along the way

- **Fields reverting while a save is out (a real bug, now fixed).** A new history test failed once in a full run, in server storage. Tracing it showed that right after a field is changed, a redraw from the not-yet-updated data put the old value back until the server replied. On a slow connection, what you typed disappeared for a moment. Putting the field back to the old value meanwhile then counted as nothing typed, and the reply overwrote it. Fix: a `change` listener marks the field as showing its new value and waiting, and `morph` leaves a waiting field alone while `saving.count` (kept by `api` around each request) is above zero. A failed save still ends with the server's value and an error message. New test in `editing.test.js` holds each save back 400ms: it failed on the old code, both when checking the field right after Tab and when checking it after the reply.
- **Two test races, not app bugs.** The storage tests waited for `.sidebar`, which exists empty before the projects load, so a slow load could find no buttons. `open` in `storage.test.js`, `loadProjects` in `helpers.js` and the new static test now wait for `.sidebar .brand`, which is drawn with the projects. The import test waited a fixed 300ms before clicking **Import**, which stays disabled until the file is read, and clicking it disabled does nothing. It now waits for the button to be enabled.
- **A lead/lag label cut off at the chart's left edge,** seen on the sample plan in the static build's screenshot. Labels are now kept between the names column and the chart's right edge. A test at Week zoom failed without this (the label started at 330, under the names column ending at 340).

### Testing

- `browser-tests/static.test.js` (new, in `test:browser`) builds the file into a temporary folder and opens it from disk. It checks that the app starts with the banner and the PowerPoint library, that a project and task are kept and come back after a reload, that sample projects load, the Gantt draws and an export preview is made, and that nothing is requested except `file:`, `blob:` and `data:` URLs. No console errors.
- Logic 284 pass. Browser 248 pass in 3 full runs in a row. Screenshot of the file opened from disk with the sample plan's Gantt.

### Not tested

- Browsers other than Chrome. Firefox and Safari support import maps and blob modules, but opening the file from disk wasn't tried in them.
- The file on a web host, PowerPoint download and clipboard copy from `file://`, and phones.

