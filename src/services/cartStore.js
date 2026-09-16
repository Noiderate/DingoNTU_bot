const { getSupabase, unwrap } = require('./supabase');

/**
 * Durable replacement for the in-memory userHalls / userCarts objects.
 *
 * A cart living in module memory meant that on Vercel a customer could tap two
 * items and have the second land on a different instance that had never heard
 * of the first.
 *
 * items maps a FoodAndStock sheet row number to a quantity: { "2": 3, "5": 1 }.
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
  return saveCart(telegramUserId, {
    hallSheetRowId: hall.id,
    hallName: hall.name,
    items: {},
  });
}

/** Add one of an item. Returns the updated cart. */
async function addItem(telegramUserId, foodRowId, quantity = 1) {
  const cart = await getCart(telegramUserId);
  const key = String(foodRowId);

  cart.items[key] = (cart.items[key] || 0) + quantity;

  return saveCart(telegramUserId, cart);
}

async function clearItems(telegramUserId) {
  const cart = await getCart(telegramUserId);
  cart.items = {};
  return saveCart(telegramUserId, cart);
}

async function clearCart(telegramUserId) {
  const supabase = getSupabase();

  unwrap(
    await supabase.from('carts').delete().eq('telegram_user_id', telegramUserId),
    'cartStore.clearCart'
  );
}

/** Entries with a positive quantity, as [foodRowId, quantity] number pairs. */
function cartEntries(cart) {
  return Object.entries(cart.items || {})
    .map(([key, quantity]) => [Number(key), Number(quantity)])
    .filter(([, quantity]) => quantity > 0);
}

function isEmpty(cart) {
  return cartEntries(cart).length === 0;
}

module.exports = {
  CART_TTL_MS,
  emptyCart,
  getCart,
  saveCart,
  setHall,
  addItem,
  clearItems,
  clearCart,
  cartEntries,
  isEmpty,
};
