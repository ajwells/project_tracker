# Project Tracker

A multi-project planner in the spirit of Microsoft Project. It tracks tasks and dependencies, draws Gantt charts and timelines, and gets them into PowerPoint in one click. It works on desktop and mobile.

Running it needs nothing installed except Node.js 20 or newer. Only the browser tests have a dependency.

## Run it

```
npm start
```

Then open http://localhost:3000. The empty screen offers sample projects if you want something to explore.

**By default, projects are stored in each person's browser, not on the server.** See [Where data is stored](#where-data-is-stored).

In WebStorm, open `package.json` and click the run arrow next to `start`. If `node` isn't on your PATH, WebStorm's copy is at `%APPDATA%\JetBrains\WebStorm2026.2\node\versions\26.13.0`. Add that folder to PATH to use it from any terminal.

| Setting | What it does |
| --- | --- |
| `PORT=8080` | Uses a different port (default 3000) |
| `APP_PASSWORD=...` | Requires a password |
| `DATA_FILE=path` | Stores data somewhere else (default `data/store.json`) |
| `FIRM_LEADS=false` | Treats negative SS and SF links by the standard definition (default `true`, see [How scheduling works](#how-scheduling-works)) |
| `SAVE_DATA=true` | Stores projects on the server and shares them (default `false`, which stores them in each browser) |

### Where data is stored

| | `SAVE_DATA=false` (default) | `SAVE_DATA=true` |
| --- | --- | --- |
| **Where projects are kept** | In each browser's site storage | In `data/store.json` on the server |
| **Shared between people and devices** | No, each browser has its own copy | Yes, with live updates |
| **Survives a server restart** | Yes | Yes |
| **Lost if** | Browser data is cleared | The server's data file is deleted |
| **Backup before an import** | No | Yes, in `data/backups/` |

With saving off:

- The server refuses changes, so project data never reaches it. Every page shows a warning banner.
- Open tabs in the same browser stay in sync.
- Browsers treat each address as a separate site. `http://localhost:3000`, your network address and any other port each have their own copy, so use one address consistently, or move projects with export and import.
- Browsers limit site storage, usually to about 5 MB. If a change doesn't fit, it's refused with a message and nothing is lost.
- Safari can delete site storage after seven days without a visit, and private windows discard it on close. Export regularly if you rely on either.
- If the server already has a data file, a browser copies it on its first visit, and works on its own copy after that. The file isn't changed.

Switching `SAVE_DATA` doesn't move any data. Use export and import to take projects from one mode to the other.

### Opening it on your phone

The server listens on all network interfaces, so open the "Your network" address it prints at startup. With `SAVE_DATA` on, anyone on that network can also open and edit your projects. With it off, they get their own separate copy, but can still read any data file already on the server. Set `APP_PASSWORD` first on any network you don't fully trust. The password is sent without encryption over plain HTTP, so it won't protect you on a public network or the open internet. Use an HTTPS proxy for those.

Browsers only allow copying images from HTTPS or localhost pages. Over a plain network address, use the PNG or PowerPoint download instead.

## Features

- **Multiple projects**, with a portfolio view across all of them
- **Dependencies**: finish-to-start, start-to-start, finish-to-finish and start-to-finish, with lag or lead in working days, each described in plain English
- **Automatic scheduling** that follows dependencies and each project's working calendar (weekends and holidays), and refuses dependency loops
- **Track each task by duration or by dates**: enter one, and the other fills in
- **Critical path and float**, calculated across projects
- **Summary tasks, milestones and baselines**
- **Selected task highlighted** on the Gantt chart and timeline while its panel is open. The highlight never appears in exports
- **Gantt charts**: drag a bar to move it or its right edge to resize (mouse only), and zoom from days to quarters
- **Timelines** built for slides: milestones above a date band, phases and key tasks below
- **Cross-project links**: tasks can depend on tasks in other projects. The Links tab shows who is waiting on whom and how much buffer each link has
- **Task history**: every field change is recorded with who, when, from and to. You can also post written updates, and dates moved by another task's change are logged with the cause
- **Current POC** on every task, with contact details, filtering, and a record of past POCs in the history
- **Import and export** of all projects as one JSON file
- **Live updates** between open tabs, and between devices when the server is saving data

### Getting charts into PowerPoint

On any Gantt or Timeline tab, click **Copy for PowerPoint**:

| Option | Result |
| --- | --- |
| **Copy image** | A sharp image on your clipboard. Paste it into a slide |
| **PowerPoint** | A `.pptx` built from native shapes you can recolor, move and edit |
| **PNG / SVG** | Image files |

Exports always use the light theme, whatever theme the app is in. A Gantt chart too long for one slide continues onto more slides with the same date scale; arrows between tasks on different slides are left out.

## How scheduling works

Each task is tracked one of two ways, set with **Track by** in the task panel:

| | **Duration** (the default) | **Dates** |
| --- | --- | --- |
| **You enter** | The working days | The start and finish |
| **Fills in** | The finish, and the start if none is set | The working days |
| **If a linked task moves** | This task moves too | This task stays put and shows a conflict |

Switching keeps the task's current dates and length. Switching back to duration lets its links set its start again.

For a task tracked by duration, the start works like this:

- **With no start date set**, a task goes wherever its links put it, earlier or later. Negative lag can pull it ahead of the day it was created. With no links, it stays where it is.
- **With a start date set**, by typing one or dragging its bar, that date holds. The task only moves later if its links require it, and returns when they move back. If the date is keeping it later than its links need, the task panel says so and offers **Follow links**.

Tasks saved before this setting existed count as having a start date set, so upgrading doesn't move anything.

Also:

- **Duration is in working days**, using that project's calendar.
- **Most links only set the earliest date.** The task panel says each link in plain English, and says when a task is later than its link requires.
- **Negative SS and SF links are firm, which differs from the standard.** "Task 2 finishes 30 working days before Task 1 starts" is a rule both ways: Task 2 moves with Task 1, it can't be later than that, and it has no more float than Task 1. Being later shows a conflict and marks the task at risk, without moving Task 1, so you decide what gives. By the standard meaning, these links only set the earliest date and the earlier task can slip freely. Set `FIRM_LEADS=false` for that behaviour. No dates change either way, only conflicts, float and the critical path.
- **Critical means slipping moves a project's finish or breaks a firm link.** Critical tasks can be in other projects, if a link makes them matter there.
- **Lag can be negative.** It counts working days in the calendar of the task that depends on the link. Without any lag, FS starts the working day after the predecessor finishes, SS starts when it starts, FF finishes when it finishes, and SF finishes the working day before it starts.
- **Manually scheduled tasks** keep their dates and show a conflict if a predecessor runs past them.
- **Completed tasks** stay where they finished.
- **Summary tasks** roll up dates, status and progress from their subtasks, and a dependency on a summary applies to all its subtasks.

## Import and export

**Export all projects** downloads everything, including history. **Import projects** offers two modes:

- **Merge** adds new projects and updates those with a matching ID.
- **Replace everything** swaps all data for the file.

Files are fully checked first, so a bad file changes nothing. When `SAVE_DATA` is on, every import saves a backup to `data/backups/` beforehand.

## Development

```
npm test                 # scheduling, storage and API tests
npm run test:browser     # the real page in real Chrome
npm run dev              # restart the server on file changes
```

`npm test` needs nothing installed. `npm run test:browser` needs `npm install` once, which adds [puppeteer-core](https://pptr.dev/) for development only, and Google Chrome. If Chrome isn't found, set `CHROME_PATH` to where it's installed.

The browser tests click, type and swipe with human timing, and catch what `npm test` can't: lost clicks, fields that don't update, phone scrolling and browser storage. Run them after changing anything in `public/js/` or `public/styles.css`. They start their own servers on free ports with temporary data files, so they don't touch your data or a server you already have running. They run side by side using half of your processor cores, up to 16 at once. Set `BROWSER_TEST_CONCURRENCY` to change that.

| Path | Purpose |
| --- | --- |
| `browser-tests/` | Tests that drive the real page in Chrome |
| `public/shared/` | Code used by both the server and the browser: scheduling, validation, history, import, and the API's change requests |
| `public/js/local-store.js` | Keeps projects in the browser when `SAVE_DATA` is off |
| `src/store.js` | Saves projects to disk when `SAVE_DATA` is on |
| `src/server.js` | HTTP API, live updates, static files |
| `public/js/chart/` | Chart layout, plus SVG and PowerPoint renderers |
| `public/js/views/` | Screens |
| `public/vendor/` | [PptxGenJS](https://github.com/gitbrent/PptxGenJS) 4.0.1 (MIT), included so there is nothing to install |

With `SAVE_DATA` on, your data lives in `data/`, which git ignores.
