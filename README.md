# Project Tracker

A multi-project planner in the spirit of Microsoft Project. It tracks tasks and dependencies, draws Gantt charts and timelines, and gets them into PowerPoint in one click. It works on desktop and mobile.

It has no dependencies to install, only Node.js 20 or newer.

## Run it

```
npm start
```

Then open http://localhost:3000. The empty screen offers sample projects if you want something to explore.

In WebStorm, open `package.json` and click the run arrow next to `start`. If `node` isn't on your PATH, WebStorm's copy is at `%APPDATA%\JetBrains\WebStorm2026.2\node\versions\26.13.0`. Add that folder to PATH to use it from any terminal.

| Setting | What it does |
| --- | --- |
| `npm run start:lan` | Shares the app on your network, so a phone can open it |
| `PORT=8080` | Uses a different port (default 3000) |
| `APP_PASSWORD=...` | Requires a password |
| `DATA_FILE=path` | Stores data somewhere else (default `data/store.json`) |

### Opening it on your phone

Run `npm run start:lan` and open the "Your network" address it prints. Anyone on that network can then open and edit your projects, so set `APP_PASSWORD` first on any network you don't fully trust. The password is sent without encryption over plain HTTP, so it won't protect you on a public network or the open internet. Use an HTTPS proxy for those.

Browsers only allow copying images from HTTPS or localhost pages. Over a plain network address, use the PNG or PowerPoint download instead.

## Features

- **Multiple projects**, with a portfolio view across all of them
- **Dependencies**: finish-to-start, start-to-start, finish-to-finish and start-to-finish, with lag or lead in working days
- **Automatic scheduling** that follows dependencies and each project's working calendar (weekends and holidays), and refuses dependency loops
- **Critical path and float**, calculated across projects
- **Summary tasks, milestones and baselines**
- **Gantt charts**: drag a bar to move it or its right edge to resize (mouse only), and zoom from days to quarters
- **Timelines** built for slides: milestones above a date band, phases and key tasks below
- **Cross-project links**: tasks can depend on tasks in other projects. The Links tab shows who is waiting on whom and how much buffer each link has
- **Task history**: every field change is recorded with who, when, from and to. You can also post written updates, and dates moved by another task's change are logged with the cause
- **Current POC** on every task, with contact details, filtering, and a record of past POCs in the history
- **Import and export** of all projects as one JSON file
- **Live updates** between open tabs and devices

### Getting charts into PowerPoint

On any Gantt or Timeline tab, click **Copy for PowerPoint**:

| Option | Result |
| --- | --- |
| **Copy image** | A sharp image on your clipboard. Paste it into a slide |
| **PowerPoint** | A `.pptx` built from native shapes you can recolor, move and edit |
| **PNG / SVG** | Image files |

Exports always use the light theme, whatever theme the app is in. A Gantt chart too long for one slide continues onto more slides with the same date scale; arrows between tasks on different slides are left out.

## How scheduling works

- **Start is a request.** A task starts on the date you ask for, or later if its predecessors require it. If they move back, the task returns to the date you asked for.
- **Duration is in working days**, using that project's calendar.
- **Manually scheduled tasks** keep their dates and show a conflict if a predecessor runs past them.
- **Completed tasks** stay where they finished.
- **Summary tasks** roll up dates, status and progress from their subtasks, and a dependency on a summary applies to all its subtasks.

## Import and export

**Export all projects** downloads everything, including history. **Import projects** offers two modes:

- **Merge** adds new projects and updates those with a matching ID.
- **Replace everything** swaps all data for the file.

Files are fully checked first, so a bad file changes nothing. Every import saves a backup to `data/backups/` beforehand.

## Development

```
npm test        # scheduler and API tests
npm run dev     # restart the server on file changes
```

| Path | Purpose |
| --- | --- |
| `src/scheduler.js` | Scheduling engine with no side effects |
| `src/store.js` | Validation, history, import, and saving to disk |
| `src/server.js` | HTTP API, live updates, static files |
| `public/js/chart/` | Chart layout, plus SVG and PowerPoint renderers |
| `public/js/views/` | Screens |
| `public/vendor/` | [PptxGenJS](https://github.com/gitbrent/PptxGenJS) 4.0.1 (MIT), included so there is nothing to install |

Your data lives in `data/`, which git ignores.
