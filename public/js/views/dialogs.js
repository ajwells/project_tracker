import { api, ctx } from '../ctx.js';
import { confirmDialog, DEP_TYPES, describeDep, h, LAG_HELP, openDialog, parseLag, plural, selectOnFocus, toast, fmtDate } from '../util.js';
import { currentMode, PROJECT_COLORS } from '../chart/core.js';
import { orderedTasks } from '../chart/gantt.js';

const field = (label, control) => h('label', { class: 'field' }, label, control);

// ---- project create and settings --------------------------------------------

export function openProjectDialog(project = null) {
  const mode = currentMode();
  let color = project?.color ?? null;
  const name = h('input', { type: 'text', value: project?.name ?? '', required: true, maxlength: 200, autocomplete: 'off' });
  const owner = h('input', { type: 'text', value: project?.owner ?? '', maxlength: 100, list: 'owner-names', autocomplete: 'off' });
  const description = h('textarea', { rows: 2, maxlength: 2000 }, project?.description ?? '');
  const weekends = h('input', { type: 'checkbox', checked: !!project?.calendar?.workWeekends });
  const holidays = h('textarea', { rows: 2, placeholder: '2026-12-25, 2027-01-01' }, (project?.calendar?.holidays ?? []).join(', '));

  const swatches = h('div', { class: 'color-swatches', role: 'group', 'aria-label': 'Project color' });
  const drawSwatches = () => swatches.replaceChildren(...Object.entries(PROJECT_COLORS).map(([key, value]) => h('button', {
    type: 'button',
    'aria-label': key,
    'aria-pressed': String(color === key),
    style: { background: value[mode] },
    onclick: () => {
      color = key;
      drawSwatches();
    },
  })));
  drawSwatches();

  const save = async () => {
    if (!name.value.trim()) {
      toast('Give the project a name.', 'error');
      name.focus();
      return;
    }
    const dates = holidays.value.split(/[\s,]+/).filter(Boolean);
    const body = {
      name: name.value,
      owner: owner.value,
      description: description.value,
      calendar: { workWeekends: weekends.checked, holidays: dates },
      ...(color ? { color } : {}),
    };
    if (project) {
      if (await api('PATCH', `/api/projects/${project.id}`, body)) close();
    } else {
      const result = await api('POST', '/api/projects', body);
      if (result) {
        close();
        ctx.go(`#/p/${result.createdId}/tasks`);
      }
    }
  };

  const remove = async () => {
    const links = ctx.data.crossLinks.filter((l) => l.fromProjectId === project.id || l.toProjectId === project.id).length;
    const ok = await confirmDialog({
      title: `Delete "${project.name}"?`,
      message: `This permanently deletes ${plural(project.tasks.length, 'task')} and their history${links ? `, and removes ${plural(links, 'cross-project link')}` : ''}. Export first if you might want it back.`,
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    if (await api('DELETE', `/api/projects/${project.id}`)) {
      close();
      ctx.go('#/');
    }
  };

  const { close } = openDialog({
    title: project ? 'Project settings' : 'New project',
    body: [
      field('Name', name),
      field('Owner', owner),
      h('datalist', { id: 'owner-names' }, ctx.pocNames().map((n) => h('option', { value: n }))),
      field('Description', description),
      h('div', { class: 'field' }, h('span', { class: 'small', style: { fontWeight: 550, color: 'var(--ink-2)' } }, 'Color'), swatches),
      h('h3', {}, 'Working calendar'),
      h('label', { class: 'check' }, weekends, h('span', {}, 'Work on weekends')),
      field('Holidays (YYYY-MM-DD, separated by commas)', holidays),
      project?.baseline ? h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('span', { class: 'small muted' }, `Baseline saved ${fmtDate(project.baseline.at.slice(0, 10), true)}`),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            if (await api('DELETE', `/api/projects/${project.id}/baseline`)) close();
          },
        }, 'Clear baseline')) : null,
    ],
    footer: [
      project ? h('button', { class: 'btn danger left', type: 'button', onclick: remove }, 'Delete project') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', 'data-action': 'save-project', onclick: save }, project ? 'Save' : 'Create project'),
    ],
  });
  name.focus();
}

// ---- your name --------------------------------------------------------------

export function openNameDialog() {
  const name = h('input', { type: 'text', value: ctx.actor, maxlength: 100, autocomplete: 'name' });
  const save = () => {
    ctx.actor = name.value.trim();
    close();
    ctx.render();
  };
  const { close } = openDialog({
    title: 'Your name',
    body: [
      h('p', { class: 'muted' }, 'Your name appears on the updates and changes you make. It\'s saved in this browser.'),
      field('Name', name),
    ],
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'),
    ],
  });
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
  });
  name.focus();
}

// ---- cross-project link -----------------------------------------------------

export function openLinkDialog(project) {
  const projects = ctx.data.projects;
  const taskOptions = (p) => orderedTasks(p).map((t) => h('option', { value: t.id }, `${t.computed.wbs}  ${t.name}`));
  const others = (id) => projects.filter((p) => p.id !== id);

  const toProject = h('select', { onchange: () => sync() }, projects.map((p) => h('option', { value: p.id, selected: p.id === project?.id }, p.name)));
  const plain = h('p', { class: 'dep-plain' });
  const describe = () => {
    const to = ctx.findTask(toTask.value);
    const from = ctx.findTask(fromTask.value);
    const lagDays = parseLag(lag.value, lag.validity.badInput);
    plain.textContent = to && from && lagDays !== null ? describeDep({ type: type.value, lag: lagDays, lagUnit: lagUnit.value }, to.task, from.task, ctx.isFirm({ type: type.value, lag: lagDays })) : '';
  };
  const toTask = h('select', { onchange: () => describe() });
  const fromProject = h('select', { onchange: () => syncFrom() });
  const fromTask = h('select', { onchange: () => describe() });
  const type = h('select', { onchange: () => describe() }, Object.entries(DEP_TYPES).map(([k, v]) => h('option', { value: k }, `${v} (${k})`)));
  const lag = h('input', { type: 'number', value: 0, onfocus: selectOnFocus, oninput: () => describe() });
  const lagUnit = h('select', { onchange: () => describe() }, h('option', { value: 'working' }, 'Working days'), h('option', { value: 'calendar' }, 'Calendar days'));

  function syncFrom() {
    fromTask.replaceChildren(...taskOptions(ctx.project(fromProject.value)));
    describe();
  }
  function sync() {
    toTask.replaceChildren(...taskOptions(ctx.project(toProject.value)));
    const previous = fromProject.value;
    fromProject.replaceChildren(...others(toProject.value).map((p) => h('option', { value: p.id, selected: p.id === previous }, p.name)));
    syncFrom();
  }
  sync();

  const save = async () => {
    if (!toTask.value || !fromTask.value) {
      toast('Choose a task on both sides of the link.', 'error');
      return;
    }
    const { task } = ctx.findTask(toTask.value);
    if (task.deps.some((d) => d.taskId === fromTask.value)) {
      toast('Those tasks are already linked.', 'error');
      return;
    }
    const lagDays = parseLag(lag.value, lag.validity.badInput);
    if (lagDays === null) {
      toast(LAG_HELP, 'error');
      return;
    }
    const deps = [...task.deps, { taskId: fromTask.value, type: type.value, lag: lagDays, lagUnit: lagUnit.value }];
    if (await api('PATCH', `/api/tasks/${task.id}`, { deps })) close();
  };

  const { close } = openDialog({
    title: 'Add cross-project link',
    body: [
      h('h3', {}, 'This task…'),
      h('div', { class: 'field-grid' }, field('Project', toProject), field('Task', toTask)),
      h('h3', {}, '…depends on'),
      h('div', { class: 'field-grid' }, field('Project', fromProject), field('Task', fromTask)),
      field('Type', type),
      h('div', { class: 'field-grid' }, field('Lag', lag), field('Counted in', lagUnit)),
      plain,
    ],
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Add link'),
    ],
  });
}

// ---- import -----------------------------------------------------------------

export function openImportDialog() {
  let parsed = null;
  const summary = h('div', { class: 'callout', hidden: true });
  const merge = h('input', { type: 'radio', name: 'import-mode', value: 'merge', checked: true });
  const replace = h('input', { type: 'radio', name: 'import-mode', value: 'replace' });
  const go = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: run }, 'Import');

  const file = h('input', {
    type: 'file',
    accept: '.json,application/json',
    'aria-label': 'Export file',
    onchange: async () => {
      parsed = null;
      go.disabled = true;
      summary.hidden = false;
      summary.className = 'callout';
      const chosen = file.files[0];
      if (!chosen) {
        summary.hidden = true;
        return;
      }
      try {
        const data = JSON.parse(await chosen.text());
        if (!Array.isArray(data.projects)) throw new Error();
        parsed = data;
        go.disabled = false;
        const tasks = data.projects.reduce((n, p) => n + (Array.isArray(p?.tasks) ? p.tasks.length : 0), 0);
        const existing = new Set(ctx.data.projects.map((p) => p.id));
        const matching = data.projects.filter((p) => existing.has(p?.id)).length;
        summary.textContent = `Found ${plural(data.projects.length, 'project')} and ${plural(tasks, 'task')}${matching ? `. ${plural(matching, 'project')} already exist${matching === 1 ? 's' : ''} here.` : '.'}`;
      } catch {
        summary.className = 'callout bad';
        summary.textContent = 'This file can\'t be read. Choose a .json file created by "Export all projects".';
      }
    },
  });

  async function run() {
    const mode = replace.checked ? 'replace' : 'merge';
    if (mode === 'replace' && ctx.data.projects.length) {
      const ok = await confirmDialog({
        title: 'Replace all projects?',
        message: `Your ${plural(ctx.data.projects.length, 'current project')} will be replaced by this file. ${ctx.data.saving ? 'A backup copy is saved on the server first, in data/backups.' : 'No backup copy is made, so export your projects first if you want to keep them.'}`,
        confirmLabel: 'Replace everything',
        danger: true,
      });
      if (!ok) return;
    }
    const result = await api('POST', '/api/import', { mode, data: parsed });
    if (!result) return;
    close();
    const { added, replaced, droppedLinks } = result.importResult;
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (replaced) parts.push(`${replaced} updated`);
    toast(`Import finished: ${parts.join(', ') || 'no projects'}.${droppedLinks ? ` ${plural(droppedLinks, 'link')} to missing tasks removed.` : ''}`);
    ctx.go('#/');
  }

  const { close } = openDialog({
    title: 'Import projects',
    body: [
      h('p', { class: 'muted' }, 'Choose a file created by "Export all projects".'),
      file,
      summary,
      h('label', { class: 'choice' }, merge, h('div', {}, h('b', {}, 'Merge'), h('span', {}, 'Add new projects and update ones that match. Everything else stays.'))),
      h('label', { class: 'choice' }, replace, h('div', {}, h('b', {}, 'Replace everything'), h('span', {}, 'Delete all current projects and use only this file.'))),
    ],
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
      go,
    ],
  });
}
