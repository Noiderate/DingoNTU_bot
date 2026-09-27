const { DateTime } = require('luxon');
const {
  writeToSheet,
  clearRange,
  ensureSheetTab,
  batchUpdateSpreadsheet,
} = require('./googleSheets');
const { getSupabase, unwrap } = require('./supabase');
const { STATUS_LABELS, paymentStatusFor } = require('./sheetMirror');
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

function buildItemTotals(orders) {
  const totals = new Map();

  for (const order of orders) {
    if (EXCLUDED_FROM_TOTALS.has(order.status)) {
      continue;
    }

    for (const item of order.order_items || []) {
      const key = item.item_name_snapshot;
      totals.set(key, (totals.get(key) || 0) + item.quantity);
    }
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Bold the header rows and reset stray formatting left by a bigger day. */
async function applyFormatting(sheetId, { totalsHeaderRowIndex, totalsColumnHeaderRowIndex }) {
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
    boldRange(totalsHeaderRowIndex, totalsHeaderRowIndex + 1), // "Total Ordered Today"
    boldRange(totalsColumnHeaderRowIndex, totalsColumnHeaderRowIndex + 1), // "Item" / "Qty"
  ];

  await batchUpdateSpreadsheet(requests);
}

/**
 * Rebuild the whole Today's Orders tab: every order placed today, and a
 * totals-per-item table underneath. Called after any order change and once a
 * minute from the scheduler, so it also self-resets at midnight without any
 * special-cased job.
 */
async function refreshTodaySheet() {
  if (!cachedSheetId) {
    cachedSheetId = await ensureSheetTab(SHEET_TITLE);
  }

  const orders = await getTodaysOrders();
  const totals = buildItemTotals(orders);

  const rows = [HEADERS, ...orders.map(buildOrderRow)];

  rows.push([]);
  const totalsHeaderRowIndex = rows.length;
  rows.push(['Total Ordered Today']);
  const totalsColumnHeaderRowIndex = rows.length;
  rows.push(['Item', 'Qty']);
  totals.forEach(([name, qty]) => rows.push([name, qty]));

  // Clear first so a shorter day doesn't leave a longer day's rows dangling
  // underneath the new content.
  await clearRange(`${QUOTED_SHEET}!A1:H1000`);
  await writeToSheet(`${QUOTED_SHEET}!A1`, rows);

  try {
    await applyFormatting(cachedSheetId, { totalsHeaderRowIndex, totalsColumnHeaderRowIndex });
  } catch (error) {
    // Cosmetic only - the data write above already succeeded.
    log('warn', 'today_sheet_formatting_failed', { error: error.message });
  }

  return { orders: orders.length, items: totals.length };
}

module.exports = {
  SHEET_TITLE,
  HEADERS,
  buildOrderRow,
  buildItemTotals,
  getServiceDayWindow,
  refreshTodaySheet,
};
