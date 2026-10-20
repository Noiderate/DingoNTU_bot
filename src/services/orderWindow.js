const { DateTime } = require('luxon');
const stateStore = require('./stateStore');
const { SGT } = require('../utils/time');

/**
 * The two ordering stages of a delivery night.
 *
 *   stage1  "orders open" post is live; ordering runs until `cutoffAt`.
 *   closed  the cutoff passed; the post says ordering is closed.
 *   stage2  the drivers have left and spare stock is on sale.
 *   (none)  nothing posted yet this round, or Finish Delivery cleared it.
 *
 * Ordering is only open in stage1 (before the cutoff) and stage2. State lives
 * in the durable store, so a redeploy never silently changes it.
 */

const STAGES = { STAGE1: 'stage1', CLOSED: 'closed', STAGE2: 'stage2' };

const DEFAULT_SCHEDULE = { postTime: '18:00', cutoffTime: '00:30' };

// How long before the target post time the admins are reminded.
const REMINDER_LEAD_MINUTES = 30;
// A reminder (or nudge) that is this much overdue is stale and is skipped,
// e.g. the first tick after a long outage, rather than pinging at midnight.
const REMINDER_STALE_MINUTES = 90;

const CLOCK_PATTERN = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?\s*$/i;

/**
 * "18:00", "6pm", "6:30 PM", "0030", "12.30am" -> "HH:mm", or null. A bare
 * number with no am/pm is read as a 24-hour time.
 */
function parseClock(input) {
  const raw = String(input || '').trim();
  const compact = /^(\d{2})(\d{2})$/.exec(raw);
  const match = compact ? [raw, compact[1], compact[2], undefined] : CLOCK_PATTERN.exec(raw);

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3] ? match[3][0].toLowerCase() : null;

  if (minute > 59) {
    return null;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "00:30" -> "12:30 AM". */
function formatClock(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function atClock(day, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

function nowSgt() {
  return DateTime.now().setZone(SGT);
}

/** The first moment strictly after `now` that the wall clock reads `hhmm`. */
function nextOccurrence(now, hhmm) {
  const today = atClock(now, hhmm);
  return today > now ? today : today.plus({ days: 1 });
}


// --- Stored state --------------------------------------------------------------

async function getSchedule() {
  const stored = await stateStore.get(stateStore.KEYS.orderSchedule(), null) || {};
  return {
    postTime: parseClock(stored.postTime) || DEFAULT_SCHEDULE.postTime,
    cutoffTime: parseClock(stored.cutoffTime) || DEFAULT_SCHEDULE.cutoffTime,
  };
}

async function setSchedule(patch) {
  const current = await getSchedule();
  const next = { ...current, ...patch };
  await stateStore.set(stateStore.KEYS.orderSchedule(), next);

  // A new post time starts the day's reminders over, so moving it to a few
  // minutes from now fires them again. Sent DMs stay tracked so they still close.
  if (patch.postTime !== undefined) {
    await stateStore.update(stateStore.KEYS.orderReminders(), current => ({
      messages: (current && current.messages) || [],
    }));
  }

  return next;
}

async function getWindow() {
  return stateStore.get(stateStore.KEYS.orderWindow(), null);
}

async function setWindow(value) {
  return stateStore.set(stateStore.KEYS.orderWindow(), value);
}

async function clearWindow() {
  return stateStore.remove(stateStore.KEYS.orderWindow());
}

/** Stage 1 goes live: ordering runs until the next time the cutoff clock is reached. */
async function openStageOne(cutoffTime, now = nowSgt()) {
  return setWindow({
    stage: STAGES.STAGE1,
    postedAt: now.toUTC().toISO(),
    cutoffAt: nextOccurrence(now, cutoffTime).toUTC().toISO(),
  });
}

/**
 * The admin changed the cutoff while stage 1 is live: move this round's cutoff
 * too. Measured from when stage 1 went out, so a cutoff that has already
 * passed simply closes ordering at the next tick.
 */
async function recomputeCutoff(cutoffTime) {
  const current = await getWindow();
  if (!current || current.stage !== STAGES.STAGE1 || !current.postedAt) {
    return false;
  }
  const postedAt = DateTime.fromISO(current.postedAt).setZone(SGT);
  await setWindow({ ...current, cutoffAt: nextOccurrence(postedAt, cutoffTime).toUTC().toISO() });
  return true;
}

async function closeStageOne() {
  const current = await getWindow();
  if (!current || current.stage !== STAGES.STAGE1) {
    return false;
  }
  await setWindow({ ...current, stage: STAGES.CLOSED });
  return true;
}

async function openStageTwo(now = nowSgt()) {
  const current = await getWindow() || {};
  return setWindow({ ...current, stage: STAGES.STAGE2, stage2At: now.toUTC().toISO() });
}

/** Whether the cutoff has passed for a live stage-1 window. */
function isPastCutoff(window, now = nowSgt()) {
  return Boolean(window && window.stage === STAGES.STAGE1 && window.cutoffAt
    && DateTime.fromISO(window.cutoffAt) <= now);
}

/**
 * Whether customers can order right now. Re-checks the cutoff itself, so the
 * cutoff is sharp even if the scheduled tick that edits the post is late.
 * With no stage recorded at all, falls back to "a preorder post exists" so a
 * round already running when this shipped keeps working.
 */
async function isOrderingOpen(now = nowSgt()) {
  const window = await getWindow();

  if (!window) {
    const post = await stateStore.get(stateStore.KEYS.preorderPost(), null);
    return Boolean(post && post.msgId);
  }

  if (window.stage === STAGES.STAGE2) {
    return true;
  }

  return window.stage === STAGES.STAGE1 && !isPastCutoff(window, now);
}


// --- Stage-2 stock figures -----------------------------------------------------

/**
 * Total / sold / remaining for one item at the moment stage 2 is confirmed.
 *
 * Remaining is the live stock. Total is the opening stock (baseline) plus any
 * adjustment typed in on the confirm screen; sold is the difference, i.e. what
 * stage-1 orders took. An item with no recorded opening stock can't tell what
 * was sold, so it is treated as nothing sold.
 */
function stockFigures(item, adjust = {}) {
  const remaining = Number(item.stock) || 0;
  const adjustment = Number(adjust[item.id]) || 0;
  const hasBaseline = item.baselineStock !== null && item.baselineStock !== undefined;
  const total = hasBaseline ? item.baselineStock + adjustment : remaining;
  const sold = hasBaseline ? Math.max(0, total - remaining) : 0;

  return { total, sold, remaining, hasBaseline };
}


// --- Reminders -----------------------------------------------------------------

/**
 * What the scheduled tick should tell the admins about posting stage 1.
 * Pure: returns 'remind' (from 30 min before the target), 'nudge' (from the
 * target time) or null. Each fires at most once a day, never once stage 1 has
 * been posted for tonight, and never when badly overdue.
 */
function reminderAction({ now, postTime, window, reminders }) {
  const target = atClock(now, postTime);
  const remindAt = target.minus({ minutes: REMINDER_LEAD_MINUTES });
  const day = target.toFormat('yyyy-LL-dd');
  const sent = reminders && reminders.date === day ? reminders : {};

  const postedTonight = Boolean(window && window.postedAt && DateTime.fromISO(window.postedAt) >= remindAt);

  if (postedTonight) {
    return null;
  }

  if (now >= target && now < target.plus({ minutes: REMINDER_STALE_MINUTES }) && !sent.nudged) {
    return 'nudge';
  }

  if (now >= remindAt && now < target && !sent.reminded) {
    return 'remind';
  }

  return null;
}

async function markReminderSent(kind, now = nowSgt()) {
  const target = atClock(now, (await getSchedule()).postTime);
  const day = target.toFormat('yyyy-LL-dd');
  const current = await stateStore.get(stateStore.KEYS.orderReminders(), null);
  const base = current && current.date === day ? current : { date: day };
  const next = { ...base, [kind === 'nudge' ? 'nudged' : 'reminded']: true };
  // A nudge implies the reminder window has passed too.
  if (kind === 'nudge') next.reminded = true;
  await stateStore.set(stateStore.KEYS.orderReminders(), next);
}

module.exports = {
  STAGES,
  DEFAULT_SCHEDULE,
  REMINDER_LEAD_MINUTES,
  parseClock,
  formatClock,
  nowSgt,
  nextOccurrence,
  getSchedule,
  setSchedule,
  getWindow,
  setWindow,
  clearWindow,
  openStageOne,
  recomputeCutoff,
  closeStageOne,
  openStageTwo,
  isPastCutoff,
  isOrderingOpen,
  stockFigures,
  reminderAction,
  markReminderSent,
};
