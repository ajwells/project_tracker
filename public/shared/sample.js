// Sample portfolio, offered on the empty screen so the app can be explored
// before entering real data. Dates are relative to today.

import { makeCalendar, toDayNumber, toIso } from './scheduler.js';
import { EXPORT_FORMAT, SCHEMA_VERSION } from './store-core.js';

export function buildSample(todayIso) {
  const cal = makeCalendar();
  const today = toDayNumber(todayIso);
  const day = (offset) => toIso(cal.add(today, offset));
  const stamp = new Date().toISOString();
  const seen = new Map();
  const id = (key) => {
    if (!seen.has(key)) seen.set(key, `s${Math.random().toString(36).slice(2, 12)}${seen.size}`);
    return seen.get(key);
  };

  const task = (key, name, options = {}) => ({
    id: id(key),
    name,
    notes: options.notes ?? '',
    parentId: options.parent ? id(options.parent) : null,
    start: options.start ?? todayIso,
    startSet: options.start !== undefined,
    duration: options.milestone ? 0 : options.duration ?? 5,
    milestone: !!options.milestone,
    manual: false,
    onTimeline: !!options.key,
    status: options.status ?? 'not_started',
    progress: options.progress ?? (options.status === 'complete' ? 100 : 0),
    pocName: options.poc ?? '',
    pocContact: options.contact ?? '',
    deps: (options.deps ?? []).map((d) =>
      typeof d === 'string' ? { taskId: id(d), type: 'FS', lag: 0 } : { taskId: id(d.on), type: d.type ?? 'FS', lag: d.lag ?? 0 },
    ),
    schedStart: null,
    schedEnd: null,
    history: [
      { id: id(`h-${key}`), at: stamp, type: 'create', author: 'Sample data', note: 'Task created' },
      ...(options.update ? [{ id: id(`u-${key}`), at: stamp, type: 'update', author: options.poc ?? 'Sample data', note: options.update }] : []),
    ],
  });

  const project = (key, name, color, owner, description, tasks) => ({
    id: id(key),
    name,
    description,
    owner,
    color,
    calendar: { workWeekends: false, holidays: [] },
    baseline: null,
    createdAt: stamp,
    updatedAt: stamp,
    tasks,
  });

  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    projects: [
      project('platform', 'Platform Migration', 'blue', 'Priya Raman', 'Move core services to the new cloud platform.', [
        task('p-plan', 'Planning', {}),
        task('p-assess', 'Assess current services', { parent: 'p-plan', start: day(-30), duration: 8, status: 'complete', poc: 'Priya Raman' }),
        task('p-arch', 'Target architecture', { parent: 'p-plan', start: day(-30), duration: 10, status: 'complete', poc: 'Marcus Lee', deps: [{ on: 'p-assess', type: 'SS', lag: 3 }] }),
        task('p-signoff', 'Architecture sign-off', { milestone: true, parent: 'p-plan', status: 'complete', start: day(-16), poc: 'Priya Raman', key: true, deps: ['p-arch'] }),
        task('p-build', 'Build', {}),
        task('p-infra', 'Provision infrastructure', { parent: 'p-build', start: day(-14), duration: 12, status: 'in_progress', progress: 80, poc: 'Marcus Lee', contact: 'marcus@example.com', deps: ['p-signoff'], update: 'Staging is up. Production network review is on Thursday.' }),
        task('p-data', 'Migrate data stores', { parent: 'p-build', duration: 15, poc: 'Dana Whitfield', deps: ['p-infra'] }),
        task('p-api', 'Publish v2 API', { parent: 'p-build', duration: 10, poc: 'Tomás Ortega', deps: [{ on: 'p-infra', type: 'SS', lag: 5 }], status: 'in_progress', progress: 25 }),
        task('p-apiready', 'v2 API ready', { milestone: true, parent: 'p-build', poc: 'Tomás Ortega', key: true, deps: ['p-api'] }),
        task('p-cut', 'Cutover', {}),
        task('p-test', 'Load and failover testing', { parent: 'p-cut', duration: 8, poc: 'Dana Whitfield', deps: ['p-data', 'p-apiready'] }),
        task('p-golive', 'Production go-live', { milestone: true, parent: 'p-cut', poc: 'Priya Raman', key: true, deps: ['p-test'] }),
      ]),
      project('app', 'Mobile App Relaunch', 'orange', 'Jordan Ellis', 'Rebuild the customer app on the v2 API.', [
        task('a-design', 'Design', {}),
        task('a-research', 'Customer research', { parent: 'a-design', start: day(-12), duration: 6, status: 'complete', poc: 'Jordan Ellis' }),
        task('a-ux', 'UX and visual design', { parent: 'a-design', duration: 10, status: 'in_progress', progress: 60, poc: 'Sam Nakamura', deps: ['a-research'], update: 'Checkout flow needs one more round of testing.' }),
        task('a-dev', 'Development', {}),
        task('a-client', 'Build app screens', { parent: 'a-dev', duration: 18, poc: 'Avery Chen', deps: ['a-ux'] }),
        task('a-integrate', 'Integrate v2 API', { parent: 'a-dev', duration: 8, poc: 'Avery Chen', deps: ['p-apiready', { on: 'a-client', type: 'SS', lag: 4 }], notes: 'Waiting on the Platform team to publish the v2 API.' }),
        task('a-launch', 'Launch', {}),
        task('a-beta', 'Public beta', { parent: 'a-launch', duration: 10, poc: 'Jordan Ellis', key: true, deps: ['a-client', 'a-integrate'] }),
        task('a-store', 'App store release', { milestone: true, parent: 'a-launch', poc: 'Jordan Ellis', key: true, deps: ['a-beta', 'p-golive'] }),
      ]),
      project('launch', 'Go-to-Market', 'aqua', 'Renee Okafor', 'Announce and support the relaunch.', [
        task('g-brief', 'Messaging and positioning', { start: day(-3), duration: 8, status: 'in_progress', progress: 40, poc: 'Renee Okafor', key: true }),
        task('g-assets', 'Campaign assets', { duration: 12, poc: 'Lena Fischer', deps: ['g-brief'] }),
        task('g-train', 'Train support team', { duration: 6, poc: 'Lena Fischer', deps: ['a-beta'] }),
        task('g-announce', 'Public announcement', { milestone: true, poc: 'Renee Okafor', key: true, deps: ['g-assets', 'g-train', 'a-store'] }),
      ]),
    ],
  };
}
