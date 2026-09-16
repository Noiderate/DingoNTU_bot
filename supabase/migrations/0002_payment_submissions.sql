-- =============================================================================
-- 0002_payment_submissions.sql
-- Permanent audit trail of every payment receipt, and the job queue that
-- verification workers claim from.
--
-- This table is BOTH the evidence log and the work queue. Rows are updated as a
-- job progresses but are never deleted.
-- =============================================================================

do $$ begin
  create type payment_outcome as enum (
    'queued',              -- accepted, not yet picked up by a worker
    'processing',          -- a worker holds a live lease on it
    'auto_approved',       -- rules passed, order marked paid without a human
    'flagged',             -- needs an admin decision
    'incomplete_transfer', -- a "review"/"scheduled"/"pending" screen, not a payment
    'duplicate_rejected',  -- this reference or image was already used
    'manually_approved',   -- an admin accepted it
    'manually_rejected',   -- an admin rejected it
    'error'                -- verification failed permanently; escalated to an admin
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type transfer_status as enum (
    'successful',
    'review_or_confirm',
    'scheduled',
    'pending_or_processing',
    'failed',
    'unknown'
  );
exception when duplicate_object then null;
end $$;


create table if not exists payment_submissions (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid not null references orders (id),
  customer_id               uuid not null references customers (id),

  -- --- Telegram source ------------------------------------------------------
  telegram_message_id       bigint,
  telegram_file_id          text,
  telegram_file_unique_id   text,

  -- --- Stored evidence ------------------------------------------------------
  -- Object path inside the private receipts bucket. Never served directly;
  -- admins get a short-lived signed URL instead.
  storage_path              text,
  image_sha256              text,

  -- --- Processing timeline --------------------------------------------------
  -- received_at is when the CUSTOMER sent the screenshot. All deadlines are
  -- judged against this, never against when verification finished, so a slow
  -- check can never cost someone their order.
  received_at               timestamptz not null default now(),
  processing_message_id     bigint,
  processing_started_at     timestamptz,
  completed_at              timestamptz,
  attempt_count             integer     not null default 0,
  last_error                text,

  -- --- Queue fields ---------------------------------------------------------
  -- A worker claims a job by atomically setting locked_until/locked_by where
  -- the lease is free or expired. If the function is killed, the lease simply
  -- expires and the scheduled worker picks the job back up.
  next_attempt_at           timestamptz not null default now(),
  locked_until              timestamptz,
  locked_by                 text,
  -- Set once the "taking longer than expected" notice has been sent, so a
  -- later invocation never sends it twice.
  slow_notice_sent_at       timestamptz,

  -- --- Raw model output -----------------------------------------------------
  gemini_model              text,
  raw_extraction            jsonb,

  -- --- Normalised extraction ------------------------------------------------
  extracted_amount_cents    integer,
  extracted_currency        text,
  extracted_recipient_name  text,
  extracted_recipient_uen   text,
  extracted_recipient_proxy text,
  extracted_txn_at          timestamptz,
  extracted_txn_text        text,
  extracted_reference_raw   text,
  -- Uppercased with whitespace and separators stripped. This is the column the
  -- replay guard is enforced on.
  reference_normalized      text,
  transfer_status           transfer_status,
  bank_app                  text,

  -- --- Decision -------------------------------------------------------------
  outcome                   payment_outcome not null default 'queued',
  -- Machine reason codes from src/services/paymentRules.js, e.g.
  -- {AMOUNT_MISMATCH,TIMESTAMP_TOO_OLD}. ALL failing reasons are recorded, not
  -- just the first, so the audit record is complete.
  outcome_reasons           text[] not null default '{}',
  duplicate_of_submission_id uuid references payment_submissions (id),

  -- --- Manual review --------------------------------------------------------
  reviewed_by_telegram_id   bigint,
  reviewed_at               timestamptz,
  review_note               text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

drop trigger if exists payment_submissions_set_updated_at on payment_submissions;
create trigger payment_submissions_set_updated_at
  before update on payment_submissions
  for each row execute function set_updated_at();


-- --- Replay / duplicate guards -----------------------------------------------
-- THE core anti-fraud mechanism. A bank reference may be claimed by only one
-- live or approved submission. Enforced by the database, not by application
-- check-then-insert, so two concurrent workers cannot both win. Callers insert
-- optimistically and handle unique violation 23505.
--
-- The filter deliberately EXCLUDES terminal-failure outcomes, so a rejected or
-- errored receipt releases its reference for a legitimate retry.

create unique index if not exists payment_submissions_reference_claim_idx
  on payment_submissions (reference_normalized)
  where reference_normalized is not null
    and outcome in ('processing', 'auto_approved', 'flagged', 'manually_approved');

-- Secondary guard: catches a byte-identical re-upload even when the reference
-- could not be read off the image.
create unique index if not exists payment_submissions_image_claim_idx
  on payment_submissions (image_sha256)
  where image_sha256 is not null
    and outcome in ('processing', 'auto_approved', 'flagged', 'manually_approved');


-- --- Queue / lookup indexes --------------------------------------------------

create index if not exists payment_submissions_order_idx
  on payment_submissions (order_id, received_at desc);

-- The claim query: find due, unlocked jobs.
create index if not exists payment_submissions_queue_idx
  on payment_submissions (outcome, next_attempt_at)
  where outcome in ('queued', 'processing');

-- Counting live leases to enforce GEMINI_MAX_CONCURRENCY across instances.
create index if not exists payment_submissions_locked_idx
  on payment_submissions (locked_until)
  where locked_until is not null;

create index if not exists payment_submissions_customer_idx
  on payment_submissions (customer_id, received_at desc);


-- --- Permanence guard --------------------------------------------------------
-- DELETE is blocked; UPDATE is allowed because a job's outcome legitimately
-- changes as it progresses.

drop trigger if exists payment_submissions_no_delete on payment_submissions;
create trigger payment_submissions_no_delete
  before delete on payment_submissions
  for each row execute function forbid_mutation();


alter table payment_submissions enable row level security;
