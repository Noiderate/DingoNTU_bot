const stateStore = require('./stateStore');
const { config } = require('../config');
const { log } = require('../utils/logger');

/**
 * Which channel the Dingo posts go to: the real one (DINGO_CHANNEL_ID) or a
 * private test one (TEST_DINGO_CHANNEL_ID). Switched under Settings > Change
 * Dingo Channel, where they are labelled REAL and FAKE, and stored in bot_state, so it applies across every instance.
 *
 * Anything other than an explicit, usable "test" choice means the real
 * channel - including a failed read, so a Supabase hiccup never silently
 * hides posts from customers.
 */

const MODES = { LIVE: 'live', TEST: 'test' };

function isTestChannelConfigured() {
  return Boolean(config.telegram.testDingoChannelId);
}

async function getMode() {
  try {
    const stored = await stateStore.get(stateStore.KEYS.channelTarget(), null);
    return stored && stored.mode === MODES.TEST && isTestChannelConfigured() ? MODES.TEST : MODES.LIVE;
  } catch (error) {
    log('warn', 'channel_target_read_failed', { error: error.message });
    return MODES.LIVE;
  }
}

/** The channel id new Dingo posts should go to right now ('' if none is set). */
async function getActiveChannelId() {
  return (await getMode()) === MODES.TEST
    ? config.telegram.testDingoChannelId
    : config.telegram.dingoChannelId;
}

async function setMode(mode, changedBy = null) {
  return stateStore.set(stateStore.KEYS.channelTarget(), {
    mode: mode === MODES.TEST ? MODES.TEST : MODES.LIVE,
    changedAt: new Date().toISOString(),
    changedBy,
  });
}

module.exports = {
  MODES,
  isTestChannelConfigured,
  getMode,
  getActiveChannelId,
  setMode,
};
