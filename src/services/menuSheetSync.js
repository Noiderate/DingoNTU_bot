const crypto = require('crypto');
const googleSheets = require('./googleSheets');
const menuStore = require('./menuStore');
const stateStore = require('./stateStore');
const { log } = require('../utils/logger');

/**
 * A one-way, read-only copy of the menu in the FoodAndStock tab, so staff can
 * still see food, prices and stock in the spreadsheet.
 *
 * The database is the source of truth. Nothing here ever reads the sheet back:
 * an edit made in the sheet is overwritten by the next change, which is what
 * lets checkout skip Google Sheets entirely (and its 60-requests-a-minute
 * quota). The note in E1 says so.
 *
 * Only the scheduler calls this, once a minute, and it costs nothing while the
 * menu is unchanged: the rendered rows are hashed and compared with what was
 * last written. A change costs one write, and at most one sync per interval
 * runs across all instances.
 */

const DATA_START = 'FoodAndStock!A2';
const NOTE_CELL = 'FoodAndStock!E1';
const NOTE = 'Read-only copy. Edit food and stock in the bot (Settings > Manage Food Items) - '
  + 'anything typed here is overwritten.';

const MIN_INTERVAL_MS = 20 * 1000;

function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Write the current menu to the sheet if it changed since the last write.
 *
 * Resolves to { synced }, { skipped: 'empty_menu' | 'unchanged' } or
 * { throttled: true }; throws when the sheet could not be written, so the
 * scheduler reports it and the next tick retries.
 */
async function syncMenuToSheet() {
  const items = await menuStore.getFoodItemsOrThrow();

  // Never blank the sheet: an empty menu is a state worth looking at, not
  // mirroring - e.g. the migration ran but the import has not yet.
  if (items.length === 0) {
    return { skipped: 'empty_menu' };
  }

  const rows = items.map(item => [item.name, item.price, item.stock]);
  const hash = hashRows(rows);
  const last = await stateStore.get(stateStore.KEYS.menuSheetSync(), null);

  if (last && last.hash === hash) {
    return { skipped: 'unchanged' };
  }

  const holder = await stateStore.acquireLock(
    stateStore.LOCKS.menuSheetSync(),
    { leaseMs: MIN_INTERVAL_MS }
  );

  // The lease is deliberately never released - see todaySheet.refreshTodaySheet.
  if (!holder) {
    return { throttled: true };
  }

  const isFirstSync = !last;

  if (isFirstSync) {
    // Nothing recorded: the tab may hold rows from an older, longer menu.
    await requireWrite(await googleSheets.clearRange('FoodAndStock!A2:C'), 'clear');
  }

  // One write, padded with blank rows over any that the last write filled and
  // this one no longer does, so a shorter menu leaves nothing behind and the tab
  // is never empty in between.
  const stale = last ? Math.max(0, last.rowCount - rows.length) : 0;
  const padded = [...rows, ...Array.from({ length: stale }, () => ['', '', ''])];

  await requireWrite(await googleSheets.writeToSheet(DATA_START, padded), 'write');

  if (isFirstSync) {
    await requireWrite(await googleSheets.writeToSheet(NOTE_CELL, [[NOTE]]), 'note');
  }

  await stateStore.set(stateStore.KEYS.menuSheetSync(), { hash, rowCount: rows.length });

  log('info', 'menu_sheet_synced', { items: rows.length });
  return { synced: rows.length };
}

// googleSheets' write helpers return false rather than throw.
async function requireWrite(succeeded, what) {
  if (!succeeded) {
    throw new Error(`Could not ${what} the FoodAndStock sheet`);
  }
}

module.exports = {
  syncMenuToSheet,
};
