# Dingo Post Form Bot

A Telegram bot that runs food preorder and delivery operations for Dingo Cafe
across several dorm halls, with AI-assisted PayNow payment verification.

Customers order through a Telegram chat. Admins confirm orders, run a delivery
round that posts announcements to a public channel, and manage the menu. Payment
screenshots are read automatically and either approved or sent to an admin.

- **Orders, customers and payments** live in Supabase (Postgres).
- **The menu (food, prices, stock)** lives in Supabase too, and is edited in the
  bot (Settings > Manage Food Items). Checkout deducts stock in one atomic
  database statement, so many customers can order at once without queueing and
  without overselling.
- **Settings and halls** live in Google Sheets, where staff already edit them.
- **The Orders, Today's Orders and FoodAndStock sheet tabs** are read-only
  mirrors of Supabase, so the kitchen keeps the views it is used to. Edits made
  to them are overwritten.

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
   ┌────────────┐   ┌───────────────┐   ┌──────────────┐
   │  Supabase  │   │ Google Sheets │   │ Dingo channel│
   │            │   │               │   │              │
   │ orders     │   │ Settings      │   │ preorder     │
   │ customers  │   │ Hall          │   │ coming/here  │
   │ payments   │   │ Orders, Today,│   └──────────────┘
   │ menu+stock │   │ FoodAndStock  │
   │ all state  │   │ (read-only    │
   └─────┬──────┘   │  mirrors)     │
         │          └───────────────┘
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
2. Picking a hall shows the menu, built live from the `menu_items` table.
3. Tapping items builds a cart stored in Postgres.
4. **Confirm Order** first checks the customer has a phone number on file
   (`customers.phone_number` - their first order, or any order predating this
   column). If not, the bot asks for one, saves it, and the customer taps
   Confirm Order again; nothing is charged or deducted until then. See
   `handleConfirmOrder`/`requestPhoneNumber` in
   [`src/handlers/user.js`](src/handlers/user.js).
5. Once a phone number is on file, Confirm Order re-checks stock, deducts it,
   creates the order directly in `awaiting_payment`, and immediately sends
   payment instructions.
6. The customer gets the PayNow instructions, the exact
   amount due, and a payment deadline.
7. They reply with a screenshot. The bot answers immediately, verifies in the
   background, and either confirms the payment or tells them an admin will look.
8. `/orders` shows their own order history, paginated.

### Admin console

`/adminmenu` opens a self-editing inline menu:

- **Manage Admins** — add, remove, and choose which admin is tagged in preorder posts
- **Manage Food Items** — add, delete, edit stock for one item or all of them
- **Manage Halls** — add and delete pickup halls
- **Edit Dingo Post** — replace the stage-1 "orders open" post's first line
  (`{hall}` fills in the hall name) and optionally attach a photo, which turns
  the post into that photo with the text as its caption. Nothing set = the
  default post.
- **Order Schedule** — the target time for the "orders open" post (default
  6:00 PM) and the order cutoff (default 12:30 AM), both Singapore time.
- **Post Orders Open** — posts stage 1 (below); also offered by the reminder DM.
- **Extend Orders +15 min** — pushes the live stage-1 cutoff back 15 minutes per tap
  and updates the channel post's cutoff time. Only works before the cutoff; once
  ordering has closed it is refused.
- **Delivery Mode** — the announcement sequencer and per-hall serve lists
- **Sold Today** / **Reload Settings**

Payment Accept/Reject for flagged receipts arrives as direct messages.
The legacy order Confirm/Reject code is preserved but bypassed for new orders.

### Ordering stages

A delivery night has two ordering stages (`src/services/orderWindow.js`):

1. **Orders open.** About 30 minutes before the target post time every admin gets
   a DM reminder (and one nudge at the target time if it still isn't posted) with
   a **Post orders now** button; the main admin menu has the same button. Posting
   it wraps up last round (see the reset below), then posts the menu with
   "order before 12:30 AM". At the cutoff the scheduled tick edits that post to
   "Ordering is now closed" and removes its button; customers are refused at the
   cutoff itself, even if the tick is late. Orders already confirmed can still pay.
2. **Spare stock.** Once the drivers have left, **Confirm stock & post** (the first
   button in Delivery Mode) opens a screen listing each item's total, sold in
   stage 1 and remaining stock. Tap an item to change its total (it can't be
   lower than what is already sold; the change is for tonight only), then
   **Confirm & post**: the "ordering closed" post is deleted and the spare-stock
   post goes up. Ordering stays closed between the cutoff and this post.

If stage 1 was never posted, opening the stock screen runs the reset first.
The reminders and the cutoff run off the scheduled tick (`/api/cron/tick`), so
it must be running around those times.

### Delivery mode

Walks each hall through `preorder → coming → here`, then `get ready` for the next
hall, posting to `DINGO_CHANNEL_ID` and deleting superseded posts. The `preorder`
step is the stage-2 spare-stock post above.

**Only `we are here` is a manual tap.** `get ready` and `coming` post themselves,
driven by how far the *current* hall has gotten through its "tap each order when
served" list (see [`src/services/orderStore.js`](src/services/orderStore.js)'s
`getHallServeProgress`, scoped to the current service day - see
[`getServiceDayWindow`](src/services/todaySheet.js)):

- **2/3 served** → posts `Get ready, {next hall}` and DMs every customer with an
  active order there to start heading down.
- **Fully served** → posts `{next hall}, we are coming`, DMs those customers to
  come down and collect now, **and closes ordering for that hall** in the same
  step (see `blockHallForAutoClosure` in
  [`src/handlers/admin.js`](src/handlers/admin.js)).

Closing a hall never touches a customer already mid-payment - only carts that
were never confirmed into an order get cleared, with a message explaining why.
The very last hall in the list never triggers this (there's no genuine "next
hall" for it); the admin ends the night with **Finish Delivery** instead, which
clears the channel posts and the delivery menu. Finish Delivery is offered
once every hall is closed or the last hall's "we are here" has posted (so
reverting a hall at the end of the night can't strand the menu). There is no
manual reset: posting stage 1 ("orders open") resets last round automatically - leftover
unpaid orders are closed and restocked, paid-but-unserved ones are marked served,
stock returns to its opening levels, closed halls reopen and the sequencer rewinds.
Orders with a payment still under review are left open. A summary (including orders
served before payment cleared) goes to the admin who posted, or to every admin when
the scheduled tick posted it.

Halls the delivery has already passed that still have unserved orders (a late
order, or one placed after **Revert**) get a **📋 Serve list** button in the
delivery menu, which brings back that hall's serve list without posting to the
channel. Only the hall the next automatic post is waiting on can trigger it -
serving at an earlier hall never fires the current hall's get-ready/coming.

`Revert last blocked hall` remains a manual override if the
automatic closure needs undoing. **`/skip`**, sent by any admin, force-posts
whatever the sequencer currently has queued next - get ready, coming, or here -
regardless of serve progress. It's the manual override for when the automatic
trigger can't or shouldn't wait, or didn't fire when it should have (check the
logs for `auto_advance_post_failed` - see MAINTENANCE.md §3.2).

The live preorder post re-renders whenever something changes it through the bot,
and once a minute from the scheduler to catch edits typed straight into the
spreadsheet. **Except when an item sells out.** Every stock-changing action - a
checkout deduction, an admin editing one item's stock, or a whole "Edit All
Stock" session - reports its before/after values to
`refreshPreorderPostAfterStockChange` in
[`src/handlers/admin.js`](src/handlers/admin.js). An item that just crossed
from having stock to having none gets a dedicated `🚫 {item} has been sold
out!` post in the channel (one per item, even if several sold out in the same
batch), followed by a **fresh** preorder post replacing the old one - a plain
edit doesn't notify channel subscribers, and that's the point of doing this
differently. Every other stock change still gets the normal silent
edit-in-place refresh.

**The "we are here" serve list is grouped by customer, phone number first**
(not one row per order, and not a Telegram handle - see
[`src/handlers/admin.js`](src/handlers/admin.js)'s `buildHallCustomerListKeyboard`).
Each button shows the phone number and what that customer ordered; tapping it
opens a submenu with the handle, every order they still have active at that
hall, and **✅ Served** / **📦 Dropped off** for each one (distinct outcomes -
different customer message, different `order_status_history` reason, same
underlying `served` status) plus **⬅️ Back**. The order list behind this is
cached for ~20 minutes (`stateStore.KEYS.hallServeOrdersCache`) and refreshed
on every change, so opening a customer's submenu costs no extra Supabase
round trip in the common case. **The cache never guards the action itself** -
Served/Dropped off always re-checks the order live before transitioning it,
so a stale display can at worst show an already-resolved order (tapping it
just fails harmlessly), never cause a lost update or a double-serve. Every
code path that can remove an order from a hall's list (reject, payment
reject, expiry, as well as serving it) proactively refreshes that hall's
cache, on top of the TTL as a backstop.

**📦 Drop Remaining Items Off**, at the bottom of the phone-number list, is for
customers who never came down. It shows a collated per-item total of
everything still uncollected ("Mala x10, Chicken x5 …", see
`collateRemainingItems`) so staff know how much food to leave at the
collection point, then a `phone | handle` button per customer below it.
Tapping one starts a photo relay: the bot asks the admin (in the admin's own
chat with the bot) to send a photo of where the food was left, listing that
customer's order as a reminder. The admin's very next photo is forwarded to
the customer with a caption, then deleted from the admin's own chat so a
night's drop-offs don't pile up there, and every order it covers is marked
`dropped_off` automatically (all of a customer's remaining orders at once, on
one photo). See `handleServeDropoffStart` / `handleAdminDropoffPhoto` in
[`src/handlers/admin.js`](src/handlers/admin.js).

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

**Import the menu, once.** The menu lives in the `menu_items` table, which the
migrations create empty. If you have food and stock in the `FoodAndStock` tab,
copy them in before the first deploy (it needs the Supabase and Google Sheets
variables from `.env.config` / `.env.secret` in place):

```bash
npm run menu:import
```

It refuses to run if the menu already has items (`-- --replace` wipes and
re-imports), skips duplicate names, and records each item's current stock as its
opening stock, which the automatic round reset restores. From then on the tab is a
read-only mirror: change food, prices and stock in the bot under Settings >
Manage Food Items. Until items exist, the mirror deliberately leaves the tab
alone.

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
