# Dingo Post Form Bot

A Telegram bot that runs food preorder and delivery operations for Dingo Cafe
across several dorm halls, with AI-assisted PayNow payment verification.

Customers order through a Telegram chat. Admins confirm orders, run a delivery
round that posts announcements to a public channel, and manage the menu. Payment
screenshots are read automatically and either approved or sent to an admin.

- **Orders, customers and payments** live in Supabase (Postgres).
- **Settings, food, stock and halls** live in Google Sheets, where staff already
  edit them.
- **The Orders sheet tab** is a live mirror of Supabase, so the kitchen keeps the
  view it is used to.

---

## How it works

```
                    ┌──────────────┐
   customer ───────▶│              │
   admin    ───────▶│   Telegram   │
                    └──────┬───────┘
                           │ webhook (POST, secret header)
                           ▼
                 ┌─────────────────────┐
                 │ api/telegram-webhook│  dedupe on update_id
                 └──────────┬──────────┘
                            ▼
                     ┌─────────────┐
                     │  src/app.js │  admin → user → fallback
                     └──┬───┬───┬──┘
          ┌─────────────┘   │   └──────────────┐
          ▼                 ▼                  ▼
   ┌────────────┐   ┌──────────────┐   ┌──────────────┐
   │  Supabase  │   │ Google Sheets│   │ Dingo channel│
   │            │   │              │   │              │
   │ orders     │   │ Settings     │   │ preorder     │
   │ customers  │   │ FoodAndStock │   │ coming/here  │
   │ payments   │   │ Hall         │   └──────────────┘
   │ all state  │   │ Orders(mirror)│
   └─────┬──────┘   └──────────────┘
         │
         │  slow work via waitUntil, recovered by cron
         ▼
   ┌──────────────┐        ┌─────────────┐
   │ api/cron/tick│───────▶│ Gemini Flash│  extract only
   └──────────────┘        └─────────────┘
         ▲
         │ every minute
   ┌──────────────┐
   │ cron-job.org │
   └──────────────┘
```

### Customer flow

1. `/start` (or the channel's deep link) lists halls that are still open.
2. Picking a hall shows the menu, built live from `FoodAndStock`.
3. Tapping items builds a cart stored in Postgres.
4. **Confirm Order** re-checks stock, deducts it, creates the order, and sends it
   to every admin with Confirm / Reject buttons.
5. Once an admin confirms, the customer gets the PayNow instructions, the exact
   amount due, and a payment deadline.
6. They reply with a screenshot. The bot answers immediately, verifies in the
   background, and either confirms the payment or tells them an admin will look.
7. `/orders` shows their own order history, paginated.

### Admin console

`/adminmenu` opens a self-editing inline menu:

- **Manage Admins** — add, remove, and choose which admin is tagged in preorder posts
- **Manage Food Items** — add, delete, edit stock for one item or all of them
- **Manage Halls** — add and delete pickup halls
- **Delivery Mode** — the announcement sequencer and per-hall serve lists
- **Stats** / **Reload Settings**

Order Confirm/Reject and payment Accept/Reject arrive as direct messages.

### Delivery mode

Walks each hall through `preorder → coming → here`, then `get ready` for the next
hall, posting to `DINGO_CHANNEL_ID` and deleting superseded posts. Blocking a hall
closes ordering for it. **Finish Delivery** clears the channel posts and resets
the sequencer.

The live preorder post re-renders whenever something changes it through the bot,
and once a minute from the scheduler to catch edits typed straight into the
spreadsheet.

### Payment verification

**The model extracts; code decides.** Gemini only reports what is visible on the
screenshot. Every approve/flag/reject verdict comes from
[`src/services/paymentRules.js`](src/services/paymentRules.js), a pure function
covered by unit tests. Model output can never approve a payment by itself, and
text inside an image is treated as untrusted content, never instruction.

A receipt is auto-approved only if **all** of these hold:

| Check | Rule |
|---|---|
| Amount | at least the order total (overpaying is fine and recorded) |
| Recipient | UEN, display name, alias, or masked proxy matches |
| Transfer state | genuinely completed, not "Review", "Scheduled" or "Pending" |
| Timestamp | after the order, not in the future, within `PAYMENT_MAX_AGE_MINUTES` |
| Reference | present, and not already used by another submission |

Anything else goes to an admin via the existing Accept/Reject direct message.
Nothing is auto-approved when in doubt, and nothing ever fails silently — if
Gemini is unreachable, the receipt is flagged for a human.

Replay is prevented by **database unique indexes**, not application checks: a
reference or image hash can be held by only one live or approved submission.

---

## Running it locally

Requires **Node 22 or newer**.

```bash
npm install
# Create .env.config for settings and .env.secret for credentials.
# Use .env.example as the complete variable checklist.
npm test
npm run dev
```

`.env.example` lists every variable. Put credentials and tokens in
`.env.secret`; put all other values in `.env.config`. Both local files are
gitignored.

### A token cannot poll and use a webhook at the same time

This is the most common way to lose an afternoon. If a webhook is registered,
Telegram delivers updates there and local polling receives nothing.

```bash
npm run webhook:info     # what is currently registered
npm run webhook:delete   # switch back to local polling
```

`npm run dev` refuses to start if a webhook is registered, rather than sitting
there silently.

**Use a separate bot token for development.** Create a second bot with
@BotFather and put it in your local `.env.secret`. Otherwise deleting the webhook to
work locally takes production offline.

---

## Deploying to Vercel

### 1. Create the Supabase project

Choose the **Singapore** region to sit near the `sin1` functions.

Apply the migrations, either with the CLI:

```bash
supabase link --project-ref <your-ref>
supabase db push
```

…or by pasting each file in `supabase/migrations/` into the SQL editor in order.

Confirm afterwards that the `payment-receipts` bucket exists and is **private**.

### 2. Create the Vercel project

Import the repository, then set the environment variables from `.env.example`
under **Settings → Environment Variables**, separately for Production and
Preview. Use the **test** bot token for Preview.

`vercel.json` already sets the `sin1` region and per-function durations.

> On the Hobby plan, function regions may be fixed to the project's default. If
> `sin1` is rejected, drop the `regions` key — everything still works, just with
> slightly higher latency to Supabase.

> Because `public/` exists, Vercel serves **only** that directory as static
> files. Source, `package.json` and migrations are not web-reachable.

### 3. Point Telegram at it

```bash
PUBLIC_BASE_URL=https://your-project.vercel.app npm run webhook:set
npm run webhook:info
```

### 4. Set up the scheduler

Vercel Cron cannot run more than once a day on Hobby, so scheduling lives
outside. Create one job at [cron-job.org](https://cron-job.org):

- **URL**: `https://your-project.vercel.app/api/cron/tick`
- **Schedule**: every minute
- **Header**: `Authorization: Bearer <your CRON_SECRET>`

This drives payment recovery, sheet syncing, the preorder refresh and expiry
sweeps — and its regular traffic also stops a free-tier Supabase project pausing
for inactivity.

`supabase/optional/pg_cron_schedule.sql` is an in-database alternative, but it
stops when a paused project does, so it cannot wake itself back up.

### 5. Verify

```bash
curl https://your-project.vercel.app/api/health
```

Reports missing variables **by name only**, Supabase connectivity, and the
webhook registration. Never returns secrets.

---

## Running costs

Everything fits in free tiers at this volume:

| Service | Tier | Watch out for |
|---|---|---|
| Vercel | Hobby | Cron capped at once daily — hence cron-job.org |
| Supabase | Free | **Pauses after 7 days idle**; 500 MB DB, 1 GB storage |
| Gemini | Free | ~15 req/min, ~1,500/day; **free tier trains on submitted data** |
| Google Sheets | Free | — |
| Telegram | Free | — |

> **Before handling real customer payments**, move to a paid Gemini key. The free
> tier uses submitted content to improve Google's products, and receipts contain
> names, bank details and phone numbers.

---

## Data handling

Receipts contain personal data, so under Singapore's PDPA:

- The receipts bucket is **private**. Evidence is viewed through short-lived
  signed URLs generated server-side.
- Logs record identifiers and reason codes, never names, phone numbers,
  addresses or raw model output.
- `payment_submissions` and `order_status_history` are append-only, enforced by
  database triggers.

**Suggested retention:** keep payment evidence for 12 months to cover disputes
and accounting, then delete. Deletion is *not* implemented — decide the policy
before writing that job.

---

## Documentation

- **[MAINTENANCE.md](MAINTENANCE.md)** — the handbook. What breaks, how it looks
  when it does, and how to fix it. Read this first when something is wrong.
- **[docs/TESTING.md](docs/TESTING.md)** — the manual test checklist for staging.

## Project layout

```
public/index.html        the landing page served at /
api/                     Vercel functions (webhook, cron, health)
scripts/set-webhook.js   register / inspect / delete the webhook
src/
  app.js                 shared awaitable update dispatch
  dev-polling.js         local entry point
  config.js              typed env parsing and validation
  handlers/              user, admin, deliveryMode
  services/              supabase, orders, payments, sheets, state
  utils/                 money, time, logging, keyboards, texts
supabase/migrations/     numbered, idempotent SQL
test/                    npm test
```
