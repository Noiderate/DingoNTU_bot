const { config, getMissingVars } = require('../src/config');
const { getSupabase } = require('../src/services/supabase');

/**
 * Health check for diagnosing a bot that has stopped responding.
 *
 * Reports which variables are MISSING BY NAME and never their values, so the
 * endpoint is safe to open in a browser or paste into a chat while debugging.
 *
 * Runbook order when something is wrong: this endpoint, then
 * `npm run webhook:info`, then the Vercel runtime logs.
 */
module.exports = async function handler(req, res) {
  const missing = getMissingVars();

  const checks = {
    config: {
      ok: missing.length === 0,
      missing,
    },
    supabase: { ok: false },
    telegram: { ok: false },
  };

  // --- Supabase reachability ---
  try {
    const supabase = getSupabase();
    const result = await supabase.from('bot_state').select('key', { count: 'exact', head: true }).limit(1);

    if (result.error) {
      throw new Error(result.error.message);
    }

    checks.supabase = { ok: true };
  } catch (error) {
    // A free-tier project that has paused for inactivity shows up here first.
    checks.supabase = { ok: false, error: error.message };
  }

  // --- Webhook registration ---
  try {
    const { getBot } = require('../src/app');
    const info = await getBot().getWebHookInfo();

    checks.telegram = {
      ok: Boolean(info.url),
      // A climbing pending count means Telegram cannot reach us, or we are
      // failing to answer 2xx.
      pending_update_count: info.pending_update_count,
      last_error_message: info.last_error_message || null,
      last_error_date: info.last_error_date || null,
      has_custom_certificate: info.has_custom_certificate,
      url_configured: Boolean(info.url),
    };
  } catch (error) {
    checks.telegram = { ok: false, error: error.message };
  }

  const healthy = checks.config.ok && checks.supabase.ok;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    environment: config.nodeEnv,
    timezone: config.timezone,
    model: config.gemini.model,
    payment_window_minutes: config.payment.windowMinutes,
    payment_expiry_enabled: config.payment.expiryEnabled,
    checks,
    at: new Date().toISOString(),
  });
};
