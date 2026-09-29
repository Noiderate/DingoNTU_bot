const { getSupabase, unwrap } = require('./supabase');
const stateStore = require('./stateStore');
const { formatCents } = require('../utils/money');
const { config } = require('../config');
const { log } = require('../utils/logger');

/**
 * Fun numbers for the admin Stats tab.
 *
 * Costs two small Supabase reads per open of the tab and nothing else: no
 * Google Sheets and no extra Telegram calls. The orders query is capped at the
 * most recent orders so it stays cheap however long the bot has been running.
 */

const MAX_ORDERS = 1000;
const COUNTED_STATUSES = ['paid', 'served'];

function topEntry(counts) {
  let best = null;

  for (const [name, value] of counts) {
    if (!best || value > best.value) {
      best = { name, value };
    }
  }

  return best;
}

function bump(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sgtHour(iso) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: config.timezone,
  }).format(new Date(iso));

  return Number(hour);
}

// e.g. "Tue, 16 Sep". Also the grouping key, so it needs no separate date maths.
function sgtDayLabel(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: config.timezone,
  }).format(new Date(iso));
}

function formatHour(hour) {
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}${suffix}`;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Pure: turns order rows into the stats. Kept separate from the query so it
 * can be tested without a database.
 */
function computeStats(orders) {
  const counted = (orders || []).filter(order => COUNTED_STATUSES.includes(order.status));

  const items = new Map();
  const halls = new Map();
  const hours = new Map();
  const days = new Map();
  const customers = new Map();
  const customerNames = new Map();

  let revenueCents = 0;
  let itemsSold = 0;
  let biggest = null;
  let fastest = null;

  for (const order of counted) {
    revenueCents += order.total_cents || 0;

    bump(halls, order.hall_name_snapshot || 'Unknown');
    bump(hours, sgtHour(order.created_at));
    bump(days, sgtDayLabel(order.created_at));

    const customer = order.customers || {};
    const customerKey = order.customer_id;
    bump(customers, customerKey);
    customerNames.set(customerKey, customer.first_name || customer.telegram_username || 'Someone');

    for (const item of order.order_items || []) {
      bump(items, item.item_name_snapshot, item.quantity);
      itemsSold += item.quantity;
    }

    if (!biggest || order.total_cents > biggest.total_cents) {
      biggest = order;
    }

    if (order.paid_at) {
      const took = new Date(order.paid_at) - new Date(order.created_at);

      if (took >= 0 && (fastest === null || took < fastest)) {
        fastest = took;
      }
    }
  }

  const topCustomer = topEntry(customers);
  const repeat = [...customers.values()].filter(count => count > 1).length;

  return {
    orders: counted.length,
    revenueCents,
    itemsSold,
    averageCents: counted.length ? Math.round(revenueCents / counted.length) : 0,
    topItem: topEntry(items),
    topHall: topEntry(halls),
    busiestHour: topEntry(hours),
    busiestDay: topEntry(days),
    topCustomer: topCustomer && { name: customerNames.get(topCustomer.name), value: topCustomer.value },
    uniqueCustomers: customers.size,
    repeatCustomers: repeat,
    biggestCents: biggest ? biggest.total_cents : 0,
    fastestPayMs: fastest,
  };
}

/**
 * Bump the running "sold out" tally. Best-effort: a stats write must never get
 * in the way of the sold-out announcement itself. Not atomic, which is fine
 * for something that happens a handful of times a night.
 */
async function recordSoldOut(soldOutItems) {
  if (!soldOutItems || !soldOutItems.length) {
    return;
  }

  try {
    await stateStore.update(stateStore.KEYS.soldOutStats(), current => {
      const tally = { total: 0, items: {}, ...(current || {}) };
      tally.items = { ...tally.items };

      for (const item of soldOutItems) {
        tally.total += 1;
        tally.items[item.name] = (tally.items[item.name] || 0) + 1;
      }

      return tally;
    });
  } catch (error) {
    log('warn', 'sold_out_stats_failed', { error: error.message });
  }
}

/** { total, top: { name, value } | null } from the stored tally. */
function summariseSoldOut(tally) {
  const total = tally && tally.total ? tally.total : 0;
  const top = topEntry(new Map(Object.entries((tally && tally.items) || {})));

  return { total, top };
}

async function fetchStats() {
  const supabase = getSupabase();

  const [rows, tally] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'status, total_cents, created_at, paid_at, hall_name_snapshot, customer_id, '
        + 'customers(first_name, telegram_username), order_items(item_name_snapshot, quantity)'
      )
      .in('status', COUNTED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(MAX_ORDERS)
      .then(result => unwrap(result, 'statsService.fetchStats')),
    // The sold-out tally is a bonus: losing it must not lose the rest.
    stateStore.get(stateStore.KEYS.soldOutStats()).catch(() => null),
  ]);

  return {
    stats: { ...computeStats(rows), soldOut: summariseSoldOut(tally) },
    capped: rows.length >= MAX_ORDERS,
  };
}

/** The extra "fun" lines shown under the admin count. */
function formatFunStats(stats, capped) {
  if (!stats.orders) {
    return '\n\nNo paid orders yet - the fun stats start once the first one comes in! 🐕';
  }

  const lines = [
    `🧾 Paid orders: ${stats.orders}${capped ? ` (latest ${MAX_ORDERS})` : ''}`,
    `💰 Total sales: ${formatCents(stats.revenueCents)}`,
    `🍽️ Items sold: ${stats.itemsSold}`,
    `📏 Average order: ${formatCents(stats.averageCents)}`,
    `🏆 Biggest order: ${formatCents(stats.biggestCents)}`,
  ];

  if (stats.topItem) lines.push(`🔥 Favourite item: ${stats.topItem.name} (x${stats.topItem.value})`);
  if (stats.topHall) lines.push(`🏢 Top hall: ${stats.topHall.name} (${stats.topHall.value} orders)`);
  if (stats.busiestDay) lines.push(`📅 Busiest day: ${stats.busiestDay.name} (${stats.busiestDay.value} orders)`);
  if (stats.busiestHour) lines.push(`⏰ Busiest hour: ${formatHour(stats.busiestHour.name)} (${stats.busiestHour.value} orders)`);
  if (stats.topCustomer) lines.push(`👑 Top customer: ${stats.topCustomer.name} (${stats.topCustomer.value} orders)`);

  lines.push(`👥 Customers: ${stats.uniqueCustomers} (${stats.repeatCustomers} came back for more)`);

  if (stats.fastestPayMs !== null) {
    lines.push(`⚡ Fastest payment: ${formatDuration(stats.fastestPayMs)}`);
  }

  return `\n\n${lines.join('\n')}${formatSoldOut(stats.soldOut)}`;
}

function formatSoldOut(soldOut) {
  if (!soldOut || !soldOut.total) {
    return '\n🚫 Sold-out moments: none yet';
  }

  const usual = soldOut.top ? ` - ${soldOut.top.name} goes fastest (${soldOut.top.value}x)` : '';
  return `\n🚫 Sold-out moments: ${soldOut.total}${usual}`;
}

module.exports = {
  computeStats,
  fetchStats,
  formatFunStats,
  recordSoldOut,
  summariseSoldOut,
  MAX_ORDERS,
};
