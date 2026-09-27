const googleSheets = require('./googleSheets');
const stateStore = require('./stateStore');
const repo = require('./orderRepository');
const orderStore = require('./orderStore');
const { formatCents } = require('../utils/money');
const { log } = require('../utils/logger');

/**
 * Downstream effects of an order decision, shared by every caller.
 *
 * The admin "Accept payment" button and the automatic verifier must do exactly
 * the same things, so both call markOrderPaid rather than each implementing the
 * steps. Duplicating them was how the two paths would quietly diverge - one
 * notifying the customer, the other forgetting to.
 */

const STATUS = repo.STATUS;

/**
 * Return an order's items to the FoodAndStock sheet.
 *
 * Matches on the sheet row id AND name first, falling back to the name alone,
 * because row ids shift whenever staff insert, delete or sort rows in the
 * sheet - see MAINTENANCE.md "Row-number-as-ID". A bare id match could add the
 * stock to whichever food has since moved into that row.
 *
 * Runs under the same lock as checkout: both read the sheet's stock and write
 * back a computed value, so interleaving them would silently lose one side's
 * change (a lost restock, or a lost deduction and an oversell).
 *
 * Never throws; returns { success: false, message } instead.
 */
async function restockOrder(order) {
  if (!order.items || !order.items.length) {
    return { success: true, restocked: 0 };
  }

  try {
    return await stateStore.withLock(stateStore.LOCKS.confirmOrder(), async () => {
      const liveItems = await googleSheets.getFoodItemsOrThrow();
      const updates = [];

      for (const orderedItem of order.items) {
        const liveItem = liveItems.find(item => item.id === orderedItem.id && item.name === orderedItem.name)
          || liveItems.find(item => item.name === orderedItem.name);

        if (!liveItem) {
          return {
            success: false,
            message: `Cannot restore stock for ${orderedItem.name} - it is no longer in the sheet`,
          };
        }

        updates.push({
          rowId: liveItem.id,
          newStock: (liveItem.stock || 0) + orderedItem.quantity,
        });
      }

      const result = await googleSheets.updateFoodItemStocksBatch(updates);

      return result.success
        ? { success: true, restocked: updates.length }
        : { success: false, message: result.message };
    });
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * The order's status has already changed, so a failed restock cannot be
 * retried by re-running the action. Tell the admins exactly what to add back
 * by hand rather than letting the stock silently go missing.
 */
async function alertRestockFailed(bot, order, message) {
  log('error', 'restock_failed', { order_code: order.code, error: message });

  const items = (order.items || []).map(item => `• ${item.name} x${item.quantity}`).join('\n');
  const text = `⚠️ Could not return stock for Order ${order.code} (${message}).\n\n`
    + `Please add these back in the FoodAndStock sheet by hand:\n${items}`;

  for (const adminId of googleSheets.getAdminIds()) {
    await notify(bot, adminId, text);
  }
}

async function notify(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (error) {
    // A customer who blocked the bot must not break the order flow.
    log('warn', 'customer_notify_failed', { error: error.message });
    return false;
  }
}

/**
 * Mark an order paid and run every downstream effect.
 *
 * `fromStatus` is passed explicitly so the update is conditional: if an admin
 * taps Accept at the same moment the verifier auto-approves, exactly one of
 * them transitions the order and the other gets null back.
 */
async function markOrderPaid(bot, order, { fromStatus, actor, actorTelegramId, reason }) {
  // A served order keeps its SERVED status and only gains paid_at - see
  // repo.recordPaymentOnServedOrder for why it must not go back to PAID.
  const updated = fromStatus === STATUS.SERVED
    ? await repo.recordPaymentOnServedOrder(order.id, actor, reason, { actorTelegramId })
    : await repo.transitionOrderStatus(
      order.id,
      fromStatus,
      STATUS.PAID,
      actor,
      reason,
      { actorTelegramId }
    );

  if (!updated) {
    return null;
  }

  const paidOrder = orderStore.toOrder(updated);

  // Only reachable via an admin's manual accept (the automatic verifier
  // always transitions from VERIFYING_PAYMENT) - the order was already
  // served, so "being prepared" would be wrong.
  //
  // This is the customer's ONE confirmation message regardless of who/what
  // approved it - the automatic verifier used to send its own extra, near-
  // duplicate message on top of this one; that's now folded in here instead.
  const message = fromStatus === STATUS.SERVED
    ? `✅ Payment for Order ${paidOrder.code} has been confirmed. Thanks!`
    : `✅ Payment for Order ${paidOrder.code} confirmed - ${formatCents(paidOrder.totalCents)} received.\n\n`
      + `Your order is being prepared. 🍽️`;

  await notify(bot, paidOrder.chatId, message);

  log('info', 'order_paid', {
    order_code: paidOrder.code,
    actor,
    total_cents: paidOrder.totalCents,
  });

  return paidOrder;
}

/**
 * Reject an order, restore its stock and tell the customer.
 *
 * The status transition comes FIRST and stock is only restored if it
 * succeeded. The other way round, losing the transition race (an admin reject
 * landing just as the verifier approves, say) left stock added back for an
 * order that never actually left its old state - phantom stock, and
 * overselling. A restock that fails after the transition is reported to the
 * admins with the exact items to add back (see alertRestockFailed).
 *
 * Returns { success, order, restocked }.
 */
async function rejectOrderAndRestock(bot, order, {
  fromStatus,
  actor,
  actorTelegramId,
  reason,
  customerMessage,
}) {
  const updated = await repo.transitionOrderStatus(
    order.id,
    fromStatus,
    STATUS.REJECTED,
    actor,
    reason,
    { actorTelegramId }
  );

  if (!updated) {
    return { success: false, message: 'Order was already handled by someone else' };
  }

  const rejectedOrder = orderStore.toOrder(updated);

  const restock = await restockOrder(rejectedOrder);

  if (!restock.success) {
    await alertRestockFailed(bot, rejectedOrder, restock.message);
  }

  await notify(
    bot,
    rejectedOrder.chatId,
    customerMessage
      || `❌ Your order ${rejectedOrder.code} was rejected. ${reason || ''}\n\nPlease restart your order by typing /start`
  );

  log('info', 'order_rejected', { order_code: rejectedOrder.code, actor, reason });

  return { success: true, order: rejectedOrder, restocked: restock.success };
}

/**
 * Close out an order still active when the admin resets halls between
 * delivery rounds - it either never got paid (restock + reject, same as any
 * other rejection) or got paid but was never marked served.
 *
 * A paid order goes straight to SERVED with no restock and, deliberately, no
 * customer message: we have no way to know whether food actually changed
 * hands, so it would be dishonest to tell the customer it did. The caller is
 * expected to show the admin a summary of what got closed instead, so a paid
 * order nobody served doesn't just silently vanish.
 */
async function closeLeftoverOrder(bot, order) {
  if (order.status === STATUS.PAID) {
    const updated = await repo.transitionOrderStatus(
      order.id,
      STATUS.PAID,
      STATUS.SERVED,
      'system',
      'Closed by delivery round reset - payment received, serving unconfirmed'
    );

    return updated ? orderStore.toOrder(updated) : null;
  }

  const result = await rejectOrderAndRestock(bot, order, {
    fromStatus: order.status,
    actor: 'system',
    reason: 'Delivery round reset',
    customerMessage: `❌ Order ${order.code} was closed because the delivery round ended before payment was completed.\n\n`
      + `The items have been returned to stock. If you still want to order, please create a new order by typing /start.`,
  });

  return result.success ? result.order : null;
}

/**
 * Expire an unpaid order once its payment window has elapsed.
 *
 * Called both by the sweeper and, on a late photo upload, directly from
 * handleUserPhoto - so an overdue order gets expired at the moment it's
 * caught rather than waiting for the next sweep. Only ever for orders still
 * in awaiting_payment: an order already being verified is never expired,
 * because the deadline is judged on when the customer SENT their screenshot.
 * The atomic status transition means a race between the two callers just
 * results in one of them getting `null` back, not a double-expiry.
 */
async function expireOrder(bot, order) {
  // Transition first, restock only if it won - see rejectOrderAndRestock.
  // Restocking first double-counted stock whenever the sweeper and a late
  // screenshot raced to expire the same order, or the customer's receipt
  // moved it to verifying in between.
  const updated = await repo.transitionOrderStatus(
    order.id,
    STATUS.AWAITING_PAYMENT,
    STATUS.EXPIRED,
    'system',
    'Payment window elapsed'
  );

  if (!updated) {
    return null;
  }

  const expiredOrder = orderStore.toOrder(updated);

  const restock = await restockOrder(expiredOrder);

  if (!restock.success) {
    await alertRestockFailed(bot, expiredOrder, restock.message);
  }

  await notify(bot, expiredOrder.chatId, expiredOrderMessage(expiredOrder.code));

  log('info', 'order_expired', { order_code: expiredOrder.code });

  return expiredOrder;
}

/** Also sent again if the customer sends a screenshot after the fact. */
function expiredOrderMessage(orderCode) {
  return `⌛ Order ${orderCode} has expired because a payment receipt was not received in time.\n\n`
    + `The items have been returned to stock. Please create your order again by typing /start.\n\n`
    + `If you have already made payment, recreate the same order and submit the screenshot of that payment. You do not need to pay again.`;
}

/** Shared summary block used in customer and admin messages. */
function buildOrderSummary(order) {
  const lines = order.items
    .map(item => `• ${item.name} x${item.quantity} = ${formatCents(item.lineTotalCents)}`)
    .join('\n');

  return `${lines || 'No items'}\n💰 Total: ${formatCents(order.totalCents)}`;
}

function describeCustomer(order) {
  return order.username ? `@${order.username}` : `${order.userName || 'Unknown'} (${order.userId})`;
}

module.exports = {
  restockOrder,
  markOrderPaid,
  rejectOrderAndRestock,
  closeLeftoverOrder,
  expireOrder,
  expiredOrderMessage,
  alertRestockFailed,
  buildOrderSummary,
  describeCustomer,
  notify,
};
