const path = require('path');

// Resolve local environment files relative to the repo root rather than
// process.cwd(), so the bot behaves the same whether started from root or src/.
// Non-sensitive settings live in .env.config and credentials in .env.secret.
// On Vercel neither file exists; the dashboard injects both sets of variables.
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env.config') });
require('dotenv').config({ path: path.join(root, '.env.secret') });

function readString(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function readInt(name, fallback) {
  const raw = readString(name);
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a whole number, got "${raw}"`);
  }
  return parsed;
}

function readBool(name, fallback) {
  const raw = readString(name).toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`Environment variable ${name} must be true or false, got "${raw}"`);
}

function readList(name) {
  return readString(name)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

// Private keys are stored single-line with literal \n escapes because dotenv
// files cannot hold real newlines. Pasting a genuine multi-line key into the
// Vercel dashboard also works, hence handling both.
function readPrivateKey(name) {
  return readString(name).replace(/\\n/g, '\n');
}

const config = {
  nodeEnv: readString('NODE_ENV', 'development'),
  isProduction: readString('NODE_ENV', 'development') === 'production',

  telegram: {
    botToken: readString('TELEGRAM_BOT_TOKEN'),
    webhookSecret: readString('TELEGRAM_WEBHOOK_SECRET'),
    publicBaseUrl: readString('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    dingoChannelId: readString('DINGO_CHANNEL_ID'),
    paymentInstructionImage: readString('PAYMENT_INSTRUCTION_IMAGE'),
    paymentInstructionImageUrl: readString('PAYMENT_INSTRUCTION_IMAGE_URL'),
  },

  sheets: {
    clientEmail: readString('GOOGLE_SHEETS_CLIENT_EMAIL'),
    privateKey: readPrivateKey('GOOGLE_SHEETS_PRIVATE_KEY'),
    spreadsheetId: readString('GOOGLE_SHEETS_SPREADSHEET_ID'),
  },

  supabase: {
    url: readString('SUPABASE_URL'),
    serviceRoleKey: readString('SUPABASE_SERVICE_ROLE_KEY'),
    receiptsBucket: readString('SUPABASE_RECEIPTS_BUCKET', 'payment-receipts'),
  },

  gemini: {
    apiKey: readString('GEMINI_API_KEY'),
    model: readString('GEMINI_MODEL', 'gemini-3.8-flash'),
    // Tried when the primary model reports a quota/rate-limit error (429).
    // Lite tiers get a far higher daily request quota than the primary model,
    // so this is what keeps verification automatic once the primary's quota
    // runs out for the day, rather than flagging every receipt to a human
    // until the reset. Set to '' to disable and fall back to plain retries.
    fallbackModel: readString('GEMINI_FALLBACK_MODEL', 'gemini-3.1-flash-lite'),
    maxConcurrency: readInt('GEMINI_MAX_CONCURRENCY', 2),
    requestsPerMinute: readInt('GEMINI_RPM', 15),
    slowThresholdMs: readInt('VERIFY_SLOW_THRESHOLD_MS', 8000),
    maxDurationMs: readInt('VERIFY_MAX_DURATION_MS', 600000),
    maxAttempts: readInt('VERIFY_MAX_ATTEMPTS', 8),
  },

  payment: {
    recipientNames: readList('PAYNOW_RECIPIENT_NAMES'),
    recipientAliases: readList('PAYNOW_RECIPIENT_ALIASES'),
    uen: readString('PAYNOW_UEN'),
    proxyNumber: readString('PAYNOW_PROXY_NUMBER'),
    merchantName: readString('PAYNOW_MERCHANT_NAME', 'Dingo Cafe'),
    maxAgeMinutes: readInt('PAYMENT_MAX_AGE_MINUTES', 30),
    clockSkewMinutes: readInt('PAYMENT_CLOCK_SKEW_MINUTES', 5),
    windowMinutes: readInt('PAYMENT_WINDOW_MINUTES', 2),
    expiryEnabled: readBool('PAYMENT_EXPIRY_ENABLED', true),
    maxIncompleteAttempts: readInt('MAX_INCOMPLETE_ATTEMPTS', 3),
  },

  worker: {
    cronSecret: readString('CRON_SECRET'),
    timeBudgetMs: readInt('WORKER_TIME_BUDGET_MS', 240000),
    lockLeaseMs: readInt('LOCK_LEASE_MS', 30000),
  },

  timezone: 'Asia/Singapore',
};

// Grouped so the health endpoint can report which capability is degraded rather
// than dumping one flat list of names.
const REQUIRED_BY_FEATURE = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  sheets: ['GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY', 'GOOGLE_SHEETS_SPREADSHEET_ID'],
  supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  webhook: ['TELEGRAM_WEBHOOK_SECRET'],
  gemini: ['GEMINI_API_KEY'],
  cron: ['CRON_SECRET'],
};

function getMissingVars(features = Object.keys(REQUIRED_BY_FEATURE)) {
  const missing = [];

  for (const feature of features) {
    for (const name of REQUIRED_BY_FEATURE[feature] || []) {
      if (!readString(name)) {
        missing.push(name);
      }
    }
  }

  return [...new Set(missing)];
}

/**
 * Throws listing every missing variable at once, so a misconfigured deployment
 * fails on the first request with an actionable message instead of a confusing
 * downstream error. Never includes any value.
 */
function assertRequiredConfig(features) {
  const missing = getMissingVars(features);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `See .env.example for what each one is and where to get it.`
    );
  }
}

module.exports = {
  config,
  getMissingVars,
  assertRequiredConfig,
  REQUIRED_BY_FEATURE,
};
