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
| Customers, incl. phone number | **Supabase** | `customers` (`phone_number`, collected at first Confirm Order) |
| Payment receipts and verdicts | **Supabase** | `payment_submissions` + `payment-receipts` bucket |
| Carts | **Supabase** | `carts` |
| Hall blocking | **Supabase** | `halls_state` |
| Delivery sequencer, admin prompts, menu positions, caches | **Supabase** | `bot_state` |
| Food, prices, stock | **Supabase** | `menu_items` (edited in the bot: Settings > Manage Food Items - add, delete, edit stock, edit price) |
| Admin IDs, tagged admin | **Google Sheets** | `Settings` (IDs col A, tagged admin B2) |
| Halls | **Google Sheets** | `Hall` (A name, B short name) |
| Food tab | **mirror only** — never edit | `FoodAndStock` (A name, B price, C stock) |
| Orders tab | **mirror only** — never edit | `Orders` |
| Today's Orders tab | **mirror only** — never edit | `Today's Orders` |

> The `Orders`, `Today's Orders` and `FoodAndStock` tabs are written *by* the
> bot. Editing them by hand is safe for reading, but your edits get overwritten
> on the next change - for `FoodAndStock`, that means **a stock number typed in
> the sheet does nothing to the bot, and is overwritten the next time the menu
> changes** (the mirror compares the database with what it last wrote, not with
> the sheet's contents, so an untouched menu leaves a hand edit sitting there).
> Change food, prices and stock through the bot.
>
> The food tab is copied from Supabase by `src/services/menuSheetSync.js`, once
> a minute and only when something changed, so it can lag a stock change by up to
> a minute. It never blanks the tab: while `menu_items` is empty it does nothing.

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

### Importing the menu (once, after migration 0007)

Migration `0007_menu_items.sql` creates `menu_items` empty. Copy the existing
`FoodAndStock` tab into it once, before the first deploy, with
`npm run menu:import` (see README, "Import the menu"). The mirror does nothing
while `menu_items` is empty, so an un-imported sheet is never blanked.

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

**Get ready / coming isn't posting for the next hall.** These two posts are
automatic now (see `src/handlers/admin.js`: `autoAdvanceDeliveryStage`,
`postDingoUpdate`), fired off the *current* hall's serve progress - not a
button, so there is nothing to tap if it's stuck. Check:

```sql
-- Serve progress for the current hall tonight (service day starts
-- SERVICE_DAY_START_HOUR, default 3pm - see src/services/todaySheet.js)
select status, count(*) from orders
where hall_name_snapshot = '<hall>'
  and created_at >= <service day start, UTC>
  and status in ('awaiting_payment','verifying_payment','payment_flagged','paid','served')
group by status;
```

- get-ready needs 2/3 served; coming needs all of them served.
- An order stuck in `payment_flagged` or `verifying_payment` that will never
  get marked served (e.g. the customer vanished) holds the hall below
  threshold forever. Resolve it the normal way - reject it, or serve it
  anyway if the food went out (`markOrderServed` allows serving unpaid, see
  §9) - either way it stops blocking the count: a rejected order drops out of
  the denominator entirely, a served one adds to the numerator.
- **Send `/skip`** to force-post whatever's queued next regardless of
  threshold - the manual override for when this needs to move faster than
  serve progress allows, or when it should have fired automatically and
  didn't. See `handleSkipCommand` in `src/handlers/admin.js`.
- If it silently stopped mid-cascade (e.g. a hall nobody ordered from should
  have cascaded straight through get-ready **and** coming for the hall after
  it, but didn't), search logs for `auto_advance_post_failed` - it names the
  hall, the mode it was trying to post, and why (`hall_not_found` is the
  usual one: a hall's row shifted in the sheet between when it was queued and
  when this ran - see §3.3). `locked`/`stale` are not logged; both are
  harmless races where whatever holds the lock drives it forward instead.
- The auto-advance guard that skips the **last** hall in the list
  (`hallIndex === halls.length - 1` in `autoAdvanceDeliveryStage`) only ever
  applies to the *last* hall - a hall in the middle of the list with zero
  orders should still cascade normally. If it doesn't and there's no
  `auto_advance_post_failed` log line either, that's a bug, not this
  guard - check `getHallServeProgress`'s result for that hall directly.

**An admin is stuck mid-prompt** (every message becomes a hall name):

```sql
delete from bot_state where key = 'admin:input:<telegram_id>';
```

Typing any `/command` also clears them out, since commands take precedence over
pending prompts.

**A customer is stuck being asked for a phone number** (every message they
send gets read as a phone number attempt, e.g. because they typed something
odd and now can't get past it):

```sql
delete from bot_state where key = 'user:awaiting_phone:<telegram_id>';
```

Typing any `/command` (e.g. `/start`) also clears this, same as the admin
prompt above.

**An admin is stuck mid drop-off-photo relay** (every photo they send to the
bot gets forwarded to whichever customer they last tapped "Drop Remaining
Items Off" for, instead of doing anything else):

```sql
delete from bot_state where key = 'admin:dropoff_photo:<telegram_id>';
```

This state also expires on its own after 15 minutes.

**The "we are here" hall list looks stale** (a customer's order doesn't show,
or shows as still active after being served/dropped off elsewhere). It reads
from a 20-minute cache, refreshed on every relevant change:

```sql
select * from bot_state where key = 'delivery:serve_cache:<hall name>';
```

Delete the row to force the next tap to re-query Supabase directly:

```sql
delete from bot_state where key = 'delivery:serve_cache:<hall name>';
```

### 3.3 Row-number-as-ID in `Hall`

**Food no longer has this problem.** Menu items are rows in `menu_items` with a
real, permanent `id`, so adding or deleting an item never renumbers another. It
still applies to **halls**, which live in the `Hall` tab: a hall's ID *is* its
spreadsheet row number, and nothing else identifies it.

Deleting, inserting or sorting hall rows renumbers everything below, so:

- open hall buttons can point at the wrong hall
- `hall_sheet_row_id` in Supabase stops matching the sheet

Mitigations in place:

- **Hall buttons carry a hash of the hall name**
  (`createCallbackItemToken`) and refuse to fire if the name at that row no
  longer matches.
- **Orders snapshot the hall name**, so past orders read correctly however the
  sheet changes afterwards.
- **The hall list is cached for 10 minutes** per instance
  (`getHallsOrThrow` in `src/services/googleSheets.js`). It is re-read fresh
  when the preorder is posted and on the Manage Halls screens, so a change made
  directly in the sheet shows up by the next preorder at the latest.

The same applies to a cart item: carts record the item name when it is added,
and `findCartMismatch` in `src/services/cartStore.js` re-checks it at checkout,
so an item deleted (or renamed) while someone was ordering is refused rather
than charged. A mismatch is logged as `cart_item_mismatch`.

**Rules for staff (halls):**

1. Never delete or reorder hall rows during an active preorder run.
2. Add new halls at the **bottom**.
3. Never sort the sheet.

### 3.4 Supabase

**Free projects pause after 7 days of inactivity.** This takes the whole bot
down — and pg_cron stops too, so the database cannot wake itself.

*Symptom:* `/api/health` shows `supabase.ok: false`; the webhook returns 503 and
`pending_update_count` climbs.
*Fix:* restore from the Supabase dashboard.
*Prevention:* the cron-job.org tick runs every minute and touches the database,
which keeps it active. If you ever remove that job, add a keep-alive.

Other things to watch:

- **Limits:** 500 MB database, 1 GB storage. Receipts dominate storage (old
  ones are deleted automatically, see "PDPA and retention"); check with
  `select pg_size_pretty(pg_database_size(current_database()));` and
  `select count(*), pg_size_pretty(sum((metadata->>'size')::bigint)) from storage.objects where bucket_id = 'payment-receipts';`
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
| Model renamed or retired | every verification errors, all receipts flagged | Update `GEMINI_MODELS` in `src/config.js`, redeploy, run `npm test` |
| Key expired / billing off | same | New key from AI Studio → `GEMINI_API_KEY` → redeploy |
| Rate limited | slow notices, retries, jobs lingering `queued` | Lower `GEMINI_MAX_CONCURRENCY`, or raise `GEMINI_RPM` on a paid tier |
| Primary model's daily quota exhausted | `gemini_fallback_triggered` warn logs; check `payment_submissions.gemini_model` to see which model actually answered | Nothing, by design — see below. If it's still not enough, raise the free-tier limit on a paid plan, or add a model with more daily headroom to `GEMINI_MODELS` in `src/config.js` |
| SDK breaking change | build or runtime errors in `geminiClient.js` | Pin the old version, then migrate deliberately |

**A 429 on a model doesn't wait it out.** The models are hardcoded, in order,
as `GEMINI_MODELS` in `src/config.js` (two Flash Lite models first, which get a
much higher free-tier daily quota, then 3.8 Flash as the last resort).
`geminiClient.js` moves to the next one immediately when a model reports a
quota/rate limit or overload error, rather than burning `VERIFY_MAX_ATTEMPTS`
retries against a model that will not recover until its daily reset. Each model
has its own quota, so every extra one adds headroom. Every other retryable
error (timeout, malformed response) still backs off and retries, since those
genuinely are transient. To disable this and go back to plain retries, leave a
single model in the list.

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

**Stock is protected by the database, not a lock.** Checkout deducts through
`deduct_menu_stock` (`supabase/migrations/0007_menu_items.sql`), one atomic
statement that locks the rows, checks that *every* item has enough, and only then
deducts - so two customers confirming the last item cannot both get it, a cart
with one short item deducts nothing at all, and nobody queues behind anybody
else. Stock also cannot go below zero: `menu_items.stock` has a `check (stock >=
0)`. Restocking (`restore_menu_stock`) and the "Reset Halls and Orders" baseline
restore (`restore_menu_baselines`) are single statements too.

The one lock left in checkout is **per customer** (`order:confirm:<telegram id>`,
see `LOCKS.confirmOrder` in `src/services/stateStore.js`). It only stops one
customer's double tap on Confirm from reading the same cart twice and placing two
orders.

*Spotting an oversell:* it cannot happen through the bot. If stock looks wrong,
compare against the orders that consumed it:

```sql
select order_code, status, hall_name_snapshot, total_cents, created_at
from orders where created_at > now() - interval '1 day' order by created_at;
```

*Fix:* set the right number in the bot (Settings > Manage Food Items > Edit
Stock). Note that a manual edit also moves that item's reset baseline
(`menu_items.baseline_stock`).

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

**A duplicate shows up as `error` / `GEMINI_VERIFICATION_FAILURE` instead of
`duplicate_rejected`.** This was a real bug (fixed 2026-09-18, see the change
log): the image-hash write at the start of verification had no catch around
its own unique-violation, so a genuine repeat screenshot threw straight into
the generic failure handler and got mislabeled as a Gemini failure. If you
ever see this again, check `src/services/paymentVerifier.js`'s
`handleDuplicateImage` and the try/catch around the `image_sha256` write in
`processSubmission` — a future refactor of that evidence step could
reintroduce the same gap.

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

**Swapping the Gemini model** — change `GEMINI_MODELS` in `src/config.js`, redeploy, run `npm test`,
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
then delete. The bot currently deletes receipt **images** 30 days after upload
(`RECEIPT_RETENTION_DAYS`, `0` keeps them forever) to stay inside the free
1 GB storage limit. This runs in the minute-by-minute sweep and only touches
orders that are finished (paid, served, rejected, cancelled, expired) — never a
receipt still awaiting payment, being verified or flagged for review. The
`payment_submissions` rows are never deleted (a trigger blocks `DELETE`): the
extracted details, outcome and `image_sha256` stay, so the replay guard keeps
working; only the image file goes and `storage_path` is set to null. Stored
copies are also shrunk to a max of 2000px JPEG (Gemini still reads the
original), and an exact repeat of an image already on file is rejected before
it is uploaded. If you need the full 12 months, raise `RECEIPT_RETENTION_DAYS`
and watch storage usage.

> **The Gemini free tier trains on submitted content.** Receipts are personal
> data. This is acceptable for a portfolio demo with internal test payments; it
> is **not** acceptable for real customer payments. Move to a paid key first.

---

## 9. Known limitations and tech debt

An honest list.

1. **Halls and admin settings still live in Google Sheets.** Food and stock
   moved to Postgres (so checkout no longer touches Sheets or its 60-a-minute
   quota), but halls and the admin list are still read from the sheet. Halls are
   cached, so this costs little; it has no transactions, so concurrent edits can
   overwrite each other.
   *Improvement:* move halls and admins into Postgres too, the same way.

2. **Hall row numbers are hall IDs.** §3.3. Hall buttons carry a name hash and
   refuse a stale tap, but `hall_sheet_row_id` snapshots stored on orders can
   still point at the wrong row after a sheet edit.
   *Improvement:* give halls a real id, as `menu_items` has.

3. **The `FoodAndStock` tab is a delayed, one-way mirror.** It lags a stock
   change by up to a minute, and anything typed into it is overwritten.

4. **The preorder post refreshes on events plus once a minute**, not every 5
   seconds. Hall edits made directly in the spreadsheet take up to a minute to
   appear. Bot-driven changes, including all stock changes, are instant.
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
    order can reach `served`. The payment state stays visible in the sheet:
    for a served order, "Paid"/"Unpaid" follows `paid_at`. **Mark Paid** on
    such an order sets `paid_at` and keeps it `served`
    (`repo.recordPaymentOnServedOrder`) — `served` is terminal; moving it back
    to `paid` used to make it active again and re-list it for serving.

12. ~~No manual override for get-ready/coming.~~ **Resolved 2026-09-18**: any
    admin can send `/skip` to force-post whatever the sequencer currently has
    queued next (get-ready, coming, or here), regardless of serve progress.
    See `handleSkipCommand` in `src/handlers/admin.js` and §3.2 below.

13. **"2/3 served" counts orders, not individual food items.** An order with
    five items and an order with one both count as one unit of progress. If a
    hall's orders vary wildly in size this could feel off; nobody has reported
    it as a problem yet.

14. **No way to change a phone number once given.** `customers.phone_number` is
    set once, at the first Confirm Order that hits the gate, and there is no
    command to update it. A wrong number has to be fixed directly in Supabase:
    `update customers set phone_number = '...' where telegram_user_id = <id>;`

15. **Phone number validation is deliberately loose** (7-15 digits, whatever
    formatting stripped away - see `normalizePhoneNumber` in
    `src/handlers/user.js`). It will accept a number that is not actually
    reachable (transposed digits, a landline, etc); there is no verification
    step (no SMS OTP or similar).

16. **The drop-off photo relay exists because Telegram gives a bot no other
    option.** There is no way for a bot (or a `t.me/...` link) to open a real
    chat with someone else's account and pre-fill the message box - that
    capability simply doesn't exist in the Bot API or in Telegram's deep
    links. The admin sends the photo to the *bot*, which forwards it to the
    customer; see `handleAdminDropoffPhoto` in `src/handlers/admin.js`. If
    Telegram ever adds a real mechanism for this, it would remove a hop, but
    don't assume one exists without checking current docs.

17. **One photo relay in flight per admin.** `admin:dropoff_photo:<id>` holds
    at most one pending relay per admin telegram id - if an admin taps "Drop
    Remaining Items Off" for a second customer before sending a photo for the
    first, the second tap silently overwrites the first (the photo they then
    send goes to whoever they tapped last). Not a data-loss risk (nothing
    was marked yet), just a possible "sent it to the wrong person" mixup if
    an admin juggles two at once. Acceptable for now given they're normally
    done one at a time, standing at a hall.

18. **"Edit All Stock" batches its sold-out announcements to the end of the
    session, not real-time per item.** If an admin edits five items in one
    "Edit All Stock" run and two of them hit 0 partway through, both
    announcements (and the single repost) fire only once the whole session
    finishes - not the moment each one crosses to zero. A single-item stock
    edit announces immediately, since there's only one change in that flow.
    Deliberate (see the change log below), not a bug.

19. **No "back in stock" announcement.** Restocking an item - an admin
    raising its stock, or an order being rejected/expired restoring it - never
    posts anything, even if it was previously announced as sold out. Only
    the crossing *to* zero is covered. A natural symmetric addition if it's
    ever asked for.

---

## 10. Change log

**2026-09-18 — `/skip` command, and logging for a silent auto-advance failure**

- New `/skip` command (any admin): force-posts whatever the sequencer has
  queued next (get-ready, coming, or here) regardless of serve progress. Goes
  through the same `postDingoUpdate` a button tap or the automation itself
  uses, so it's lock-safe and still runs the block/customer-notify hooks. See
  `handleSkipCommand` in `src/handlers/admin.js`. Resolves known limitation
  #12 (no manual override existed for get-ready/coming since they stopped
  being buttons).
- Fixed: `autoAdvanceDeliveryStage`'s cascade could stop silently when a
  `postDingoUpdate` call inside it failed for a real reason
  (`hall_not_found`, `no_channel`, `send_failed`) - nothing was logged, so a
  hall stuck mid-cascade with no explanation was effectively undiagnosable.
  Now logs `auto_advance_post_failed` with the hall, target mode, and reason
  (`locked`/`stale` stay silent - both are harmless races, not failures).
- No schema changes.

**2026-09-18 — Fixed: a repeat receipt image was reported as a Gemini failure**

- Bug: sending the exact same screenshot twice (or reusing an old receipt for
  a different order) hit the partial unique index on `image_sha256` doing
  exactly its job - refusing a second live claim on that hash - but the write
  that triggered it had no catch for that specific violation. The exception
  fell through to the generic handler and got recorded (and shown to the
  customer, and forwarded to admins) as `outcome_reasons:
  ['GEMINI_VERIFICATION_FAILURE']`, as if the model itself had failed,
  instead of "this receipt was already used".
- Fix: that write in `processSubmission` (`src/services/paymentVerifier.js`)
  now catches the unique violation and resolves it through the new
  `handleDuplicateImage` - the evidence-stage counterpart to `applyOutcome`'s
  existing `DUPLICATE_REJECTED` branch. The customer now gets
  `MESSAGES.DUPLICATE` ("This receipt has already been used...") immediately,
  before any Gemini call is even made.
- `reference_normalized`-based duplicate detection (`claimAndRecord`) was
  never affected - it already had this handling. Only the earlier,
  image-hash check was missing it.
- No schema changes.

**2026-09-18 — Sold-out announcements**

- Any stock change that takes an item from having stock to having none now
  posts `🚫 {item} has been sold out!` to the Dingo channel (one message per
  item, even if several sell out in the same action) and replaces the live
  preorder post with a **fresh** one instead of the normal silent
  edit-in-place refresh - a plain edit doesn't notify channel subscribers.
  Covers checkout deductions, a single admin stock edit, and a whole "Edit
  All Stock" session (batched to the end of that session - see limitation
  #18). See `findNewlySoldOutItems` / `announceSoldOut` /
  `repostPreorderAvailability` / `refreshPreorderPostAfterStockChange` in
  `src/handlers/admin.js`.
- `handleConfirmOrder` in `src/handlers/user.js` now returns
  `{ order, stockChanges }` from its lock instead of just the order, so the
  caller (outside the lock) can decide silent-refresh vs. sold-out-repost.
  Nothing about the checkout flow itself changed.
- No schema changes.

**2026-09-17 — "Drop Remaining Items Off": collated totals + photo relay for no-shows**

- New button at the bottom of the hall phone-number list. Shows a collated
  per-item total of everything still uncollected (`collateRemainingItems`),
  then a `phone | handle` button per customer below it.
- Tapping a customer starts a photo relay (`admin:dropoff_photo:<id>` in
  `bot_state`, 15 min TTL): the admin's next photo is forwarded to the
  customer with a caption, then deleted from the admin's own chat, and every
  order it covers is marked `dropped_off` (same mechanism as the existing
  Served/Dropped off buttons - same customer notification path, same
  `order_status_history` reason, one photo covers all of a customer's
  remaining orders at that hall).
- Chosen over a direct `t.me/<username>` link because Telegram has no
  mechanism for a bot (or any link) to pre-fill someone else's chat, and a
  link-based approach would also silently fail for any customer without a
  public username. See limitation #16.
- Cache-sync fix: rejecting a payment and the expiry sweeper now also refresh
  a hall's cached serve list (they didn't before), closing the one real gap
  where the list could show an order that had actually been resolved
  elsewhere. The cache was never able to affect the underlying order data or
  the Served/Dropped off action itself - see the "Delivery mode" section of
  the README for why.
- No schema changes.

**2026-09-17 — Phone number collection, phone-grouped hall serve list**

- Customers give a phone number the first time they confirm an order
  (`customers.phone_number`, migration `0006_customer_phone_number.sql`);
  mandatory — Confirm Order is gated on it, see
  `handleConfirmOrder`/`requestPhoneNumber` in `src/handlers/user.js`.
- The "we are here" serve list groups by customer instead of one row per
  order, sorted by phone number, and shows phone + items on the button
  instead of a Telegram handle (`buildHallCustomerListKeyboard` in
  `src/handlers/admin.js`).
- Tapping a customer opens a submenu (their orders, handle, phone) with
  **Served** and **Dropped off** as distinct actions per order — different
  customer message and `order_status_history` reason for each, same
  underlying `served` status — plus **Back**.
- The order list behind the hall view is cached in `bot_state`
  (`delivery:serve_cache:<hall>`, ~20 min TTL) and refreshed on every relevant
  change, so opening a submenu costs no extra Supabase query in the common
  case.
- Schema change: `customers.phone_number` (nullable text). No other tables
  changed; `orders.status` still only ever reaches `served`, never a separate
  "dropped off" state.

**2026-09-17 — Automatic get-ready/coming, hall auto-closure**

- Manual "Block Hall" removed. `get ready` and `coming` now post themselves off
  hall serve progress (`orderStore.getHallServeProgress`, `src/handlers/admin.js`:
  `autoAdvanceDeliveryStage`), and a hall is closed to new orders the moment its
  `coming` post fires — no longer only once fully served.
- Customers with an open cart but no confirmed order for a just-closed hall are
  proactively notified and cleared out; anyone already mid-payment is untouched.
- Get-ready and coming now also DM every customer with an active order at that
  hall ("start heading down" / "come down now").
- `we are here` remains the only manual channel post. `Revert last blocked hall`
  and `Reset Halls` remain as manual overrides.
- No schema changes.

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
