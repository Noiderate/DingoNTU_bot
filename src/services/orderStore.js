let nextOrderId = 1;
const pendingOrders = {};
const awaitingPaymentUsers = {}; // { [userId]: orderId }
const blockedHallNames = [];
const BLOCKED_HALLS_RESET_DELAY_MS = 3 * 60 * 60 * 1000;
let blockedHallsResetTimer = null;
let blockedHallsResetAt = null;

function createPendingOrder(orderData) {
  const orderId = nextOrderId++;
  const order = {
    id: orderId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    processedAt: null,
    processedBy: null,
    ...orderData,
  };

  pendingOrders[orderId] = order;
  return order;
}

function getPendingOrder(orderId) {
  return pendingOrders[orderId] || null;
}

function confirmPendingOrder(orderId, adminId) {
  const order = pendingOrders[orderId];
  if (!order || order.status !== 'pending') {
    return null;
  }

  order.status = 'confirmed';
  order.processedBy = adminId;
  order.processedAt = new Date().toISOString();
  return order;
}

function rejectPendingOrder(orderId, adminId) {
  const order = pendingOrders[orderId];
  if (!order || order.status !== 'pending') {
    return null;
  }

  order.status = 'rejected';
  order.processedBy = adminId;
  order.processedAt = new Date().toISOString();
  return order;
}

function setOrderAwaitingPayment(orderId) {
  const order = pendingOrders[orderId];
  if (!order) return;
  awaitingPaymentUsers[order.userId] = orderId;
}

function getAwaitingPaymentOrderId(userId) {
  return awaitingPaymentUsers[userId] || null;
}

function clearAwaitingPayment(userId) {
  delete awaitingPaymentUsers[userId];
}

function blockHall(hallName) {
  if (!hallName || blockedHallNames.includes(hallName)) {
    return false;
  }

  blockedHallNames.push(hallName);
  return true;
}

function revertLastBlockedHall() {
  return blockedHallNames.pop() || null;
}

function isHallBlocked(hallName) {
  return blockedHallNames.includes(hallName);
}

function getLastBlockedHall() {
  return blockedHallNames[blockedHallNames.length - 1] || null;
}

function clearBlockedHalls() {
  blockedHallNames.length = 0;
}

function scheduleBlockedHallsReset(onReset) {
  if (blockedHallsResetTimer) {
    clearTimeout(blockedHallsResetTimer);
  }

  blockedHallsResetAt = Date.now() + BLOCKED_HALLS_RESET_DELAY_MS;

  blockedHallsResetTimer = setTimeout(async () => {
    clearBlockedHalls();
    blockedHallsResetTimer = null;
    blockedHallsResetAt = null;

    if (typeof onReset === 'function') {
      try {
        await onReset();
      } catch (error) {
        console.error('Error in blocked hall reset callback:', error.message);
      }
    }
  }, BLOCKED_HALLS_RESET_DELAY_MS);

  return blockedHallsResetAt;
}

function getBlockedHallsResetAt() {
  return blockedHallsResetAt;
}

/**
 * Get all orders that are confirmed (awaiting payment) or paid
 */
function getActiveOrders() {
  return Object.values(pendingOrders).filter(
    order => order.status === 'confirmed' || order.status === 'paid'
  );
}

function getActiveOrdersByHall(hallName) {
  return getActiveOrders().filter(order => order.hallName === hallName);
}

function markOrderServed(orderId, adminId) {
  const order = pendingOrders[orderId];

  if (!order || (order.status !== 'confirmed' && order.status !== 'paid')) {
    return null;
  }

  order.status = 'served';
  order.servedBy = adminId;
  order.servedAt = new Date().toISOString();
  return order;
}

module.exports = {
  createPendingOrder,
  getPendingOrder,
  confirmPendingOrder,
  rejectPendingOrder,
  setOrderAwaitingPayment,
  getAwaitingPaymentOrderId,
  clearAwaitingPayment,
  getActiveOrders,
  getActiveOrdersByHall,
  markOrderServed,
  blockHall,
  revertLastBlockedHall,
  isHallBlocked,
  getLastBlockedHall,
  clearBlockedHalls,
  scheduleBlockedHallsReset,
  getBlockedHallsResetAt,
};
