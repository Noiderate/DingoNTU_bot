const crypto = require('crypto');
const { getSupabase, unwrap } = require('./supabase');
const { config } = require('../config');

/**
 * Durable replacement for the module-level variables the bot used to keep in
 * memory. On Vercel a later request may land on a different instance, so
 * anything that must outlive one request is read and written here.
 *
 * Keys in use are listed in MAINTENANCE.md so a maintainer can inspect and
 * clear stuck state without reading the source.
 */

const KEYS = {
  // Admin multi-step input, e.g. "waiting for a Telegram ID". Per admin.
  adminInputState: userId => `admin:input:${userId}`,
  // Set while a customer has been asked for a phone number before their
  // order can be confirmed (their first order, or any customer from before
  // this was collected). The next plain-text message from them is read as
  // their reply rather than falling through to the fallback hint.
  awaitingPhoneNumber: userId => `user:awaiting_phone:${userId}`,
  // Set while an admin has been asked for a drop-off photo for one customer's
  // remaining order(s) at a hall. The next photo/image document they send is
  // relayed to that customer instead of being treated as a payment receipt.
  awaitingDropoffPhoto: adminUserId => `admin:dropoff_photo:${adminUserId}`,
  // Snapshot of a hall's active orders, refreshed whenever "we are here"'s
  // list is (re)built. Read when a customer submenu opens, so that tap
  // doesn't need its own Supabase round trip - see admin.js's serve-list
  // functions.
  hallServeOrdersCache: hallName => `delivery:serve_cache:${hallName}`,
  // Message id of the self-editing admin menu, so it can be kept at the bottom.
  adminMenuMessage: userId => `admin:menu_msg:${userId}`,
  // Which admins currently have the delivery-mode menu open, for live refresh.
  deliveryViewer: userId => `delivery:viewer:${userId}`,
  // Delivery-mode sequencer: which hall and stage comes next.
  deliverySequencer: () => 'delivery:sequencer',
  // Channel message ids of posted announcements, so superseded ones are deleted.
  dingoPosts: () => 'delivery:dingo_posts',
  // Chat/message id of the "Tap each order when served" list for a hall, so a
  // new order placed after "we are here" is posted can be added to it live.
  hallServeMessage: hallName => `delivery:serve_msg:${hallName}`,
  // One-time token issued by Finish Delivery and carried by its "Reset Halls
  // and Orders" button. Reset only runs for the current token and consumes
  // it, so a leftover button from an earlier night can't wipe a live round.
  resetToken: () => 'delivery:reset_token',
  // The live preorder post being refreshed, and a hash of its rendered content
  // so an unchanged render skips the Telegram edit.
  preorderPost: () => 'delivery:preorder_post',
  // Admin-set first line and photo for the preorder post ({ text, photoFileId },
  // either may be null). Set under Settings > Edit Dingo Post; no expiry.
  preorderCustom: () => 'settings:preorder_custom',
  // Highest message id seen per chat, for admin-menu positioning.
  latestChatMessage: chatId => `chat:latest_msg:${chatId}`,
  // What was last written to the FoodAndStock sheet mirror, { hash, rowCount },
  // so an unchanged menu costs no Sheets write (see menuSheetSync).
  menuSheetSync: () => 'menu:sheet_sync',
  // Running tally of "sold out" moments for the Stats tab: { total, items: { name: count } }.
  soldOutStats: () => 'stats:sold_out',
  // Cached t.me deep link and payment-image file_id, to avoid repeat API calls.
  botStartUrl: () => 'cache:bot_start_url',
  paymentImageFileId: () => 'cache:payment_image_file_id',
  paymentExampleImageFileId: () => 'cache:payment_example_image_file_id',
};

async function get(key, fallback = null) {
  const supabase = getSupabase();

  const rows = unwrap(
    await supabase
      .from('bot_state')
      .select('value, expires_at')
      .eq('key', key)
      .limit(1),
    `stateStore.get(${key})`
  );

  const row = rows && rows[0];
  if (!row) {
    return fallback;
  }

  // Expiry is evaluated here, on read, rather than by a timer: timers do not
  // survive a serverless function ending.
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return fallback;
  }

  return row.value;
}

async function set(key, value, { ttlMs = null } = {}) {
  const supabase = getSupabase();

  unwrap(
    await supabase.from('bot_state').upsert(
      {
        key,
        value,
        updated_at: new Date().toISOString(),
        expires_at: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
      },
      { onConflict: 'key' }
    ),
    `stateStore.set(${key})`
  );

  return value;
}

async function remove(key) {
  const supabase = getSupabase();
  unwrap(
    await supabase.from('bot_state').delete().eq('key', key),
    `stateStore.remove(${key})`
  );
}

/**
 * Read-modify-write helper.
 *
 * Not atomic: a concurrent writer to the same key can be lost. That is
 * acceptable for the keys it is used on, which are all effectively
 * single-writer (one admin editing their own input state, one delivery-mode
 * sequencer guarded by its own lock). Do NOT use it for anything where two
 * writers race - use a lock, or a conditional update, instead.
 */
async function update(key, mutator, { ttlMs = null } = {}) {
  const current = await get(key);
  const next = await mutator(current);

  if (next === undefined) {
    return current;
  }

  return set(key, next, { ttlMs });
}

/**
 * Fetch many keys in one round trip. Used by the delivery-mode refresh, which
 * would otherwise issue a query per viewing admin.
 */
async function getMany(keys) {
  if (!keys.length) {
    return {};
  }

  const supabase = getSupabase();
  const rows = unwrap(
    await supabase.from('bot_state').select('key, value, expires_at').in('key', keys),
    'stateStore.getMany'
  );

  const now = Date.now();
  const result = {};

  for (const row of rows || []) {
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
      continue;
    }
    result[row.key] = row.value;
  }

  return result;
}


// --- Distributed lease locks -------------------------------------------------

/**
 * Attempt to take a named lock. Returns a holder token on success, or null if
 * someone else holds a live lease.
 */
async function acquireLock(name, { leaseMs = config.worker.lockLeaseMs } = {}) {
  const supabase = getSupabase();
  const holder = crypto.randomUUID();

  const acquired = unwrap(
    await supabase.rpc('try_acquire_lock', {
      p_name: name,
      p_holder: holder,
      p_lease_ms: leaseMs,
    }),
    `stateStore.acquireLock(${name})`
  );

  return acquired ? holder : null;
}

async function releaseLock(name, holder) {
  if (!holder) {
    return false;
  }

  const supabase = getSupabase();

  return unwrap(
    await supabase.rpc('release_lock', { p_name: name, p_holder: holder }),
    `stateStore.releaseLock(${name})`
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `task` while holding a named lock, releasing it even if `task` throws.
 *
 * This is what actually prevents overselling. The previous in-process promise
 * chain serialised only one Node process, which stops working the moment two
 * serverless instances handle two customers at the same time.
 *
 * Retries with backoff and jitter; jitter matters because several customers
 * tapping Confirm simultaneously would otherwise retry in lockstep forever.
 * Throws if the lock cannot be taken within the retry budget, which callers
 * surface to the user as "please try again".
 */
async function withLock(name, task, {
  leaseMs = config.worker.lockLeaseMs,
  maxAttempts = 12,
  baseDelayMs = 120,
  maxDelayMs = 1500,
} = {}) {
  let holder = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    holder = await acquireLock(name, { leaseMs });

    if (holder) {
      break;
    }

    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await sleep(backoff / 2 + Math.random() * (backoff / 2));
  }

  if (!holder) {
    const error = new Error(`Could not acquire lock "${name}" within ${maxAttempts} attempts`);
    error.code = 'LOCK_TIMEOUT';
    throw error;
  }

  try {
    return await task();
  } finally {
    try {
      await releaseLock(name, holder);
    } catch (releaseError) {
      // Never mask the task's own error. An unreleased lock expires on its own.
      console.error(JSON.stringify({
        event: 'lock_release_failed',
        lock: name,
        error: releaseError.message,
      }));
    }
  }
}

const LOCKS = {
  // Serialises ONE customer's Confirm taps, so a double tap cannot read the same
  // cart twice and place two orders. Per customer on purpose: stock itself is
  // protected by an atomic database statement (menuStore.deductStock), so
  // different customers never wait on each other.
  confirmOrder: userId => `order:confirm:${userId}`,
  // Guards admin Confirm/Reject and payment Accept/Reject for one order, so two
  // admins tapping at once cannot both act.
  orderAction: orderId => `order:action:${orderId}`,
  // Serialises one customer's cart read-modify-write, so rapid taps cannot
  // overwrite each other (see cartStore).
  cart: userId => `cart:${userId}`,
  // Serialises delivery-mode channel posts.
  deliveryPost: () => 'delivery:post',
  // Makes consuming the reset token and running the reset one step.
  deliveryReset: () => 'delivery:reset',
  // Rate-limits how often the Today's Orders tab is rewritten (see todaySheet).
  todaySheetRefresh: () => 'todaysheet:refresh',
  // Rate-limits how often the FoodAndStock mirror is rewritten (see menuSheetSync).
  menuSheetSync: () => 'menusheet:sync',
};

module.exports = {
  KEYS,
  LOCKS,
  get,
  getMany,
  set,
  update,
  remove,
  acquireLock,
  releaseLock,
  withLock,
};
