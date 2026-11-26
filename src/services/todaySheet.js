const crypto = require('crypto');
const { DateTime } = require('luxon');
const googleSheets = require('./googleSheets');
const { getSupabase, unwrap } = require('./supabase');
const stateStore = require('./stateStore');
const { STATUS_LABELS, paymentStatusFor } = require('./sheetMirror');
const { ACTIVE_STATUSES } = require('./orderRepository');
const menuStore = require('./menuStore');
const { SGT } = require('../utils/time');
const { log } = require('../utils/logger');
const { config } = require('../config');

/**
 * A live, human-friendly "what's happening tonight" tab, separate from the
 * Orders mirror (which is the full historical audit log). Rebuilt from
 * scratch on every refresh rather than upserted row-by-row, because this
 * view resets to empty at the start of each service day - a full rewrite is
 * the simplest way to guarantee a short night doesn't leave a longer one's
 * rows behind it.
 *
 * Reads only what's already in Supabase; no schema changes needed.
 */

const SHEET_TITLE = "Today's Orders";

// A1 notation requires the sheet title in single quotes, with any internal
// single quote doubled.
const QUOTED_SHEET = `'${SHEET_TITLE.replace(/'/g, "''")}'`;

const HEADERS = ['Order ID', 'Time', 'Telegram Handle', 'Hall', 'Items', 'Order Status', 'Payment Status'];
const COLUMN_COUNT = HEADERS.length;

// Orders that never actually happened don't belong in a "what to prepare"
// total - only their listing row above still shows they were attempted.
const EXCLUDED_FROM_TOTALS = new Set(['rejected', 'cancelled', 'expired']);

// The tab is rewritten at most once per this interval, across all instances.
const REFRESH_MIN_INTERVAL_MS = 20 * 1000;

// An unchanged tab is still rewritten this often, so a cleared or edited tab
// heals itself instead of staying wrong until the next order.
const FORCE_REWRITE_MS = 10 * 60 * 1000;

// Best-effort, per-instance cache so a busy period doesn't re-fetch
// spreadsheet metadata on every single order change.
let cachedSheetId = null;

function telegramHandle(customer) {
  if (!customer) {
    return '';
  }
  if (customer.telegram_username) {
    return `@${customer.telegram_username}`;
  }
  if (customer.first_name) {
    return customer.first_name;
  }
  return customer.telegram_user_id ? String(customer.telegram_user_id) : '';
}

function itemsSummary(orderItems) {
  return (orderItems || [])
    .map(item => `${item.item_name_snapshot} x${item.quantity}`)
    .join(', ');
}

/**
 * The current service day's [start, end) window in SGT.
 *
 * A calendar day (midnight to midnight) would split one night's delivery run
 * across two buckets right as it crosses into the small hours - so "today"
 * instead runs from config.service.dayStartHour (default 3pm) to the same
 * hour the next day. A 1:32am order belongs to the service day that started
 * the previous afternoon, not the one that "starts" at midnight.
 */
function getServiceDayWindow(now = DateTime.now().setZone(SGT)) {
  const cutoffHour = config.service.dayStartHour;
  const todaysCutoff = now.set({ hour: cutoffHour, minute: 0, second: 0, millisecond: 0 });
  const start = now < todaysCutoff ? todaysCutoff.minus({ days: 1 }) : todaysCutoff;

  return { start, end: start.plus({ days: 1 }) };
}

async function getTodaysOrders() {
  const supabase = getSupabase();
  const { start, end } = getServiceDayWindow();

  return unwrap(
    await supabase
      .from('orders')
      .select('*, order_items(*), customers(*)')
      .gte('created_at', start.toUTC().toISO())
      .lt('created_at', end.toUTC().toISO())
      .order('created_at', { ascending: true }),
    'todaySheet.getTodaysOrders'
  );
}

function buildOrderRow(order) {
  return [
    order.order_code,
    DateTime.fromISO(order.created_at, { zone: SGT }).toFormat('HH:mm'),
    telegramHandle(order.customers),
    order.hall_name_snapshot || '',
    itemsSummary(order.order_items),
    STATUS_LABELS[order.status] || order.status,
    paymentStatusFor(order),
  ];
}

// Still to be handed over: the same set delivery mode treats as active
// (awaiting payment, checking, under review, paid). Served orders are done.
const LEFT_TO_SERVE = new Set(ACTIVE_STATUSES);

function buildItemTotals(orders, include = order => !EXCLUDED_FROM_TOTALS.has(order.status)) {
  const totals = new Map();

  for (const order of orders) {
    if (!include(order)) {
      continue;
    }

    for (const item of order.order_items || []) {
      const key = item.item_name_snapshot;
      totals.set(key, (totals.get(key) || 0) + item.quantity);
    }
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Item quantities from orders not yet served (see LEFT_TO_SERVE). */
function buildLeftToServeTotals(orders) {
  return buildItemTotals(orders, order => LEFT_TO_SERVE.has(order.status));
}

/**
 * Starting stock / remaining / sold per menu item.
 *
 * Sold is counted from tonight's orders - the same orders "Total Ordered
 * Today" counts - so this table always tallies with the order list above it.
 * Remaining is the live stock, and starting is the two added together: what
 * there was before tonight's orders took their share, including any stock an
 * admin added or removed during the night.
 *
 * Matched on the menu item id each order line recorded, so a renamed item
 * still lines up. Something sold tonight that has since been deleted from the
 * menu is listed at the end with nothing left.
 */
function buildStockRows(menuItems, orders) {
  const soldById = new Map();
  const soldNames = new Map();

  for (const order of orders) {
    if (EXCLUDED_FROM_TOTALS.has(order.status)) {
      continue;
    }
    for (const line of order.order_items || []) {
      const id = Number(line.food_sheet_row_id);
      soldById.set(id, (soldById.get(id) || 0) + line.quantity);
      if (!soldNames.has(id)) {
        soldNames.set(id, line.item_name_snapshot);
      }
    }
  }

  const rows = menuItems.map(item => {
    const sold = soldById.get(Number(item.id)) || 0;
    const remaining = Number(item.stock) || 0;
    return [item.name, remaining + sold, remaining, sold];
  });

  const onMenu = new Set(menuItems.map(item => Number(item.id)));
  for (const [id, sold] of soldById) {
    if (!onMenu.has(id)) {
      rows.push([`${soldNames.get(id)} (removed from menu)`, sold, 0, sold]);
    }
  }

  return rows;
}

/** Bold the header rows and reset stray formatting left by a bigger day. */
async function applyFormatting(sheetId, boldRowIndexes) {
  const boldRange = (startRowIndex, endRowIndex) => ({
    repeatCell: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex: 0, endColumnIndex: COLUMN_COUNT },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat',
    },
  });

  const requests = [
    // Reset formatting over a generous range first, so a bold label from a
    // busier day doesn't linger on what's now a plain row.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: COLUMN_COUNT },
        cell: { userEnteredFormat: {} },
        fields: 'userEnteredFormat',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    boldRange(0, 1), // column headers
    // Section titles and their "Item" / "Qty" rows.
    ...boldRowIndexes.map(index => boldRange(index, index + 1)),
  ];

  await googleSheets.batchUpdateSpreadsheet(requests);
}

function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Rebuild the whole Today's Orders tab: every order placed today, and a
 * totals-per-item table underneath. Called after any order change and once a
 * minute from the scheduler, so it also self-resets at midnight without any
 * special-cased job.
 */
async function refreshTodaySheet() {
  // Every refresh is 3 Sheets writes and the whole tab is rebuilt, but the
  // Sheets write quota (60/min for our service account) is shared with stock
  // deduction at checkout. Rewriting after every order change used up the quota
  // the customers needed, so at most one refresh runs per interval.
  //
  // The lease is deliberately never released: it expiring is what opens the
  // next slot. It is atomic across serverless instances, and also stops two of
  // them clearing and rewriting the tab at the same moment. A change that lands
  // inside the window is picked up by the next drain, or at the latest by the
  // once-a-minute scheduler.
  const holder = await stateStore.acquireLock(
    stateStore.LOCKS.todaySheetRefresh(),
    { leaseMs: REFRESH_MIN_INTERVAL_MS }
  );

  if (!holder) {
    return { throttled: true };
  }

  const orders = await getTodaysOrders();
  const totals = buildItemTotals(orders);
  const leftToServe = buildLeftToServeTotals(orders);

  const rows = [HEADERS, ...orders.map(buildOrderRow)];
  const boldRowIndexes = [];

  const pushSection = (title, entries, emptyText) => {
    rows.push([]);
    boldRowIndexes.push(rows.length);
    rows.push([title]);
    boldRowIndexes.push(rows.length);
    rows.push(['Item', 'Qty']);
    if (entries.length) {
      entries.forEach(([name, qty]) => rows.push([name, qty]));
    } else {
      rows.push([emptyText]);
    }
  };

  pushSection('Total Ordered Today', totals, 'No orders yet');
  pushSection('Left To Serve', leftToServe, 'Nothing left to serve');

  // The stock table is extra: if the menu can't be read, the order tables
  // above are still written rather than the whole refresh failing.
  let menuItems = null;
  try {
    menuItems = await menuStore.getFoodItemsOrThrow();
  } catch (error) {
    log('warn', 'today_sheet_menu_read_failed', { error: error.message });
  }

  rows.push([]);
  boldRowIndexes.push(rows.length);
  rows.push(['Stock']);
  boldRowIndexes.push(rows.length);
  rows.push(['Item', 'Starting Stock', 'Remaining', 'Sold']);
  if (menuItems) {
    buildStockRows(menuItems, orders).forEach(row => rows.push(row));
  } else {
    rows.push(['Could not read the menu - retrying next minute']);
  }

  // The tick calls this every minute, and most minutes nothing has changed. The
  // service-day rollover needs no special case: the order list changes then, so
  // the hash does too.
  const hash = hashRows(rows);
  const last = await stateStore.get(stateStore.KEYS.todaySheetSync(), null);

  if (last && last.hash === hash && Date.now() - last.writtenAt < FORCE_REWRITE_MS) {
    return { skipped: 'unchanged', orders: orders.length, items: totals.length };
  }

  if (!cachedSheetId) {
    cachedSheetId = await googleSheets.ensureSheetTab(SHEET_TITLE);
  }

  // Clear first so a shorter day doesn't leave a longer day's rows dangling
  // underneath the new content.
  const cleared = await googleSheets.clearRange(`${QUOTED_SHEET}!A1:H1000`);
  const written = await googleSheets.writeToSheet(`${QUOTED_SHEET}!A1`, rows);

  // Both helpers return false rather than throw. A failed write must not be
  // recorded as done, or the tab would stay wrong until something changed.
  if (!cleared || !written) {
    log('warn', 'today_sheet_write_failed', { cleared, written });
    return { written: false };
  }

  try {
    await applyFormatting(cachedSheetId, boldRowIndexes);
  } catch (error) {
    // Cosmetic only - the data write above already succeeded.
    log('warn', 'today_sheet_formatting_failed', { error: error.message });
  }

  await stateStore.set(stateStore.KEYS.todaySheetSync(), { hash, writtenAt: Date.now() });

  return { orders: orders.length, items: totals.length };
}

module.exports = {
  SHEET_TITLE,
  HEADERS,
  buildOrderRow,
  buildItemTotals,
  buildLeftToServeTotals,
  buildStockRows,
  getTodaysOrders,
  getServiceDayWindow,
  refreshTodaySheet,
};
