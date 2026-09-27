const test = require('node:test');
const assert = require('node:assert/strict');
const { deliveryModeText } = require('../src/utils/menuTexts');

/**
 * Telegram rejects a message over 4096 characters, and a rejected edit or
 * send used to leave the admin with no delivery menu at all on a busy night.
 */

const HALLS = [
  { id: 2, name: 'Hall A' },
  { id: 3, name: 'Hall B' },
  { id: 4, name: 'Hall C' },
];

function makeOrders(hallName, count, status = 'paid') {
  return Array.from({ length: count }, (_, index) => ({
    hallName,
    status,
    username: `customer_${hallName.replace(' ', '')}_${index}`,
    items: [{ name: 'Chicken Rice', quantity: 2 }, { name: 'Iced Milo', quantity: 1 }],
  }));
}

test('a normal night still lists every order in full', () => {
  const orders = [...makeOrders('Hall A', 3), ...makeOrders('Hall B', 2, 'awaiting_payment')];

  const text = deliveryModeText(HALLS, orders, [], {});

  assert.match(text, /customer_HallA_2 - Chicken Rice x2, Iced Milo x1 \(paid\)/);
  assert.match(text, /customer_HallB_1 .*\(unpaid\)/);
});

test('a busy night stays under the Telegram limit, summarising halls and detailing the next one', () => {
  const orders = [
    ...makeOrders('Hall A', 60),
    ...makeOrders('Hall B', 40, 'awaiting_payment'),
    ...makeOrders('Hall C', 30),
  ];

  const text = deliveryModeText(HALLS, orders, [], { nextHallToPost: HALLS[1] });

  assert.ok(text.length <= 4096, `menu is ${text.length} characters`);
  assert.match(text, /Hall A: 60 order\(s\) - 60 paid, 0 unpaid/);
  assert.match(text, /Hall C: 30 order\(s\)/);
  assert.match(text, /customer_HallB_0 /);
});

test('while a hall is being served, it is the one kept in detail - not the hall queued next', () => {
  const orders = [...makeOrders('Hall A', 60), ...makeOrders('Hall B', 60)];

  // Serving Hall A; the sequencer already points at Hall B's get-ready.
  const text = deliveryModeText(HALLS, orders, [], {
    mode: 'get-ready', nextHallToPost: HALLS[1], gatingHall: HALLS[0], gatingProgress: { served: 0, total: 60 },
  });

  assert.ok(text.length <= 4096);
  assert.match(text, /customer_HallA_0 /);
  assert.match(text, /Hall B: 60 order\(s\)/);
});

test('even the detailed hall is trimmed with a count of what was left out', () => {
  const orders = makeOrders('Hall B', 300);

  const text = deliveryModeText(HALLS, orders, [], { nextHallToPost: HALLS[1] });

  assert.ok(text.length <= 4096, `menu is ${text.length} characters`);
  const shown = (text.match(/customer_HallB_/g) || []).length;
  assert.match(text, new RegExp(`…and ${300 - shown} more`));
});
