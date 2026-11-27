const { DateTime } = require('luxon');
const stateStore = require('./stateStore');
const { SGT } = require('../utils/time');
const { config } = require('../config');

/**
 * The emergency "Stop Bot" switch on the main admin menu.
 *
 * While paused, customers can't order (orderWindow.isOrderingOpen says no and
 * every closed-ordering reply points them at an admin instead), the channel's
 * preorder post says to message that admin and loses its button, and nothing
 * that would open ordering again (stage 1/2 posts, Extend, the reminders) runs.
 * Orders already placed are left exactly as they are - the admins are sent the
 * list so they can finish the night by hand.
 *
 * "For the day" means until the current service day ends (the same boundary
 * the Today's Orders tab uses, SERVICE_DAY_START_HOUR, default 3pm), so a pause
 * at 9pm lasts through the night and lifts the next afternoon. The record's
 * TTL is that boundary, so it simply stops existing then - no job has to clear
 * it. An admin can also lift it early with Resume Bot.
 *
 * "Stop until I resume" (indefinite) is the same pause with until: null and
 * no TTL - for a break of days or weeks. Only Resume Bot ends it.
 *
 * Record ({ pausedAt, until, pausedBy, pausedById, contact, previousWindow }):
 *   until          end of the service day (ISO), or null when indefinite
 *   contact        "@username" customers are told to message, or null
 *   previousWindow the order window from just before the pause, so Resume can
 *                  put the night back how it was
 */

/** The moment the current service day ends - when a pause lifts on its own. */
function pauseEndsAt(now = DateTime.now().setZone(SGT)) {
  const startHour = config.service.dayStartHour;
  const todaysStart = now.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
  return now < todaysStart ? todaysStart : todaysStart.plus({ days: 1 });
}

async function getPause() {
  return stateStore.get(stateStore.KEYS.botPause(), null);
}

async function isPaused() {
  return Boolean(await getPause());
}

/**
 * indefinite: true is "Stop until I resume" - no `until` and no TTL, so it
 * only ends when an admin taps Resume Bot.
 */
async function startPause({ pausedBy = null, pausedById = null, contact = null, previousWindow = null, indefinite = false }, now = DateTime.now().setZone(SGT)) {
  const until = indefinite ? null : pauseEndsAt(now);
  const record = {
    pausedAt: now.toUTC().toISO(),
    until: until ? until.toUTC().toISO() : null,
    pausedBy,
    pausedById,
    contact,
    previousWindow,
  };

  const ttlMs = until ? Math.max(60 * 1000, until.toMillis() - now.toMillis()) : null;
  await stateStore.set(stateStore.KEYS.botPause(), record, { ttlMs });
  return record;
}

async function endPause() {
  await stateStore.remove(stateStore.KEYS.botPause());
}

/** True for "Stop until I resume" (no end time). */
function isIndefinite(pause) {
  return Boolean(pause) && !pause.until;
}

/** "3:00 PM Fri" (SGT). */
function formatUntil(pause) {
  return DateTime.fromISO(pause.until).setZone(SGT).toFormat('h:mm a ccc');
}

/** "27 Nov" (SGT) - when the pause started. */
function formatSince(pause) {
  return DateTime.fromISO(pause.pausedAt).setZone(SGT).toFormat('d LLL');
}

/** "for today" or "for now", for customer-facing wording. */
function pauseSpan(pause) {
  return isIndefinite(pause) ? 'for now' : 'for today';
}

function contactLabel(pause) {
  return (pause && pause.contact) || 'an admin';
}

/** Short enough for a Telegram callback alert (200 characters). */
function customerPausedText(pause) {
  return `⚠️ Ordering through the bot is paused ${pauseSpan(pause)}. Please message ${contactLabel(pause)} to order.`;
}

function channelPausedText(pause) {
  return `⚠️ Ordering through the bot is paused ${pauseSpan(pause)}.\n\n`
    + `Please message ${contactLabel(pause)} to order.`;
}

module.exports = {
  pauseEndsAt,
  getPause,
  isPaused,
  startPause,
  endPause,
  isIndefinite,
  formatUntil,
  formatSince,
  pauseSpan,
  contactLabel,
  customerPausedText,
  channelPausedText,
};
