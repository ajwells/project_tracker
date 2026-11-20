// A date change that would affect other tasks waits here for Apply or Cancel. The panel
// and the Gantt both draw from it, and it belongs to the open task: moving to another
// task, or closing the panel, drops it.

import { ctx } from './ctx.js';
import { toast } from './util.js';
import { previewTaskEdit } from '../shared/preview.js';

let held = null;
let drawn = null; // the preview, until the data changes underneath it

export function previewEdit(taskId, fields) {
  try {
    return previewTaskEdit(ctx.data, taskId, fields);
  } catch {
    return null; // saving would refuse it, and saying why is left to that
  }
}

export function dropEdit() {
  held = null;
  drawn = null;
}

// Holds the edit if it affects other tasks. Otherwise, returns false for it to save as usual.
export function proposeEdit(taskId, fields) {
  dropEdit();
  if (!previewEdit(taskId, fields)?.affectsOthers) return false;
  held = { taskId, fields };
  return true;
}

// What's waiting, worked out afresh if another tab or person has changed the plan.
export function heldEdit() {
  if (!held) return null;
  if (held.taskId !== ctx.taskId || !ctx.findTask(held.taskId)) {
    dropEdit();
    return null;
  }
  if (drawn?.data !== ctx.data) {
    const preview = previewEdit(held.taskId, held.fields);
    if (!preview) {
      dropEdit();
      toast('The plan changed, so that date change no longer applies.', 'error');
      return null;
    }
    drawn = { data: ctx.data, preview };
  }
  return { ...held, preview: drawn.preview };
}
