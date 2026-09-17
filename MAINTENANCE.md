# Maintenance handbook

For whoever looks after this bot next — possibly months from now, possibly not
the person who built it.

Written from the code that actually shipped. Every path, function, table and
variable named here is real. If you change something in this list, update this
file **in the same commit**.

---

## 1. System overview

The bot takes food preorders over Telegram, collects PayNow payments, verifies
the receipts automatically, and coordinates a delivery round across dorm halls.

```
   customer / admin
         │
         ▼
   ┌──────────┐   POST + secret header
   │ Telegram │──────────────────────────┐
   └──────────┘                          ▼
         ▲                  ┌─────────────────────────┐
         │                  │ api/telegram-webhook.js │
         │                  │  1. check secret        │
         │                  │  2. dedupe update_id    │
         │                  │  3. handleUpdate()      │
         │                  │  4. waitUntil(slow work)│
         │                  └────────────┬────────────┘
         │                               ▼
         │                        ┌─────────────┐
         │                        │ src/app.js  │
         │                        └──┬───┬───┬──┘
         │            admin ─────────┘   │   └───── user
         │                               │
         └───────────────────────────────┤
                                         ▼
     ┌──────────────┬────────────────────┬──────────────────┐
     ▼              ▼                    ▼                  ▼
┌──────────┐  ┌───────────────┐   ┌─────────────┐   ┌──────────────┐
│ Supabase │  │ Google Sheets │   │Gemini Flash │   │ Dingo channel│
└──────────┘  └───────────────┘   └─────────────┘   └──────────────┘
     ▲
     │ every minute: Authorization: Bearer CRON_SECRET
┌──────────────┐        ┌───────────────────┐
│ cron-job.org │───────▶│ api/cron/tick.js  │
└──────────────┘        └───────────────────┘
```

### Who owns what data

| Data | Source of truth | Where |
|---|---|---|
| Orders, order items, status history | **Supabase** | `orders`, `order_items`, `order_status_history` |
| Customers | **Supabase** | `customers` |
| Payment receipts and verdicts | **Supabase** | `payment_submissions` + `payment-receipts` bucket |
| Carts | **Supabase** | `carts` |
| Hall blocking | **Supabase** | `halls_state` |
| Delivery sequencer, admin prompts, menu positions, caches | **Supabase** | `bot_state` |
| Admin IDs, tagged admin | **Google Sheets** | `Settings` (IDs col A, tagged admin B2) |
| Food, prices, stock | **Google Sheets** | `FoodAndStock` (A name, B price, C stock) |
| Halls | **Google Sheets** | `Hall` (A name, B short name) |
| Orders tab | **mirror only** — never edit | `Orders` |

> The `Orders` tab is written *by* the bot. Editing it by hand is safe for
> reading, but your edits get overwritten on the order's next change.

### How an update flows

1. Telegram POSTs to `/api/telegram-webhook`.
2. The `X-Telegram-Bot-Api-Secret-Token` header is compared in constant time
   against `TELEGRAM_WEBHOOK_SECRET`. Mismatch → 401.
3. `update_id` is inserted into `processed_updates`. Already there → 200, stop.
   Telegram redelivers when it does not get a timely 2xx, so this is what makes
   handling exactly-once.
4. `handleUpdate()` in `src/app.js` dispatches: **admin handlers → user handlers
   → fallback hint**.
5. Slow work (payment verification, sheet drain) is returned as `deferred` and
   run through `waitUntil` after the response.
6. `api/cron/tick.js` recovers anything that did not finish.

---

## 2. Running the bot

### Requirements

Node **22 or newer** (`engines` in `package.json`). Vercel picks this up
automatically.

### Commands

```bash
npm install
# Create .env.config for settings and .env.secret for credentials.
# Use .env.example as the complete variable checklist.
npm test                 # 91 tests, no network needed
npm run dev              # local long polling
npm run webhook:info     # what is registered right now
npm run webhook:set      # point Telegram at PUBLIC_BASE_URL
npm run webhook:delete   # back to local polling
```

### Applying migrations

```bash
supabase link --project-ref <ref>
supabase db push
```

Or paste `supabase/migrations/*.sql` into the SQL editor **in numbered order**.
All are idempotent — re-running is safe.

`supabase/optional/` is **not** applied by `db push`. Only run it deliberately.

### Polling vs webhook — read this before debugging silence

A bot token can do **one** of long polling or a webhook, never both.

| Symptom | Cause |
|---|---|
| `409 Conflict` in local logs | A webhook is registered for this token |
| Local bot receives nothing | Same |
| Production stops responding after someone ran `npm run dev` | They deleted the production webhook |

```bash
npm run webhook:info    # url empty = polling mode; url set = webhook mode
```

`npm run dev` refuses to start if a webhook exists, so this should be caught.

> **Use a separate test bot.** Create a second bot with @BotFather; put the
> production token only in Vercel Production, and the test token in your local
> `.env.secret` and in Vercel Preview. Right now there is only one bot, which means
> local development takes production offline. Fixing this is the single
> cheapest reliability improvement available.

---

## 3. Failure points

### 3.1 Vercel

**Webhook stops being delivered**

*Symptom:* bot silent, `pending_update_count` climbing.
*Confirm:* `npm run webhook:info`, read `last_error_message`.

| `last_error_message` | Meaning | Fix |
|---|---|---|
| `Wrong response from the webhook: 401` | Secret mismatch | Make `TELEGRAM_WEBHOOK_SECRET` in Vercel match, then `npm run webhook:set` |
| `404 Not Found` | URL wrong after a domain change | Re-run `webhook:set` with the new `PUBLIC_BASE_URL` |
| `SSL error` / `Connection timed out` | Deployment down, or Deployment Protection blocking Telegram | Disable protection for the preview, or use a production domain |
| `503` | Supabase unreachable (see 3.4) | Fix Supabase; Telegram retries automatically |

Telegram retries pending updates once the endpoint recovers. To discard a
backlog: `node scripts/set-webhook.js set --drop-pending`.

**Function timeouts** (`FUNCTION_INVOCATION_TIMEOUT`)

`maxDuration` is 300s in `vercel.json`. `WORKER_TIME_BUDGET_MS` (240s) makes
workers stop and release jobs *before* that. If you raise one, raise both, and
keep the budget at least 60s below the duration.

**Env vars changed but nothing happened**

Vercel injects environment variables at **build** time. Changing one in the
dashboard does nothing until you **redeploy**. Check `/api/health` — it reports
what the running deployment actually sees.

**Scheduler silently stops**

*Symptom:* submissions stuck in `queued`, the Orders sheet lagging, the preorder
post going stale.
*Confirm:* cron-job.org's execution history; or `/api/cron/tick` by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick
```

cron-job.org disables jobs that fail repeatedly — check it is still enabled. If
you moved to pg_cron: `select * from cron.job_run_details order by start_time desc limit 20;`

**Preview deployments using the production bot**

Set the **test** token in Preview environment variables. Otherwise a preview
deploy competes with production for the same updates.

**Payment instruction image missing**

When `PAYNOW_UEN` or `PAYNOW_PROXY_NUMBER` is configured, `sendPaymentInstructions()`
in `src/handlers/admin.js` generates a PayNow QR per order (via
`src/services/paynowQr.js`) with the exact amount and order code baked in, and
tries to send it together with the example screenshot as one Telegram album
(`sendMediaGroup`) so the customer swipes between them. This QR is never
cached — the amount differs per order.

The fallback chain, each step only reached if the one before it fails:
1. Dynamic QR + example, as one album.
2. Dynamic QR alone (`sendPhoto`), with the example attempted separately and
   best-effort — a broken example image must never cost the customer their QR.
3. The configured static QR image sources, each retried the same way (album
   first, then alone). `vercel.json` has `includeFiles: "src/Payment_Instruction.*"`,
   and after the first successful send the Telegram `file_id` is cached in
   `bot_state` under `cache:payment_image_file_id` so the local file stops
   mattering.
4. Plain text with the amount, if no image could be sent at all.

A stale cached example `file_id` is retried once with a fresh upload of
`src/payment_example.png` before a QR candidate is given up on, so a bad
example cache entry alone can't sink delivery either.

### 3.2 Stale or stuck state

```sql
-- Locks that should have expired
select * from locks where expires_at < now();

-- Stuck carts
select * from carts where updated_at < now() - interval '1 day';

-- Everything the bot is currently remembering
select key, updated_at, expires_at from bot_state order by updated_at desc;
```

The sweeper clears all of these every minute. Manual cleanup:

```sql
delete from locks where expires_at < now();
delete from carts where telegram_user_id = <id>;
```

**Delivery mode looks stuck.** Its state is three `bot_state` keys:

```sql
select * from bot_state where key in
  ('delivery:sequencer', 'delivery:dingo_posts', 'delivery:preorder_post');
```

To reset it completely — this also **closes ordering**, because
`hasPreorderPost()` gates it on `delivery:preorder_post` existing:

```sql
delete from bot_state where key like 'delivery:%';
```

Then have an admin reopen Delivery Mode and post the preorder message again.

**An admin is stuck mid-prompt** (every message becomes a hall name):

```sql
delete from bot_state where key = 'admin:input:<telegram_id>';
```

Typing any `/command` also clears them out, since commands take precedence over
pending prompts.

### 3.3 Row-number-as-ID in `FoodAndStock` and `Hall`

**This is the most fragile thing in the system.** An item's ID *is* its
spreadsheet row number. Nothing else identifies it.

Deleting, inserting or sorting rows renumbers everything below, so:

- open carts point at the wrong item
- delete buttons in an open admin menu target the wrong row
- `food_sheet_row_id` / `hall_sheet_row_id` in Supabase stop matching the sheet

Partial mitigations already in place:

- **Carts record the item name when it is added**, and `findCartMismatch` in
  `src/services/cartStore.js` re-checks it at checkout. If a row shifted, the
  customer is told the menu changed and asked to start again, rather than being
  charged for whatever food moved into that row. This closes the one failure
  mode that actually costs a customer money.
- **Delete buttons carry a hash of the item name**
  (`createCallbackItemToken` in `src/handlers/admin.js`) and refuse to fire if
  the name at that row no longer matches.
- **Orders snapshot the item name and price**, so past orders always read
  correctly however the sheet changes afterwards.
- **Restocking matches on row id and falls back to name**
  (`restockOrder` in `src/services/orderActions.js`).

None of these fix the underlying design — they contain its consequences. A
mismatch is logged as `cart_item_mismatch`; seeing those in the logs means
someone is editing the sheet during a live run.

**Rules for staff:**

1. Never delete or reorder rows during an active preorder run.
2. To retire an item, set its stock to `0` rather than deleting the row.
3. Add new items at the **bottom**.
4. Never sort the sheet.

### 3.4 Supabase

**Free projects pause after 7 days of inactivity.** This takes the whole bot
down — and pg_cron stops too, so the database cannot wake itself.

*Symptom:* `/api/health` shows `supabase.ok: false`; the webhook returns 503 and
`pending_update_count` climbs.
*Fix:* restore from the Supabase dashboard.
*Prevention:* the cron-job.org tick runs every minute and touches the database,
which keeps it active. If you ever remove that job, add a keep-alive.

Other things to watch:

- **Limits:** 500 MB database, 1 GB storage. Receipts dominate storage; check
  with `select pg_size_pretty(pg_database_size(current_database()));`
- **Backups:** the free tier's backups are limited. Take your own:
  `supabase db dump -f backup.sql`
- **Key rotation:** rotate the service-role key in the dashboard, update
  `SUPABASE_SERVICE_ROLE_KEY` in Vercel, then **redeploy**.
- **Never disable RLS.** Every table has RLS on with no policies, so the anon
  key can read nothing. Only the service-role key, used server-side, gets
  through. Disabling RLS would expose customer data to anyone with the public
  anon key.

### 3.5 Google service account

| Problem | Symptom | Fix |
|---|---|---|
| Sheet no longer shared | `The caller does not have permission` | Re-share the spreadsheet with `GOOGLE_SHEETS_CLIENT_EMAIL` as Editor |
| Key rotated / expired | `invalid_grant` | Generate a new key, update `GOOGLE_SHEETS_PRIVATE_KEY`, redeploy |
| Newline escaping wrong | `error:1E08010C:DECODER routines::unsupported` | The key must contain real newlines. In `.env.secret` use one line with `\n` escapes inside double quotes; `src/config.js` converts them. In the Vercel dashboard paste the real multi-line key. |
| Quota exceeded | `429` in `sheet_sync_failed` logs | The outbox backs off automatically. Sustained 429s mean too many writes — raise the drain batch interval. |

```sql
-- Orders whose sheet row never synced
select order_code, sheet_sync_error, updated_at
from orders where sheet_sync_error is not null order by updated_at desc;
```

Force a full re-sync:

```sql
update orders set sheet_synced_at = null where created_at > now() - interval '7 days';
```

The reconciler re-queues them within a minute.

### 3.6 Staff editing the `Orders` tab

Rows are matched on the **Order Code** column (L). `findRowByOrderCode()` in
`src/services/sheetMirror.js` re-reads that column and verifies the cached row
still holds the expected code before writing, so sorting is survivable —
slower, but safe.

What genuinely breaks it:

- **Deleting the Order Code column** — no order can be matched; every change
  appends a new row instead.
- **Renaming headers** — cosmetic only; the code uses positions, not names.
- **Deleting rows** — that order appends fresh on its next change.

`ensureHeaders()` only ever *adds* missing right-hand headers; it never rewrites
existing ones.

### 3.7 Gemini

| Problem | Symptom | Fix |
|---|---|---|
| Model renamed or retired | every verification errors, all receipts flagged | Update `GEMINI_MODEL`, redeploy, run `npm test` |
| Key expired / billing off | same | New key from AI Studio → `GEMINI_API_KEY` → redeploy |
| Rate limited | slow notices, retries, jobs lingering `queued` | Lower `GEMINI_MAX_CONCURRENCY`, or raise `GEMINI_RPM` on a paid tier |
| Primary model's daily quota exhausted | `gemini_fallback_triggered` warn logs; check `payment_submissions.gemini_model` to see which model actually answered | Nothing, by design — see below. If it's still not enough, raise the free-tier limit on a paid plan, or point `GEMINI_FALLBACK_MODEL` at a model with more daily headroom |
| SDK breaking change | build or runtime errors in `geminiClient.js` | Pin the old version, then migrate deliberately |

**A 429 on the primary model doesn't wait it out.** `geminiClient.js` tries
`GEMINI_FALLBACK_MODEL` (default a Flash Lite model, which gets a much higher
free-tier daily quota) immediately when the primary model reports a quota/rate
limit error, rather than burning `VERIFY_MAX_ATTEMPTS` retries against a model
that will not recover until its daily reset. Every other retryable error
(timeout, 5xx, overload) still backs off and retries the *same* model, since
those genuinely are transient. Set `GEMINI_FALLBACK_MODEL=` (empty) to disable
this and go back to plain retries.

**When Gemini is completely down, ordering still works.** Every receipt is
flagged to admins and nothing is auto-approved. Customers see "an admin will
review it shortly." Degraded, never broken — this is deliberate.

Cost: watch usage in AI Studio. One verification is roughly one image plus a
few hundred tokens.

### 3.8 Bank apps changing their receipt layout

DBS, OCBC, UOB and the rest redesign periodically. That can suddenly raise flag
rates or break date parsing.

```sql
-- Flag rate by bank over the last week
select bank_app,
       count(*) as total,
       count(*) filter (where outcome = 'auto_approved') as approved,
       round(100.0 * count(*) filter (where outcome != 'auto_approved') / count(*), 1) as flag_pct
from payment_submissions
where received_at > now() - interval '7 days'
group by bank_app order by total desc;
```

A single bank spiking means its layout changed. To fix: read `raw_extraction`
for a few of them, add the new date format to `RECEIPT_DATETIME_FORMATS` in
`src/utils/time.js`, add a test case to `test/time.test.js`, and deploy.

### 3.9 Banks that show no reference number

Some receipts genuinely have none. Those always come back
`MISSING_REFERENCE` → flagged → manual Accept/Reject. That is intentional: the
reference is the replay guard, and without it the same screenshot could pay for
several orders.

If this becomes common for one bank, the options are to accept the manual
workload, or to fall back to the image hash alone — which is weaker, because
re-screenshotting produces a different hash.

### 3.10 PayNow details changing

If the UEN, business name or proxy number changes, **every payment flags as
`RECIPIENT_MISMATCH`** until you update:

- `PAYNOW_UEN`
- `PAYNOW_RECIPIENT_NAMES`
- `PAYNOW_RECIPIENT_ALIASES`
- `PAYNOW_PROXY_NUMBER`

…in Vercel, then **redeploy**. Add the old name to the aliases for a week so
in-flight payments still verify.

**Checklist if the business changes:** PayNow details above · `DINGO_CHANNEL_ID`
if the channel moves · the tagged admin (Manage Admins → Set Admin to Tag) ·
admin IDs in the `Settings` sheet.

### 3.11 Time and timezone

Every rule uses `Asia/Singapore`, always named explicitly — never the server's
local zone, which is UTC on Vercel and would shift every window by 8 hours.

| Setting | Too low | Too high |
|---|---|---|
| `PAYMENT_MAX_AGE_MINUTES` (30) | Genuine payments flag as `TIMESTAMP_TOO_OLD` | Old receipts become reusable |
| `PAYMENT_CLOCK_SKEW_MINUTES` (5) | Bank clock drift flags valid payments | Widens the replay window |
| `PAYMENT_WINDOW_MINUTES` (2) | Slow bank apps lose people's orders | Stock sits reserved longer |

> **2 minutes is tight.** If customers complain about expiries, raise it to 5.
> The deadline is judged on when they *sent* the screenshot, so a slow check
> never costs them the order — but a slow *banking app* can.

### 3.12 Telegram

- **Token regenerated** → update `TELEGRAM_BOT_TOKEN`, redeploy, `npm run webhook:set`.
- **Bot loses channel rights** → delivery posts fail with "not enough rights".
  Re-add it as an administrator of `DINGO_CHANNEL_ID` with post/edit/delete.
- **Edit and delete windows** — messages can only be deleted for about 48 hours.
  "Finish Delivery" on a very old run may leave posts behind; delete by hand.
- **File size** — the Bot API caps downloads at 20 MB. A larger receipt document
  fails to download and flags for review.
- **`message is not modified`** — harmless, handled everywhere, safe to ignore.

### 3.13 The monkey-patched `sendMessage` / `sendPhoto`

`instrumentSendMethods()` in `src/app.js` wraps both methods to record the newest
message id per admin chat, which is how the admin menu decides whether it can
edit in place or must repost to stay at the bottom.

It depends on both methods resolving to the sent `Message` object. **After any
`node-telegram-bot-api` upgrade, test:** open `/adminmenu`, send a few messages,
tap a menu button, and confirm the menu reposts to the bottom rather than
staying stranded above.

### 3.14 Concurrency and overselling

Stock deduction runs inside a Postgres lease lock (`order:confirm`, see
`withLock` in `src/services/stateStore.js`). Two customers confirming the last
item from different instances serialise correctly.

**Direct spreadsheet edits bypass this entirely.** Google Sheets has no
transactions, so an admin typing a new stock number while an order is confirming
can overwrite the deduction.

*Spotting an oversell:* the sheet shows stock `0` or negative while orders exist
that were never restocked.

```sql
select order_code, status, hall_name_snapshot, total_cents, created_at
from orders where created_at > now() - interval '1 day' order by created_at;
```

*Fix:* count what was genuinely sold and correct the sheet by hand.
*Prevention:* edit stock through the admin menu, not the spreadsheet, during a
run.

**Payment verification also runs under a lease**, on `payment_submissions.locked_until`/`locked_by`. Both entry points must claim a submission before touching it: the scheduled worker via `claimNextSubmission()`, and the synchronous in-request path (triggered by the customer's screenshot, run via `waitUntil`) via `claimSubmissionById()` inside `processSubmission()` itself. A freshly-submitted receipt is immediately claimable (queued, unlocked, due now by default), so without the synchronous path also claiming it, a scheduled tick landing in that same window could run a second, fully independent verification pass on it concurrently - each hitting Gemini separately and potentially disagreeing on the outcome (one flagging to admins, the other auto-approving). If you ever add a third way to reach `processSubmission()`, it must claim first too (pass `alreadyClaimed: true` only if the caller already holds the lease).

### 3.15 Stuck orders and submissions

```sql
-- Orders that have sat mid-verification too long
select order_code, status, updated_at
from orders
where status in ('verifying_payment', 'payment_flagged')
  and updated_at < now() - interval '30 minutes'
order by updated_at;

-- Submissions that are not progressing
select id, order_id, outcome, attempt_count, next_attempt_at, locked_until, last_error
from payment_submissions
where outcome in ('queued', 'processing')
order by received_at;
```

**Requeue one submission:**

```sql
update payment_submissions
set outcome = 'queued', locked_by = null, locked_until = null, next_attempt_at = now()
where id = '<submission-id>';
```

**Release a stuck order to manual review:**

```sql
update orders set status = 'payment_flagged' where order_code = 'DG20260916-7';
insert into order_status_history (order_id, from_status, to_status, actor, reason)
select id, 'verifying_payment', 'payment_flagged', 'system', 'Manual intervention'
from orders where order_code = 'DG20260916-7';
```

Then have an admin Accept or Reject from their direct message.

### 3.16 Duplicates and replay

```sql
-- Recent duplicate rejections and what they collided with
select ps.id, o.order_code, ps.received_at, ps.duplicate_of_submission_id
from payment_submissions ps join orders o on o.id = ps.order_id
where ps.outcome = 'duplicate_rejected'
order by ps.received_at desc limit 20;

-- Customers trying repeatedly
select c.telegram_user_id, c.telegram_username, count(*) as attempts
from payment_submissions ps join customers c on c.id = ps.customer_id
where ps.outcome = 'duplicate_rejected' and ps.received_at > now() - interval '24 hours'
group by 1, 2 having count(*) >= 3;
```

To compare the two images, get signed URLs with
`createReceiptSignedUrl(storagePath)` from `src/services/orderRepository.js`.
Both `storage_path` values are on the submission rows.

---

## 4. Runbooks

### The bot is not responding

1. `curl https://<app>/api/health` — checks config, Supabase, webhook.
2. `npm run webhook:info` — read `last_error_message`, watch `pending_update_count`.
3. Vercel → Deployments → Runtime Logs. Search `webhook_handler_failed`.
4. If `supabase.ok: false` → §3.4. If 401 → secret mismatch, §3.1.

### Payments are not being verified

1. Any submissions stuck? Query in §3.15.
2. Is the scheduler running? §3.1.
3. `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick`
4. Search logs for `gemini_request_failed` and `verification_failed`.
5. Gemini key/quota → §3.7.

### Everything is being flagged

Check the reason codes — they tell you immediately:

```sql
select unnest(outcome_reasons) as reason, count(*)
from payment_submissions
where received_at > now() - interval '1 day'
group by 1 order by 2 desc;
```

- `RECIPIENT_MISMATCH` dominating → PayNow details changed, §3.10
- `TIMESTAMP_*` dominating → clock or window settings, §3.11
- `GEMINI_VERIFICATION_FAILURE` dominating → Gemini is down, §3.7
- One bank dominating → layout change, §3.8

### The sheet is not updating

1. `select * from sheet_sync_outbox order by next_attempt_at;` — backed up?
2. `select order_code, sheet_sync_error from orders where sheet_sync_error is not null;`
3. Service account still has access? §3.5
4. Force re-sync: §3.5

### A customer says they paid but the order shows unpaid

```sql
select o.order_code, o.status, ps.outcome, ps.outcome_reasons,
       ps.extracted_amount_cents, ps.extracted_txn_at, ps.storage_path
from orders o left join payment_submissions ps on ps.order_id = o.id
where o.order_code = 'DG20260916-7';
```

- No submission → they never sent it, or it went to a different order.
- `flagged` → it is waiting in an admin's direct messages. Accept it there.
- `duplicate_rejected` → they resent an earlier receipt; §3.16.
- Wrong `extracted_amount_cents` → view the image (§3.16) and decide manually.

### A refund or dispute needs evidence

Everything is retained permanently. Get `storage_path` and `raw_extraction` from
`payment_submissions`, then a signed URL via `createReceiptSignedUrl()`.
`order_status_history` gives the full timeline including who decided what.

### Delivery mode got stuck

See §3.2. Reset the `delivery:*` keys, then reopen Delivery Mode and repost the
preorder message — ordering stays closed until that post exists.

### Moving to a new Vercel project or domain

1. Set all environment variables in the new project.
2. Deploy.
3. `PUBLIC_BASE_URL=https://new-domain npm run webhook:set`
4. `npm run webhook:info` to confirm.
5. **Update the cron-job.org URL** — easy to forget, and the symptom is jobs
   quietly never running.

### Rolling back a bad deploy

Vercel → Deployments → the previous one → **Instant Rollback**.

**This rolls back code only.** Database migrations are *not* reverted. If the
bad deploy added a migration, the old code still runs against the new schema —
usually fine, since migrations here are additive. Never write a destructive
migration without checking the currently-deployed code can tolerate it.

---

## 5. Routine maintenance

**Weekly**

```sql
select outcome, count(*) from payment_submissions
where received_at > now() - interval '7 days' group by 1 order by 2 desc;

select count(*) from orders where sheet_sync_error is not null;
```

Plus: confirm `/api/health` is green, and that cron-job.org shows recent runs.

**Monthly** — Gemini usage and cost in AI Studio · `npm outdated` and
`npm audit` · storage usage (§3.4) · take a database backup.

**Per semester** — halls still correct · admin list in `Settings` still current
· PayNow details still correct · rotate `CRON_SECRET` and
`TELEGRAM_WEBHOOK_SECRET` (redeploy, then `webhook:set`).

---

## 6. Making common changes safely

**Verification thresholds** — environment variables only
(`PAYMENT_MAX_AGE_MINUTES`, `PAYMENT_CLOCK_SKEW_MINUTES`,
`PAYMENT_WINDOW_MINUTES`, `MAX_INCOMPLETE_ATTEMPTS`). Change in Vercel,
**redeploy**. No code change.

**A new accepted payee name** — append to `PAYNOW_RECIPIENT_ALIASES`, redeploy.
Names are normalised (lowercased, punctuation and `PTE LTD` stripped), so only
genuinely different spellings need adding.

**A new reason code** — add to `REASONS` in `src/services/paymentRules.js`; add
it to the right precedence list in `decideOutcome`; add a test in
`test/paymentRules.test.js`; decide what the customer sees in
`src/services/paymentVerifier.js` `MESSAGES`; and add it here.

**A new order status** — add to the `order_status` enum in a **new** migration;
add to `ALLOWED_TRANSITIONS` in `src/services/orderRepository.js`; add a label to
`STATUS_LABELS` in both `src/handlers/user.js` and `src/services/sheetMirror.js`;
add a `PAYMENT_STATUS` entry; the tests in `test/sheetMirror.test.js` assert every
status has both, so they will fail until you do.

**A new Orders column** — append to `HEADERS` in `src/services/sheetMirror.js`
(**right-hand side only**), add the value in `buildRow`, update `LAST_COLUMN`,
update the test asserting the header list.

**Swapping the Gemini model** — change `GEMINI_MODEL`, redeploy, run `npm test`,
then verify against real receipts from at least two different banks.

**A new receipt test fixture** — copy `raw_extraction` from a real submission
into a case in `test/paymentRules.test.js`. Never commit the image itself.

---

## 7. Useful queries

```sql
-- Today's orders by status (Singapore day)
select status, count(*) from orders
where created_at >= (date_trunc('day', now() at time zone 'Asia/Singapore')
                     at time zone 'Asia/Singapore')
group by 1 order by 2 desc;

-- Flag rate by day
select date_trunc('day', received_at at time zone 'Asia/Singapore')::date as day,
       count(*) as total,
       count(*) filter (where outcome = 'auto_approved') as auto,
       round(100.0 * count(*) filter (where outcome = 'auto_approved') / count(*), 1) as auto_pct
from payment_submissions group by 1 order by 1 desc limit 14;

-- Everything about one order
select o.*, ps.outcome, ps.outcome_reasons
from orders o left join payment_submissions ps on ps.order_id = o.id
where o.order_code = 'DG20260916-7';

-- Find a payment by its bank reference
select o.order_code, ps.outcome, ps.received_at from payment_submissions ps
join orders o on o.id = ps.order_id
where ps.reference_normalized = upper(replace(replace('<ref>', '-', ''), ' ', ''));

-- Revenue today
select sum(total_cents) / 100.0 as revenue_sgd from orders
where status in ('paid', 'served')
  and created_at >= (date_trunc('day', now() at time zone 'Asia/Singapore')
                     at time zone 'Asia/Singapore');
```

---

## 8. Security and data handling

| Secret | Lives in | Rotate by |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel env | @BotFather → `/revoke` → update → redeploy → `webhook:set` |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel env | Invent a new one → update → redeploy → `webhook:set` |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env | Supabase dashboard → update → redeploy |
| `GOOGLE_SHEETS_PRIVATE_KEY` | Vercel env | New service-account key → update → redeploy |
| `GEMINI_API_KEY` | Vercel env | AI Studio → update → redeploy |
| `CRON_SECRET` | Vercel env + cron-job.org | Update **both**, redeploy |

Rules that must not be relaxed:

- **Never log PII.** `src/utils/logger.js` redacts by key name, but do not rely
  on it — log identifiers and reason codes, never names, phone numbers,
  addresses or `raw_extraction`.
- **The receipts bucket stays private.** Access is only ever through short-lived
  signed URLs.
- **RLS stays on** for every table.
- **Never commit `.env.config` or `.env.secret`.** `.gitignore` covers both.

**Access:** Supabase and the Vercel dashboard should be limited to whoever
maintains the bot. The Google Sheet can be shared more widely since it holds no
payment evidence — but note the `Orders` tab does contain customer names and
order history.

**PDPA and retention.** Receipts contain names, bank details and phone numbers.
Suggested policy: keep payment evidence 12 months for disputes and accounting,
then delete. **Deletion is not implemented** — `payment_submissions` has a
trigger blocking `DELETE` precisely so nobody removes evidence casually. Decide
the policy, then write a deliberate job that archives and drops the storage
objects.

> **The Gemini free tier trains on submitted content.** Receipts are personal
> data. This is acceptable for a portfolio demo with internal test payments; it
> is **not** acceptable for real customer payments. Move to a paid key first.

---

## 9. Known limitations and tech debt

An honest list.

1. **Config still lives in Google Sheets.** Admins, food, stock and halls are
   read from the sheet on every relevant request. It has no transactions, so
   concurrent edits can silently overwrite each other.
   *Improvement:* move stock into Postgres and mirror it out, inverting the
   current direction.

2. **Row numbers are item IDs.** §3.3. Still the most likely cause of a
   confusing production bug. Carts now detect a shifted row at checkout and
   refuse, so nobody is charged for the wrong food, but open admin menus and the
   `food_sheet_row_id` snapshots stored on orders can still point at the wrong
   row.
   *Improvement:* add a stable ID column to `FoodAndStock` and `Hall` and key on
   that instead. Worth doing once the system is proven working end to end — not
   before, since it touches the menu, carts, admin buttons and the schema at
   once.

3. **Sheets stock has no transactional guarantee.** The lease lock serialises
   the bot's own writes, but a human editing the sheet bypasses it entirely.
   *Improvement:* same as (1).

4. **The preorder post refreshes on events plus once a minute**, not every 5
   seconds. Spreadsheet edits take up to a minute to appear. Bot-driven changes
   are instant.
   *Improvement:* acceptable as-is; shorten the cron interval if it matters.

5. **One bot token for development and production.** Local development takes
   production offline. *Improvement:* create a test bot — 2 minutes of work,
   the highest-value item on this list.

6. **Depends on an external per-minute scheduler.** If cron-job.org disables the
   job, recovery work stops silently. The main paths still work via `waitUntil`.
   *Improvement:* monitor the job, or move to Vercel Pro crons.

7. **No staff-group integration.** Flagged payments go to individual admin DMs,
   so several admins may act on the same one — the conditional status
   transitions make that safe, but it is noisy.
   *Improvement:* a shared group with a single interactive card.

8. **The verifier pipeline has no automated integration test.** The rules engine
   is thoroughly unit tested, but the end-to-end path needs a live Telegram,
   Supabase and Gemini, so it is covered by `docs/TESTING.md` by hand.
   *Improvement:* inject the Gemini client and repository to allow mocking.

9. **Cart quantities can only increase.** There is no decrement or
   remove-one-item — only add and Clear Cart. This predates this upgrade.
   *Improvement:* add −/+ buttons per line.

10. **No categories or add-ons.** The schema has nullable `category_snapshot`
    and `addons` columns ready, but no UI builds them.

11. **`markOrderServed` allows serving an unpaid order.** Deliberate — staff
    physically hand food over and should not be blocked — but it means an unpaid
    order can reach `served`. The payment state stays visible in the sheet.

---

## 10. Change log

**2026-09-16 — Supabase, AI payment verification, Vercel**

- Orders, customers and payments moved from in-memory objects to Supabase.
- Payment screenshots verified with Gemini Flash extraction plus a deterministic,
  unit-tested rules engine. Replay prevented by database unique indexes.
- Long polling replaced with a secret-verified webhook with `update_id` dedupe.
- All cross-request state moved out of module memory; timers replaced with
  event-driven refresh plus a scheduled worker.
- Google Sheets `Orders` tab became a one-row-per-order live mirror; the
  original eleven columns were preserved.
- Added `/orders`, order codes (`DG20260916-7`), and enforced payment expiry.
- Admin console, food/stock, halls, settings and delivery mode behaviour
  unchanged.

---

> **Keep this file current.** Any change touching payments, storage, the sheet
> layout, order statuses or environment variables must update this file in the
> same commit. A handbook that has drifted from the code is worse than none,
> because it will be trusted.
