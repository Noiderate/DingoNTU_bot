const crypto = require('crypto');
const repo = require('./orderRepository');
const orderStore = require('./orderStore');
const orderActions = require('./orderActions');
const { extractReceipt, GeminiError } = require('./geminiClient');
const { evaluatePayment, OUTCOMES, REASONS } = require('./paymentRules');
const { getAdminIds } = require('./googleSheets');
const { isUniqueViolation } = require('./supabase');
const { config } = require('../config');
const { CALLBACKS } = require('../config/constants');
const { formatCents } = require('../utils/money');
const { formatSgt } = require('../utils/time');
const { log } = require('../utils/logger');

/**
 * The payment verification pipeline.
 *
 * Designed so that no step depends on the process staying alive. Everything is
 * recorded in payment_submissions as it happens, and a job whose function is
 * frozen or killed mid-run is simply picked back up by the scheduled worker
 * once its lease expires.
 */

const STATUS = repo.STATUS;

// Exact customer-facing copy. These strings are specified in the brief and are
// asserted in tests; do not reword them casually.
const MESSAGES = {
  PROCESSING: 'Please wait while your payment is being processed.',
  SLOW: 'This is taking longer than expected, please wait',
  FLAGGED: "We couldn't automatically verify your payment. An admin will review it shortly. No need to resend unless asked.",
  DUPLICATE: "This receipt has already been used for another order. Please send the screenshot for this order's payment.",
  INCOMPLETE: '⚠️ That looks like an unfinished or scheduled transfer, not a completed one.\n\n'
    + 'Please complete the payment and send the screenshot of the "Transfer Successful" screen.',
  ALREADY_VERIFIED: '✅ This payment has already been verified. Nothing more is needed.',
  ALREADY_UNDER_REVIEW: 'This receipt is already under review. Please wait for an admin.',
  STILL_CHECKING: 'Your previous screenshot is still being checked, please wait.',
};


// --- Telegram message helpers ------------------------------------------------

/**
 * Edit the "Please wait" message in place.
 *
 * Editing rather than sending keeps the conversation tidy and, importantly,
 * avoids disturbing the admin-menu "latest message in chat" tracking that
 * src/app.js maintains.
 *
 * Both failure modes here are benign and must never fail the job: the text may
 * be unchanged, or the message may have been deleted by the user.
 */
async function editProcessingMessage(bot, chatId, messageId, text, replyMarkup) {
  if (!chatId || !messageId) {
    return false;
  }

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return true;
  } catch (error) {
    const message = String(error.message || '');

    if (message.includes('message is not modified')) {
      return true;
    }

    if (message.includes('message to edit not found') || message.includes('MESSAGE_ID_INVALID')) {
      // The customer deleted it. Fall back to a fresh message so they still
      // learn the outcome.
      await orderActions.notify(bot, chatId, text);
      return false;
    }

    log('warn', 'edit_processing_message_failed', { error: message });
    return false;
  }
}

/** Send the slow notice at most once across all invocations of a job. */
async function sendSlowNoticeOnce(bot, submission, chatId) {
  if (submission.slow_notice_sent_at) {
    return submission;
  }

  await editProcessingMessage(bot, chatId, submission.processing_message_id, MESSAGES.SLOW);

  return repo.updatePaymentSubmission(submission.id, {
    slow_notice_sent_at: new Date().toISOString(),
  });
}


// --- Step 1 and 2: accept the receipt ----------------------------------------

/**
 * Record an incoming receipt and move the order into verification.
 *
 * Returns { submission, order } or { rejected, reason } when the receipt should
 * not start a new verification at all.
 */
async function submitReceipt(bot, { order, telegramMessageId, fileId, fileUniqueId, mimeType, processingMessageId }) {
  // One verification per order at a time. A customer sending a second
  // screenshot while the first is in flight is told to wait rather than having
  // two workers race on the same order.
  const existing = await repo.getOrderById(order.id);

  if (existing.status === STATUS.VERIFYING_PAYMENT) {
    return { rejected: true, reason: 'in_progress' };
  }

  const submission = await repo.createPaymentSubmission({
    order_id: order.id,
    customer_id: existing.customer_id,
    telegram_message_id: telegramMessageId,
    telegram_file_id: fileId,
    telegram_file_unique_id: fileUniqueId,
    received_at: new Date().toISOString(),
    processing_message_id: processingMessageId,
    outcome: 'queued',
    gemini_model: config.gemini.model,
  });

  const moved = await repo.transitionOrderStatus(
    order.id,
    existing.status,
    STATUS.VERIFYING_PAYMENT,
    'customer',
    'Payment screenshot received',
    { actorTelegramId: order.userId }
  );

  if (!moved) {
    return { rejected: true, reason: 'order_moved' };
  }

  log('info', 'receipt_submitted', {
    order_code: order.code,
    submission_id: submission.id,
    mime_type: mimeType,
  });

  return { submission, order: orderStore.toOrder(moved) };
}


// --- Step 3: fetch and store the evidence ------------------------------------

async function downloadTelegramFile(bot, fileId) {
  const link = await bot.getFileLink(fileId);
  const response = await fetch(link);

  if (!response.ok) {
    throw new Error(`Telegram file download failed with ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}


// --- Step 4: call the model with retries -------------------------------------

function backoffMs(attempt) {
  // 2s, 4s, 8s ... capped at 60s, with jitter so concurrent jobs do not retry
  // in lockstep.
  const base = Math.min(2000 * 2 ** attempt, 60000);
  return base / 2 + Math.random() * (base / 2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


// --- Step 7: apply the decision ----------------------------------------------

function buildAdminReviewCaption(order, decision, submission) {
  const extracted = decision.normalized || {};

  const lines = [
    `⚠️ Payment needs review - Order ${order.code}`,
    `👤 ${orderActions.describeCustomer(order)}`,
    `🏢 Hall: ${order.hallName}`,
    `💰 Order total: ${formatCents(order.totalCents)}`,
    '',
    '🧾 Items:',
    orderActions.buildOrderSummary(order),
    '',
    '🔍 What we read from the screenshot:',
    `• Amount: ${extracted.amountCents !== null && extracted.amountCents !== undefined ? formatCents(extracted.amountCents) : 'could not read'}`,
    `• Paid to: ${extracted.recipientName || extracted.recipientUen || extracted.recipientProxy || 'could not read'}`,
    `• Time: ${extracted.txnAt ? formatSgt(extracted.txnAt) : 'could not read'}`,
    `• Reference: ${extracted.referenceRaw || 'none shown'}`,
    `• Transfer state: ${extracted.transferStatus || 'unknown'}`,
    `• Bank: ${extracted.bankApp || 'unknown'}`,
    '',
    `❗ Why it was flagged: ${decision.reasons.join(', ') || 'unknown'}`,
  ];

  const caption = lines.join('\n');

  // Telegram caption limit is 1024 characters.
  return caption.length > 1024 ? `${caption.slice(0, 1010)}\n…(truncated)` : caption;
}

/**
 * Route a flagged receipt to admins using the EXISTING manual review mechanism:
 * a direct message with Accept/Reject buttons. No staff-group features.
 */
async function forwardToAdmins(bot, order, submission, decision) {
  const caption = buildAdminReviewCaption(order, decision, submission);

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Accept Payment', callback_data: `${CALLBACKS.PAYMENT_ACCEPT_PREFIX}${order.id}` },
      { text: '❌ Reject Payment', callback_data: `${CALLBACKS.PAYMENT_REJECT_PREFIX}${order.id}` },
    ]],
  };

  for (const adminId of getAdminIds()) {
    try {
      if (submission.telegram_file_id) {
        await bot.sendPhoto(adminId, submission.telegram_file_id, { caption, reply_markup: keyboard });
      } else {
        await bot.sendMessage(adminId, caption, { reply_markup: keyboard });
      }
    } catch (error) {
      log('warn', 'admin_forward_failed', {
        order_code: order.code,
        admin_id: adminId,
        error: error.message,
      });
    }
  }
}

/**
 * Claim the reference and record the outcome in one atomic write.
 *
 * The partial unique index on reference_normalized is what actually prevents a
 * replayed receipt, so this optimistically writes and treats a 23505 as "someone
 * else already claimed it" rather than checking first and then writing, which
 * would leave a race window.
 */
async function claimAndRecord(submission, decision, patch) {
  try {
    const updated = await repo.updatePaymentSubmission(submission.id, {
      ...patch,
      reference_normalized: decision.normalized.referenceNormalized,
      outcome: decision.outcome,
      outcome_reasons: decision.reasons,
      completed_at: new Date().toISOString(),
      locked_by: null,
      locked_until: null,
    });

    return { claimed: true, submission: updated };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const conflict = await repo.findConflictingSubmission({
      referenceNormalized: decision.normalized.referenceNormalized,
      imageSha256: patch.image_sha256,
    });

    const duplicateReasons = [...new Set([...decision.reasons, REASONS.DUPLICATE_REFERENCE])];

    const updated = await repo.updatePaymentSubmission(submission.id, {
      ...patch,
      // Deliberately NOT setting reference_normalized: the index filter would
      // reject it again, and the reference belongs to the winning submission.
      outcome: 'duplicate_rejected',
      outcome_reasons: duplicateReasons,
      duplicate_of_submission_id: conflict ? conflict.id : null,
      completed_at: new Date().toISOString(),
      locked_by: null,
      locked_until: null,
    });

    return { claimed: false, submission: updated, conflict };
  }
}

async function applyOutcome(bot, { order, submission, decision, patch }) {
  const claim = await claimAndRecord(submission, decision, patch);
  const effectiveOutcome = claim.claimed ? decision.outcome : OUTCOMES.DUPLICATE_REJECTED;
  const chatId = order.chatId;
  const processingMessageId = submission.processing_message_id;

  log('info', 'verification_decided', {
    order_code: order.code,
    submission_id: submission.id,
    outcome: effectiveOutcome,
    reasons: decision.reasons,
    bank_app: decision.normalized.bankApp,
  });

  if (effectiveOutcome === OUTCOMES.AUTO_APPROVED) {
    const paid = await orderActions.markOrderPaid(bot, order, {
      fromStatus: STATUS.VERIFYING_PAYMENT,
      actor: 'ai_verifier',
      actorTelegramId: null,
      reason: `Auto-approved${decision.reasons.length ? ` (${decision.reasons.join(', ')})` : ''}`,
    });

    if (paid) {
      await editProcessingMessage(
        bot, chatId, processingMessageId,
        `✅ Payment received and verified for Order ${order.code}.\n\n`
        + `${formatCents(order.totalCents)} confirmed. Your order is being prepared. 🍽️`
      );
    }

    return { outcome: effectiveOutcome };
  }

  if (effectiveOutcome === OUTCOMES.INCOMPLETE_TRANSFER) {
    // Stays payable: the customer can finish the transfer and resend.
    await repo.transitionOrderStatus(
      order.id, STATUS.VERIFYING_PAYMENT, STATUS.AWAITING_PAYMENT,
      'ai_verifier', 'Unfinished transfer screenshot'
    );
    await editProcessingMessage(bot, chatId, processingMessageId, MESSAGES.INCOMPLETE);
    return { outcome: effectiveOutcome };
  }

  if (effectiveOutcome === OUTCOMES.DUPLICATE_REJECTED) {
    await repo.transitionOrderStatus(
      order.id, STATUS.VERIFYING_PAYMENT, STATUS.AWAITING_PAYMENT,
      'ai_verifier', 'Duplicate receipt'
    );
    await editProcessingMessage(bot, chatId, processingMessageId, MESSAGES.DUPLICATE);

    log('warn', 'duplicate_receipt', {
      order_code: order.code,
      submission_id: submission.id,
      conflicting_submission_id: claim.conflict ? claim.conflict.id : null,
    });

    return { outcome: effectiveOutcome };
  }

  // Everything else reaches a human.
  const flagged = await repo.transitionOrderStatus(
    order.id, STATUS.VERIFYING_PAYMENT, STATUS.PAYMENT_FLAGGED,
    'ai_verifier', `Flagged: ${decision.reasons.join(', ')}`
  );

  await editProcessingMessage(bot, chatId, processingMessageId, MESSAGES.FLAGGED);
  await forwardToAdmins(bot, flagged ? orderStore.toOrder(flagged) : order, claim.submission, decision);

  return { outcome: OUTCOMES.FLAGGED };
}


// --- The pipeline ------------------------------------------------------------

/**
 * Run verification for one claimed submission.
 *
 * `deadline` is when this invocation must stop. If work remains, the job is
 * released back to the queue with next_attempt_at rather than being killed
 * mid-flight, so the scheduled worker continues it.
 */
async function processSubmission(bot, submissionId, { deadline = Date.now() + config.worker.timeBudgetMs } = {}) {
  let submission = await repo.getPaymentSubmission(submissionId);

  if (!submission) {
    return { skipped: 'missing' };
  }

  const orderRow = await repo.getOrderById(submission.order_id);

  if (!orderRow) {
    return { skipped: 'order_missing' };
  }

  const order = orderStore.toOrder(orderRow);

  // An admin may have decided this order manually while it sat in the queue.
  if (orderRow.status !== STATUS.VERIFYING_PAYMENT) {
    await repo.updatePaymentSubmission(submission.id, {
      outcome: 'error',
      outcome_reasons: ['SUPERSEDED'],
      last_error: `Order was ${orderRow.status} when the worker resumed`,
      completed_at: new Date().toISOString(),
      locked_by: null,
      locked_until: null,
    });
    return { skipped: 'superseded' };
  }

  const startedAt = Date.now();

  try {
    // --- Evidence ---
    let imageBuffer;
    let mimeType = 'image/jpeg';

    if (!submission.storage_path) {
      imageBuffer = await downloadTelegramFile(bot, submission.telegram_file_id);
      const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');

      const storagePath = repo.buildReceiptPath({
        orderCode: order.code,
        submissionId: submission.id,
        extension: extensionFor(mimeType),
      });

      await repo.uploadReceipt({ path: storagePath, buffer: imageBuffer, contentType: mimeType });

      submission = await repo.updatePaymentSubmission(submission.id, {
        storage_path: storagePath,
        image_sha256: sha256,
      });
    } else {
      imageBuffer = await downloadTelegramFile(bot, submission.telegram_file_id);
    }

    // --- Extraction, with retry ---
    let extractionResult = null;
    let attempt = submission.attempt_count || 0;

    while (!extractionResult) {
      if (attempt >= config.gemini.maxAttempts) {
        throw new GeminiError('Exhausted verification attempts', { retryable: false });
      }

      if (Date.now() - new Date(submission.received_at).getTime() > config.gemini.maxDurationMs) {
        throw new GeminiError('Verification exceeded its maximum duration', { retryable: false });
      }

      attempt += 1;
      submission = await repo.updatePaymentSubmission(submission.id, { attempt_count: attempt });

      try {
        extractionResult = await extractReceipt(imageBuffer, mimeType);
      } catch (error) {
        if (!(error instanceof GeminiError) || !error.retryable) {
          throw error;
        }

        submission = await sendSlowNoticeOnce(bot, submission, order.chatId);

        const waitMs = error.retryAfterMs || backoffMs(attempt);

        // If the retry would run past this invocation's budget, hand the job
        // back rather than being killed holding it.
        if (Date.now() + waitMs > deadline) {
          await repo.releaseSubmission(submission.id, {
            nextAttemptAt: new Date(Date.now() + waitMs),
            lastError: error.message,
          });
          return { released: true, reason: 'time_budget' };
        }

        await sleep(waitMs);
      }
    }

    // Slow even without an error.
    if (Date.now() - startedAt > config.gemini.slowThresholdMs) {
      submission = await sendSlowNoticeOnce(bot, submission, order.chatId);
    }

    // --- Decide ---
    const incompleteAttempts = await repo.countIncompleteAttempts(order.id);

    const decision = evaluatePayment({
      extraction: extractionResult.extraction,
      order: { total_cents: order.totalCents, created_at: order.createdAt },
      rules: config.payment,
      now: new Date(),
      receivedAt: new Date(submission.received_at),
      duplicate: { reference: false, image: false },
      incompleteAttempts,
    });

    const patch = {
      raw_extraction: extractionResult.raw,
      gemini_model: extractionResult.model,
      extracted_amount_cents: decision.normalized.amountCents,
      extracted_currency: decision.normalized.currency,
      extracted_recipient_name: decision.normalized.recipientName,
      extracted_recipient_uen: decision.normalized.recipientUen,
      extracted_recipient_proxy: decision.normalized.recipientProxy,
      extracted_txn_at: decision.normalized.txnAt ? decision.normalized.txnAt.toISOString() : null,
      extracted_txn_text: decision.normalized.txnText,
      extracted_reference_raw: decision.normalized.referenceRaw,
      transfer_status: decision.normalized.transferStatus,
      bank_app: decision.normalized.bankApp,
      image_sha256: submission.image_sha256,
    };

    return await applyOutcome(bot, { order, submission, decision, patch });
  } catch (error) {
    return handleTerminalFailure(bot, { order, submission, error });
  }
}

/**
 * Verification failed for good.
 *
 * The order is never silently left in limbo: it is flagged exactly as any other
 * uncertain receipt, so a human still decides.
 */
async function handleTerminalFailure(bot, { order, submission, error }) {
  log('error', 'verification_failed', {
    order_code: order.code,
    submission_id: submission.id,
    error: error.message,
  });

  await repo.updatePaymentSubmission(submission.id, {
    outcome: 'error',
    outcome_reasons: [REASONS.VERIFICATION_ERROR],
    last_error: error.message,
    completed_at: new Date().toISOString(),
    locked_by: null,
    locked_until: null,
  });

  const flagged = await repo.transitionOrderStatus(
    order.id, STATUS.VERIFYING_PAYMENT, STATUS.PAYMENT_FLAGGED,
    'system', `Verification error: ${error.message}`
  );

  await editProcessingMessage(bot, order.chatId, submission.processing_message_id, MESSAGES.FLAGGED);

  await forwardToAdmins(
    bot,
    flagged ? orderStore.toOrder(flagged) : order,
    submission,
    { reasons: [REASONS.VERIFICATION_ERROR], normalized: {} }
  );

  return { outcome: 'error' };
}

/**
 * Notify a customer whose queued receipt turned out to be a duplicate before
 * verification ever ran on it.
 *
 * This is the claim-time counterpart to the DUPLICATE_REJECTED branch of
 * applyOutcome: repo.claimNextSubmission already resolved the row itself
 * (it had to, to stop re-throwing on every tick), so all that's left is the
 * customer-facing side - put their order back in front of them instead of
 * leaving it stuck at "verifying" with a message that never updates.
 */
async function notifyClaimTimeDuplicate(bot, { submission, conflict }) {
  const orderRow = await repo.getOrderById(submission.order_id);

  if (!orderRow || orderRow.status !== STATUS.VERIFYING_PAYMENT) {
    return;
  }

  const order = orderStore.toOrder(orderRow);

  await repo.transitionOrderStatus(
    order.id, STATUS.VERIFYING_PAYMENT, STATUS.AWAITING_PAYMENT,
    'ai_verifier', 'Duplicate receipt'
  );

  await editProcessingMessage(bot, order.chatId, submission.processing_message_id, MESSAGES.DUPLICATE);

  log('warn', 'duplicate_receipt', {
    order_code: order.code,
    submission_id: submission.id,
    conflicting_submission_id: conflict ? conflict.id : null,
    stage: 'claim',
  });
}

/**
 * Scheduled worker entry point: claim and process due jobs until the budget
 * runs out or the concurrency ceiling is reached.
 */
async function processQueue(bot, { deadline = Date.now() + config.worker.timeBudgetMs, workerId = 'cron' } = {}) {
  const processed = [];

  while (Date.now() < deadline) {
    const live = await repo.countLiveVerificationLeases();

    if (live >= config.gemini.maxConcurrency) {
      break;
    }

    const { submission, duplicates } = await repo.claimNextSubmission(workerId);

    for (const duplicate of duplicates) {
      await notifyClaimTimeDuplicate(bot, duplicate);
    }

    if (!submission) {
      // Nothing claimable right now. If this pass only turned up duplicates,
      // there may still be genuine work behind them - keep going rather than
      // stopping the whole worker early.
      if (duplicates.length) {
        continue;
      }
      break;
    }

    const result = await processSubmission(bot, submission.id, { deadline });
    processed.push({ submission_id: submission.id, ...result });
  }

  return { processed: processed.length, results: processed };
}

module.exports = {
  MESSAGES,
  submitReceipt,
  processSubmission,
  processQueue,
  applyOutcome,
  editProcessingMessage,
  forwardToAdmins,
  buildAdminReviewCaption,
  claimAndRecord,
};
