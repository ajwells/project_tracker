// Dragging a task up or down a list to reorder it, on the Gantt chart's labels and the
// Tasks tab. Mouse only, like dragging bars: on touch screens a swipe has to scroll,
// and the task panel's move buttons still work there.

import { api } from './ctx.js';

// Where a drop over row `index` would put the dragged task, or null if it can't go
// there. `rows` are the rows shown, in order, as { id, depth, open }, where open marks
// a summary showing its subtasks. The top half of a row drops before it. The bottom
// half drops after it, or first inside it if it's an open summary, so the line drawn
// between a summary and its first subtask means the same either way.
export function placement(rows, index, lower, dragId) {
  const row = rows[index];
  if (!row) return null;
  const at = rows.findIndex((r) => r.id === dragId);
  if (at >= 0) {
    let end = at + 1;
    while (end < rows.length && rows[end].depth > rows[at].depth) end++;
    if (index >= at && index < end) return null; // onto itself or its own subtasks
  }
  if (!lower) return { direction: 'before', targetId: row.id, edge: index, depth: row.depth };
  if (row.open) return { direction: 'into', targetId: row.id, edge: index + 1, depth: row.depth + 1 };
  return { direction: 'after', targetId: row.id, edge: index + 1, depth: row.depth };
}

// Whether a drop would leave the task where it is.
function staysPut(rows, place, dragId) {
  const at = rows.findIndex((r) => r.id === dragId);
  if (at < 0) return false;
  let end = at + 1;
  while (end < rows.length && rows[end].depth > rows[at].depth) end++;
  return (place.edge === at || place.edge === end) && place.depth === rows[at].depth;
}

/**
 * Follows a mouse press until it's let go, and moves the task if it was dragged to a
 * new place. Returns nothing; `onDragged` is called once the press turns into a drag,
 * so the caller can ignore the click that follows.
 *   rowAt(clientY)  -> { index, lower } for the row under the pointer, or null
 *   showLine(place) -> draws where the task would go, or clears it for null
 *   scroller        -> scrolled up or down when the pointer nears its edge
 */
export function dragToReorder(downEvent, { dragId, rows, rowAt, showLine, scroller, onDragged }) {
  const startY = downEvent.clientY;
  let dragging = false;
  let place = null;
  let lastY = startY;
  let scrollTimer = null;

  const locate = () => {
    const hit = rowAt(lastY);
    const next = hit ? placement(rows, hit.index, hit.lower, dragId) : null;
    place = next && !staysPut(rows, next, dragId) ? next : null;
    showLine(place);
  };
  // Scrolls while the pointer is held near the top or bottom edge.
  const autoScroll = () => {
    const box = scroller.getBoundingClientRect();
    const zone = 36;
    const step = lastY < box.top + zone ? -12 : lastY > box.bottom - zone ? 12 : 0;
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) locate();
    }
  };
  const move = (event) => {
    lastY = event.clientY;
    if (!dragging) {
      if (Math.abs(lastY - startY) < 5) return;
      dragging = true;
      onDragged?.();
      document.body.classList.add('reordering');
      getSelection()?.removeAllRanges();
      scrollTimer = setInterval(autoScroll, 30);
    }
    locate();
  };
  // Stops the click that the release sends to whatever row it lands on. That click
  // comes before any new press, so the next press ends this if no click came. A timer
  // would be simpler, but a browser can run one late and swallow a real click after it.
  const swallowClick = () => {
    const stop = (event) => {
      event.stopPropagation();
      event.preventDefault();
      done();
    };
    const done = () => {
      removeEventListener('click', stop, true);
      removeEventListener('pointerdown', done, true);
    };
    addEventListener('click', stop, true);
    addEventListener('pointerdown', done, true);
  };
  const end = (commit) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', cancel);
    removeEventListener('keydown', escape, true);
    clearInterval(scrollTimer);
    document.body.classList.remove('reordering');
    showLine(null);
    if (commit && dragging && place) api('POST', `/api/tasks/${dragId}/move`, { direction: place.direction, targetId: place.targetId });
  };
  const up = () => {
    if (dragging) swallowClick();
    end(true);
  };
  const cancel = () => end(false);
  // Esc abandons the drag. The release that follows still mustn't count as a click.
  const escape = (event) => {
    if (event.key !== 'Escape' || !dragging) return;
    event.stopPropagation();
    swallowClick();
    end(false);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', cancel);
  addEventListener('keydown', escape, true);
}
