/**
 * Keyboard card navigation and moves on the board (D23), planned over the
 * columns as they are shown: column order left to right, each column's card
 * ids top to bottom. PURE — KanbanBoard executes a move through the same
 * commit path as a drag (planDrop → onUpdate), so ordering, optimistic state,
 * Retry/Undo and sync behave exactly as they do for a drop.
 *
 *   Tab / PageDown        next card: down the column, then the next column's first
 *   Shift+Tab / PageUp    previous card: up the column, then the previous column's last
 *   Ctrl+↑ / Ctrl+↓       one place up / down in the column
 *   Ctrl+→ / Ctrl+←       to the top of the next / previous column
 *                         (Done → In Progress whatever the resolution; nothing
 *                         right of Done or left of TODO)
 */

export type CardDirection = 'up' | 'down' | 'left' | 'right';

export interface ColumnCards {
  status: string;
  ids: readonly string[];
}

/** The column after `status` in `order`, or null at the right end (or unknown). */
export function nextColumn(order: readonly string[], status: string): string | null {
  const at = order.indexOf(status);
  return at >= 0 && at < order.length - 1 ? order[at + 1]! : null;
}

/** The column before `status` in `order`, or null at the left end (or unknown). */
export function prevColumn(order: readonly string[], status: string): string | null {
  const at = order.indexOf(status);
  return at > 0 ? order[at - 1]! : null;
}

/** Where a card is: its column's index and its index in that column. */
export function locateCard(columns: readonly ColumnCards[], id: string): { column: number; index: number } | null {
  for (const [column, cards] of columns.entries()) {
    const index = cards.ids.indexOf(id);
    if (index >= 0) return { column, index };
  }
  return null;
}

/**
 * The card to focus after `id` (delta 1) or before it (delta -1) in reading
 * order — down each column, then on to the next — or null at either end, where
 * the key should fall through to normal focus movement.
 */
export function neighbourCard(columns: readonly ColumnCards[], id: string, delta: 1 | -1): string | null {
  const flat = columns.flatMap((column) => column.ids);
  const at = flat.indexOf(id);
  if (at < 0) return null;
  return flat[at + delta] ?? null;
}

/** The first card of a column, or null when it is empty (or not on the board). */
export function firstCard(columns: readonly ColumnCards[], status: string): string | null {
  return columns.find((column) => column.status === status)?.ids[0] ?? null;
}

export interface KeyboardMove {
  /** The column the card is in now (a column id, never a resolution). */
  fromStatus: string;
  toStatus: string;
  /**
   * Its new place among the destination column's OTHER cards — what planDrop
   * takes as `index`.
   */
  index: number;
}

/**
 * Where a keyboard move takes a card, or null when there is nowhere to go (top
 * of its column, bottom of it, or the board's edge).
 *
 * Across columns the card lands at the TOP of the destination, like a new or
 * bumped card; inside a column it swaps with its neighbour.
 */
export function planKeyboardMove(
  columns: readonly ColumnCards[],
  id: string,
  direction: CardDirection
): KeyboardMove | null {
  const at = locateCard(columns, id);
  if (!at) return null;
  const from = columns[at.column]!;
  if (direction === 'up') {
    return at.index > 0 ? { fromStatus: from.status, toStatus: from.status, index: at.index - 1 } : null;
  }
  if (direction === 'down') {
    return at.index < from.ids.length - 1
      ? { fromStatus: from.status, toStatus: from.status, index: at.index + 1 }
      : null;
  }
  const order = columns.map((column) => column.status);
  const to = direction === 'right' ? nextColumn(order, from.status) : prevColumn(order, from.status);
  return to ? { fromStatus: from.status, toStatus: to, index: 0 } : null;
}
