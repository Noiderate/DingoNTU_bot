const test = require('node:test');
const assert = require('node:assert/strict');

test('checkout creates a payable order with a deadline; legacy approval remains available', async t => {
  const dbModule = require('../src/services/supabase');
  const { config } = require('../src/config');
  let saved;
  let history;
  const db = {
    async rpc() { return { data: 'DG-1', error: null }; },
    from(table) {
      const query = {
        insert(row) {
          if (table === 'orders') saved = { id: 'order-1', ...row };
          if (table === 'order_status_history') history = row;
          return query;
        },
        select() { return query; },
        eq() { return query; },
        async limit() { return { data: [saved], error: null }; },
        async upsert() { return { error: null }; },
        then(resolve, reject) { return Promise.resolve({ error: null }).then(resolve, reject); },
      };
      return query;
    },
  };
  t.mock.method(dbModule, 'getSupabase', () => db);
  const repo = require('../src/services/orderRepository');
  const input = { customerId: 'customer-1', telegramChatId: 123, hallName: 'Hall 1', items: [], totalCents: 500 };
  const before = Date.now();
  const order = await repo.createOrder({ ...input, requiresAdminApproval: false });
  assert.equal(order.status, repo.STATUS.AWAITING_PAYMENT);
  assert.equal(history.to_status, repo.STATUS.AWAITING_PAYMENT);
  assert.equal(history.actor, 'customer');
  assert.equal(order.admin_confirmed_at, undefined);
  assert(Date.parse(order.payment_requested_at) >= before);
  assert(Date.parse(order.payment_due_at) >= before + config.payment.windowMinutes * 60000);
  assert(Date.parse(order.payment_due_at) <= Date.now() + config.payment.windowMinutes * 60000);
  const legacy = await repo.createOrder(input);
  assert.equal(legacy.status, repo.STATUS.PENDING_ADMIN_CONFIRMATION);
  assert.equal(legacy.payment_due_at, undefined);
});
