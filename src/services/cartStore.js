const { getSupabase, unwrap } = require('./supabase');
const stateStore = require('./stateStore');

/**
 * Durable replacement for the in-memory userHalls / userCarts objects.
 *
 * A cart living in module memory meant that on Vercel a customer could tap two
 * items and have the second land on a different instance that had never heard
 * of the first.
 *
 * items maps a FoodAndStock sheet row number to the quantity ordered AND the
 * item's name as it read when it was added:
 *
 *   { "2": { "quantity": 3, "name": "Chicken Rice" } }
 *
 * The name is stored because a row number is not a stable identifier. An item's
 * id IS its spreadsheet row, so if staff delete or sort rows mid-session,
 * row 2 silently becomes a different food and the customer would be charged for
 * something they never chose. Checking the name at checkout turns that into a
 * clear error instead of a wrong charge. See MAINTENANCE.md "Row-number-as-ID".
 */

// Long enough to cover a preorder run, short enough that abandoned carts do not
// accumulate. Evaluated lazily on read, never by a timer.
const CART_TTL_MS = 6 * 60 * 60 * 1000;

function emptyCart() {
  return { hallSheetRowId: null, hallName: null, items: {} };
}

function toCart(row) {
  if (!row) {
    return emptyCart();
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return emptyCart();
  }

  return {
    hallSheetRowId: row.hall_sheet_row_id,
    hallName: row.hall_name,
    items: row.items || {},
  };
}

/**
 * Every cart change is read-modify-write on one row, and each Telegram tap is a
 * separate serverless invocation, so rapid taps run in parallel and the last
 * writer wins - dropping the others' items. Serialising per customer fixes that
 * without slowing anyone else down.
 */
function withCartLock(telegramUserId, task) {
  return stateStore.withLock(stateStore.LOCKS.cart(telegramUserId), task, {
    leaseMs: 10000,
    maxAttempts: 30,
    baseDelayMs: 50,
    maxDelayMs: 400,
  });
}

async function getCart(telegramUserId) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('carts')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .limit(1),
    'cartStore.getCart'
  );

  return toCart(rows[0]);
}

async function saveCart(telegramUserId, cart) {
  const supabase = getSupabase();

  unwrap(
    await supabase.from('carts').upsert(
      {
        telegram_user_id: telegramUserId,
        hall_sheet_row_id: cart.hallSheetRowId,
        hall_name: cart.hallName,
        items: cart.items || {},
        expires_at: new Date(Date.now() + CART_TTL_MS).toISOString(),
      },
      { onConflict: 'telegram_user_id' }
    ),
    'cartStore.saveCart'
  );

  return cart;
}

async function setHall(telegramUserId, hall) {
  return withCartLock(telegramUserId, () => saveCart(telegramUserId, {
    hallSheetRowId: hall.id,
    hallName: hall.name,
    items: {},
  }));
}

/**
 * Add one of an item, recording the name it had at the time.
 */
async function addItem(telegramUserId, foodRowId, name, quantity = 1) {
  return withCartLock(telegramUserId, async () => {
    const cart = await getCart(telegramUserId);
    const key = String(foodRowId);
    const existing = cart.items[key];

    cart.items[key] = {
      quantity: (existing ? existing.quantity : 0) + quantity,
      // Always the latest reading, so the snapshot matches what the customer was
      // actually shown on the screen they tapped.
      name,
    };

    return saveCart(telegramUserId, cart);
  });
}

/** Quantity of one item currently in the cart. */
function getQuantity(cart, foodRowId) {
  const entry = cart.items && cart.items[String(foodRowId)];
  return entry ? Number(entry.quantity) || 0 : 0;
}

async function clearItems(telegramUserId) {
  return withCartLock(telegramUserId, async () => {
    const cart = await getCart(telegramUserId);
    cart.items = {};
    return saveCart(telegramUserId, cart);
  });
}

/**
 * Every open cart currently pointed at a hall - the customers who picked it
 * but haven't confirmed an order yet, i.e. don't have a real order in
 * Supabase to protect. Used to notify and clear out anyone caught mid-browse
 * when that hall's ordering window closes.
 */
async function getCartsForHall(hallName) {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const rows = unwrap(
    await supabase
      .from('carts')
      .select('telegram_user_id')
      .eq('hall_name', hallName)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    'cartStore.getCartsForHall'
  );

  return rows.map(row => row.telegram_user_id);
}

async function clearCart(telegramUserId) {
  const supabase = getSupabase();

  await withCartLock(telegramUserId, async () => {
    unwrap(
      await supabase.from('carts').delete().eq('telegram_user_id', telegramUserId),
      'cartStore.clearCart'
    );
  });
}

/** Entries with a positive quantity, as { foodId, quantity, name }. */
function cartEntries(cart) {
  return Object.entries(cart.items || {})
    .map(([key, entry]) => ({
      foodId: Number(key),
      quantity: entry ? Number(entry.quantity) || 0 : 0,
      name: entry ? entry.name || null : null,
    }))
    .filter(entry => entry.quantity > 0);
}

function isEmpty(cart) {
  return cartEntries(cart).length === 0;
}

/**
 * Check that every cart entry still points at the food the customer chose.
 *
 * Returns the first mismatch, or null when the cart is still valid.
 *
 * This is the guard against spreadsheet rows shifting underneath an open cart.
 * Without it, deleting a row while someone is ordering would charge them for
 * whatever food moved into that row - the one failure mode here that actually
 * costs a customer money.
 *
 * Pure, so it can be tested without a database.
 */
function findCartMismatch(entries, liveItems) {
  for (const entry of entries) {
    const live = liveItems.find(item => item.id === entry.foodId);

    if (!live) {
      return { foodId: entry.foodId, expected: entry.name, actual: null };
    }

    if (entry.name && live.name !== entry.name) {
      return { foodId: entry.foodId, expected: entry.name, actual: live.name };
    }
  }

  return null;
}

module.exports = {
  CART_TTL_MS,
  emptyCart,
  getCart,
  saveCart,
  setHall,
  addItem,
  getQuantity,
  clearItems,
  clearCart,
  getCartsForHall,
  cartEntries,
  isEmpty,
  findCartMismatch,
};

