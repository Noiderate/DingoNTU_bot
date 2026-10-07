const supabaseService = require('./supabase');
const { toCents } = require('../utils/money');

const { unwrap, isUniqueViolation } = supabaseService;

// Looked up on the module at call time, not destructured once, so a test can
// substitute the client (see test/menuStore.test.js).
const getSupabase = () => supabaseService.getSupabase();

/**
 * The menu: food, price and stock, kept in the menu_items table.
 *
 * It used to be the FoodAndStock sheet, which capped how many customers could
 * order at once (Google allows 60 reads and 60 writes a minute for our service
 * account) and forced every checkout through one global lock. The sheet is now a
 * read-only mirror written from here - see menuSheetSync.js - and the menu is
 * edited through the bot.
 *
 * The shapes callers use are unchanged: an item is { id, name, price, stock },
 * where price is a decimal number and id is now a real database id rather than a
 * sheet row number, so it never shifts when other items are added or removed.
 */

const MENU_UNAVAILABLE = 'MENU_UNAVAILABLE';

/**
 * Run a database call, tagging any failure with code MENU_UNAVAILABLE so the
 * handlers can tell "the database is having a moment" (tell the customer to
 * retry, keep their cart) apart from a real bug - the same job
 * googleSheets.isSheetsUnavailable does for the halls.
 */
async function guarded(context, task) {
  try {
    return await task();
  } catch (error) {
    const unavailable = new Error(`Menu ${context} failed: ${error.message}`);
    unavailable.code = MENU_UNAVAILABLE;
    unavailable.cause = error;
    throw unavailable;
  }
}

function toItem(row) {
  return {
    id: Number(row.id),
    name: row.name,
    price: row.price_cents / 100,
    stock: row.stock,
    // What "Reset Halls and Orders" restores stock to; null until an admin has
    // set stock by hand.
    baselineStock: row.baseline_stock === null || row.baseline_stock === undefined
      ? null
      : row.baseline_stock,
  };
}

/**
 * Every menu item, in the order they were added.
 *
 * Throws (with code MENU_UNAVAILABLE) on a read failure, rather than returning
 * [] - an empty menu and a failed read must not look alike anywhere "empty"
 * would do damage: the public post reading "no food available", or a customer's
 * cart cleared as "the menu changed".
 */
async function getFoodItemsOrThrow() {
  const rows = await guarded('read', async () => unwrap(
    await getSupabase().from('menu_items').select('*').order('id', { ascending: true }),
    'menuStore.getFoodItems'
  ));

  return rows.map(toItem);
}

/** Like getFoodItemsOrThrow, but [] on failure - for screens where that is fine. */
async function getFoodItems() {
  try {
    return await getFoodItemsOrThrow();
  } catch (error) {
    console.error('Error reading menu:', error.message);
    return [];
  }
}

function isMenuUnavailable(error) {
  return Boolean(error) && error.code === MENU_UNAVAILABLE;
}

/** Add an item with no stock. Never throws; returns { success, message }. */
async function addFoodItem(name, price) {
  const cleanName = String(name || '').trim();
  const priceCents = toCents(price);

  if (!cleanName) {
    return { success: false, message: '✗ The food name cannot be empty.' };
  }

  if (priceCents === null) {
    return { success: false, message: '✗ That is not a valid price.' };
  }

  try {
    const result = await getSupabase()
      .from('menu_items')
      .insert({ name: cleanName, price_cents: priceCents })
      .select('id');

    if (result.error) {
      if (isUniqueViolation(result.error)) {
        return { success: false, message: `✗ "${cleanName}" is already on the menu.` };
      }
      throw new Error(result.error.message);
    }

    return { success: true, message: `✓ Food item "${cleanName}" ($${price}) added successfully.` };
  } catch (error) {
    console.error('Error adding food item:', error.message);
    return { success: false, message: `✗ Failed to add food item: ${error.message}` };
  }
}

/** Remove an item. Past orders keep their own name and price snapshots. */
async function deleteFoodItem(id) {
  try {
    const rows = unwrap(
      await getSupabase().from('menu_items').delete().eq('id', id).select('id'),
      'menuStore.deleteFoodItem'
    );

    if (!rows.length) {
      return { success: false, message: '✗ That food item no longer exists.' };
    }

    return { success: true, message: '✓ Food item deleted successfully.' };
  } catch (error) {
    console.error('Error deleting food item:', error.message);
    return { success: false, message: `✗ Failed to delete food item: ${error.message}` };
  }
}

/**
 * Change an item's price. Stock and the reset baseline are untouched.
 *
 * Only affects orders confirmed from now on: an order snapshots its own prices
 * when it is placed, so existing orders keep the price they were made at. A
 * customer already holding the item in a cart is charged the new price at
 * checkout, and is shown the exact amount in the payment instructions.
 *
 * Never throws; returns { success, message }.
 */
async function updateFoodItemPrice(id, price) {
  const priceCents = toCents(price);

  if (priceCents === null) {
    return { success: false, message: '✗ That is not a valid price.' };
  }

  try {
    const rows = unwrap(
      await getSupabase()
        .from('menu_items')
        .update({ price_cents: priceCents })
        .eq('id', id)
        .select('name'),
      'menuStore.updateFoodItemPrice'
    );

    if (!rows.length) {
      return { success: false, message: '✗ That food item no longer exists.' };
    }

    return {
      success: true,
      message: `✓ Price updated for "${rows[0].name}" to $${(priceCents / 100).toFixed(2)}.`,
    };
  } catch (error) {
    console.error('Error updating food price:', error.message);
    return { success: false, message: `✗ Failed to update price: ${error.message}` };
  }
}

/**
 * An admin setting one item's stock by hand.
 *
 * This is the one write that also moves the item's baseline - what "Reset Halls
 * and Orders" puts stock back to. Order-driven deduct/restore never does, so the
 * baseline stays the number the admin configured rather than wherever the night
 * left it.
 */
async function updateFoodItemStock(id, newStock) {
  try {
    const rows = unwrap(
      await getSupabase()
        .from('menu_items')
        .update({ stock: newStock, baseline_stock: newStock })
        .eq('id', id)
        .select('name'),
      'menuStore.updateFoodItemStock'
    );

    if (!rows.length) {
      return { success: false, message: '✗ That food item no longer exists.' };
    }

    return { success: true, message: `✓ Stock updated for "${rows[0].name}" to ${newStock}.` };
  } catch (error) {
    console.error('Error updating food stock:', error.message);
    return { success: false, message: `✗ Failed to update stock: ${error.message}` };
  }
}

/**
 * Set an item's remaining stock for tonight only. Unlike updateFoodItemStock
 * this leaves the reset baseline alone, so a stage-2 adjustment doesn't carry
 * over to the next round.
 */
async function setRemainingStock(id, newStock) {
  try {
    const rows = unwrap(
      await getSupabase().from('menu_items').update({ stock: newStock }).eq('id', id).select('name'),
      'menuStore.setRemainingStock'
    );

    if (!rows.length) {
      return { success: false, message: '✗ That food item no longer exists.' };
    }

    return { success: true, message: `✓ Stock for "${rows[0].name}" set to ${newStock}.` };
  } catch (error) {
    console.error('Error setting remaining stock:', error.message);
    return { success: false, message: `✗ Failed to update stock: ${error.message}` };
  }
}

/**
 * Deduct stock for a checkout: all items or none, atomically, in the database.
 *
 * entries are { foodId, quantity }. Resolves to
 *   { success: true,  changes: [{ name, oldStock, newStock }] }
 *   { success: false, reason: 'insufficient', name, available }
 *   { success: false, reason: 'missing' }
 * and throws (MENU_UNAVAILABLE) only when the database itself fails, in which
 * case nothing was deducted.
 */
async function deductStock(entries) {
  const items = entries.map(({ foodId, quantity }) => ({ id: foodId, quantity }));

  const result = await guarded('stock deduction', async () => unwrap(
    await getSupabase().rpc('deduct_menu_stock', { p_items: items }),
    'menuStore.deductStock'
  ));

  if (!result.ok) {
    return {
      success: false,
      reason: result.reason,
      name: result.name || null,
      available: result.available === undefined ? null : Number(result.available),
    };
  }

  return {
    success: true,
    changes: (result.changes || []).map(change => ({
      name: change.name,
      oldStock: Number(change.old_stock),
      newStock: Number(change.new_stock),
    })),
  };
}

/**
 * Put stock back after a rejected, expired or failed order.
 *
 * entries are { id, quantity }. Never throws: { success, message } instead, so
 * a failed restock can be reported to the admins rather than lost.
 */
async function restoreStock(entries) {
  try {
    const result = unwrap(
      await getSupabase().rpc('restore_menu_stock', {
        p_items: entries.map(({ id, quantity }) => ({ id, quantity })),
      }),
      'menuStore.restoreStock'
    );

    if (Number(result.updated) < new Set(entries.map(entry => entry.id)).size) {
      return { success: false, message: 'Some of those items are no longer on the menu' };
    }

    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * "Reset Halls and Orders": put every item that has a baseline back to it.
 *
 * Returns the items that changed, and the names of items that have no baseline
 * yet (an admin has never set their stock by hand) and were left alone.
 */
async function restoreStockBaselines() {
  const changes = await guarded('baseline reset', async () => unwrap(
    await getSupabase().rpc('restore_menu_baselines'),
    'menuStore.restoreStockBaselines'
  ));

  const items = await getFoodItemsOrThrow();

  return {
    changes: (changes || []).map(change => ({
      id: Number(change.id),
      name: change.name,
      oldStock: Number(change.old_stock),
      newStock: Number(change.new_stock),
    })),
    noBaselineItems: items.filter(item => item.baselineStock === null).map(item => item.name),
  };
}

module.exports = {
  MENU_UNAVAILABLE,
  isMenuUnavailable,
  getFoodItems,
  getFoodItemsOrThrow,
  addFoodItem,
  deleteFoodItem,
  updateFoodItemPrice,
  updateFoodItemStock,
  setRemainingStock,
  deductStock,
  restoreStock,
  restoreStockBaselines,
};
