const repo = require('./orderRepository');
const menuStore = require('./menuStore');
const { getSupabase, unwrap } = require('./supabase');
const { getHalls } = require('./googleSheets');
const { toCents } = require('../utils/money');

/**
 * Fake orders for load / flow testing, from Settings > Spam Orders.
 *
 * They are real rows (real stock deducted, real sheet-mirror rows), so the
 * rest of the bot treats them like any other PAID order. What marks them as
 * fake is the customer: every one belongs to a reserved negative Telegram id
 * (SPAM_ID_BASE - 1 ... SPAM_ID_BASE - POOL_SIZE), which no real user can have.
 * deleteSpamOrders finds them by that range.
 */

const SPAM_ID_BASE = -9_000_000_000;
const POOL_SIZE = 40;
const CONCURRENCY = 5;
const MAX_ITEMS_PER_ORDER = 3;
const MAX_QUANTITY_PER_ITEM = 2;

const FIRST_NAMES = [
  'Alex', 'Bryan', 'Chloe', 'Daniel', 'Elaine', 'Farah', 'Gabriel', 'Hui Min', 'Ivan', 'Jia Wei',
  'Kai', 'Lena', 'Marcus', 'Nadia', 'Owen', 'Priya', 'Qian', 'Ryan', 'Sofia', 'Tan',
  'Uma', 'Vince', 'Wen', 'Xavier', 'Yuki', 'Zara', 'Aisha', 'Ben', 'Cheryl', 'Dev',
  'Eunice', 'Felix', 'Grace', 'Hafiz', 'Isabel', 'Jun', 'Kelvin', 'Lydia', 'Mei', 'Nathan',
];

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = list => list[Math.floor(Math.random() * list.length)];

let running = false;

function fakeCustomerId(index) {
  return SPAM_ID_BASE - (index + 1);
}

/**
 * Create `count` PAID orders spread evenly across every hall, with random
 * items from the current menu, deducting stock as real checkouts do.
 *
 * Stops early (and says so) if the menu runs out of stock.
 * Resolves to { created, requested, halls, perHall, stockChanges, stoppedReason }.
 */
async function createSpamOrders(count) {
  if (running) {
    throw new Error('Spam orders are already being created - wait for it to finish.');
  }

  running = true;

  try {
    const halls = await getHalls({ fresh: true });
    if (!halls.length) throw new Error('There are no halls to spread orders across.');

    const startItems = await menuStore.getFoodItemsOrThrow();
    if (!startItems.some(item => (item.stock || 0) > 0)) throw new Error('Nothing on the menu is in stock.');

    const stock = new Map(startItems.map(item => [item.id, item.stock || 0]));
    const perHall = new Map(halls.map(hall => [hall.name, 0]));
    const customers = new Map();
    let nextOrder = 0;
    let created = 0;
    let outOfStock = false;

    async function customerFor(index) {
      if (!customers.has(index)) {
        customers.set(index, repo.upsertCustomer({
          telegramUserId: fakeCustomerId(index),
          username: `spam_user_${index + 1}`,
          firstName: FIRST_NAMES[index % FIRST_NAMES.length],
          lastName: null,
        }));
      }
      return customers.get(index);
    }

    async function placeOrder(orderIndex) {
      const hall = halls[orderIndex % halls.length];
      const inStock = startItems.filter(item => (stock.get(item.id) || 0) > 0);

      if (!inStock.length) {
        outOfStock = true;
        return;
      }

      // 1-3 distinct items, each 1-2, never more than is left. Stock is claimed
      // here, before the await, so concurrent workers cannot both take the last one.
      const chosen = [...inStock].sort(() => Math.random() - 0.5)
        .slice(0, randomInt(1, Math.min(MAX_ITEMS_PER_ORDER, inStock.length)));
      const entries = chosen.map(item => ({
        item,
        quantity: Math.min(randomInt(1, MAX_QUANTITY_PER_ITEM), stock.get(item.id)),
      }));
      for (const { item, quantity } of entries) stock.set(item.id, stock.get(item.id) - quantity);

      const giveBack = () => {
        for (const { item, quantity } of entries) stock.set(item.id, stock.get(item.id) + quantity);
      };

      const deducted = await menuStore.deductStock(entries.map(({ item, quantity }) => ({ foodId: item.id, quantity })));

      if (!deducted.success) {
        // Real stock was lower than the menu read at the start (a real order, say).
        giveBack();
        outOfStock = true;
        return;
      }

      const orderItems = entries.map(({ item, quantity }) => ({
        foodSheetRowId: item.id,
        name: item.name,
        unitPriceCents: toCents(item.price) || 0,
        quantity,
      }));
      const totalCents = orderItems.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

      try {
        const customerIndex = orderIndex % POOL_SIZE;
        const customer = await customerFor(customerIndex);

        const order = await repo.createOrder({
          customerId: customer.id,
          telegramChatId: fakeCustomerId(customerIndex),
          hallSheetRowId: hall.id,
          hallName: hall.name,
          items: orderItems,
          totalCents,
          requiresAdminApproval: false,
        });

        await repo.transitionOrderStatus(
          order.id, repo.STATUS.AWAITING_PAYMENT, repo.STATUS.PAID, 'system', 'Spam order'
        );

        created += 1;
        perHall.set(hall.name, perHall.get(hall.name) + 1);
      } catch (error) {
        // Put back what was taken for an order that never got saved.
        await menuStore.restoreStock(orderItems.map(item => ({ id: item.foodSheetRowId, quantity: item.quantity })));
        giveBack();
        throw error;
      }
    }

    async function worker() {
      while (!outOfStock) {
        const orderIndex = nextOrder;
        nextOrder += 1;
        if (orderIndex >= count) return;
        await placeOrder(orderIndex);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));

    const endItems = await menuStore.getFoodItemsOrThrow();
    const stockChanges = startItems.map(before => {
      const after = endItems.find(item => item.id === before.id);
      return { name: before.name, oldStock: before.stock || 0, newStock: after ? (after.stock || 0) : 0 };
    }).filter(change => change.oldStock !== change.newStock);

    return {
      created,
      requested: count,
      perHall: halls.map(hall => ({ name: hall.shortName || hall.name, count: perHall.get(hall.name) })),
      stockChanges,
      stoppedReason: created < count ? 'out of stock' : null,
    };
  } finally {
    running = false;
  }
}

/**
 * Delete every spam order and the fake customers behind them. Stock is NOT put
 * back (the next round reset / stock edit does that), and rows already mirrored
 * to the Google Sheet are left there.
 */
async function deleteSpamOrders() {
  const supabase = getSupabase();

  const customers = unwrap(
    await supabase
      .from('customers')
      .select('id')
      .lte('telegram_user_id', SPAM_ID_BASE)
      .gt('telegram_user_id', SPAM_ID_BASE - 1_000_000),
    'spamOrders.findCustomers'
  );

  const ids = customers.map(customer => customer.id);
  let deleted = 0;

  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    const rows = unwrap(
      await supabase.from('orders').delete().in('customer_id', chunk).select('id'),
      'spamOrders.deleteOrders'
    );
    deleted += rows.length;
  }

  for (let start = 0; start < ids.length; start += 50) {
    unwrap(
      await supabase.from('customers').delete().in('id', ids.slice(start, start + 50)),
      'spamOrders.deleteCustomers'
    );
  }

  return { deleted };
}

module.exports = { createSpamOrders, deleteSpamOrders, SPAM_ID_BASE };
