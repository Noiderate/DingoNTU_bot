# API usage and limits

Findings as of 2026-10-02, for the engine test (simulated customers, free tiers, no real release).
"Measured" = read from the Vercel dashboard or a live tick. "Estimate" = my assumption, not yet measured.

## Vercel Hobby (free)

| Limit | Value | Status |
|---|---|---|
| Active CPU | 4 h / month | **Worry**: see below |
| Provisioned memory | 360 GB-hrs / month | Fine (~35 GB-hrs estimated) |
| Invocations | 1,000,000 / month | Fine (~270k estimated) |
| Function duration | 300 s max | Fine (`maxDuration` is 300) |
| Memory per function | 2 GB fixed | Fine (~320 MB used) |
| Runtime logs kept | 1 hour | **Worry** for testing |
| Commercial use | Not allowed on Hobby | Fine for a test, **blocks a real launch** (needs Pro) |
| When over the limit | Deployment paused (503 `DEPLOYMENT_PAUSED`), about 30 days to reset | **Worry**: bot goes dark mid-test |

### Measured CPU

| Item | Value |
|---|---|
| Used so far (Sep 16 to Oct 2) | 1 h 02 m of 4 h |
| Idle load per day | ~3.5 min |
| Cost per tick (average / P75 / P95) | 133 ms / 155 ms / 224 ms |
| Tick wall time | ~2.9 s (mostly waiting, not CPU) |
| Cold starts | 0.4% (ticks keep the instance warm) |
| Function region | sin1 (matches `vercel.json`) |

### Projection (estimates)

| Setup | Tick CPU / month | Left for customers |
|---|---|---|
| Today: every minute, 24/7 | 1.6 h | ~2.4 h |
| Every minute 15:00 to 02:59, hourly otherwise | ~0.8 h | ~3.2 h |
| Above + cheaper tick (code changes below) | ~0.2 to 0.4 h | ~3.6 h |

Customer cost is a guess: about 2 s of CPU per customer (receipt image shrinking is the heavy part).

## Other APIs

| Service | Limit | Status | Why |
|---|---|---|---|
| Google Sheets | 60 reads and 60 writes per min per service account | **Worry** | ~10 reads and 5 writes per order. Peak of ~5 orders/min uses ~50 reads/min. Over ~6 orders/min gives 429s. |
| Google Sheets (customer impact) | Same quota | **Worry** | If the hall list cache expires while the quota is used up, a customer sees "unavailable". |
| Gemini (receipt reading) | Free tier daily cap reported at 500 to 1,000; Google no longer publishes a fixed table | **Worry** | 300+ calls a night plus fallbacks. Check the live quota in AI Studio. |
| Supabase storage (receipts) | Free file-storage cap (recalled as 1 GB, not verified) | Fine | Receipt images are no longer stored by default (`STORE_RECEIPT_IMAGES` off). Only the Telegram `file_id` and the image hash are kept. If turned on, set `RECEIPT_RETENTION_DAYS` to 1 to 2 for the test. |
| Telegram edits | 20 messages/min per group | **Watch** | Preorder channel post and hall messages are edited as orders change. Fake users cannot test this. |
| cron-job.org | 30 s timeout per call; job disabled after more than 25 failures in a row | **Watch** | Ticks now stop at 15 s (`CRON_TIME_BUDGET_MS`). Turn on failure notifications for the job, and check it is still enabled if orders stop expiring. |
| Supabase database | 500 MB, pauses after 1 week idle | Fine | 300 orders a day is ~1 MB a day. Hourly ticks prevent pausing. |
| Telegram overall | 30 messages/s, 1/s per chat | Fine | 300 customers over 3.5 h is far below this. |
| Supabase API requests | Unlimited on free | Fine | |

## Problems found in the live setup

| Finding | Effect | Fix |
|---|---|---|
| Tab is named `FoodAndStock (read only)`, code needs exactly `FoodAndStock` | Menu sheet sync fails every tick, wasting a Sheets call each time | Rename the tab |
| Tick reports `preorder: no_unblocked_hall` | Preorder post is skipped | Check the Hall tab (no halls, or all blocked) |
| Today's Orders tab is rewritten every tick even when unchanged | 3 Sheets writes a minute, 24/7 | Fixed: skipped when unchanged |
| Header row is read on every order sync | Extra read per sync (~50% of reads) | Fixed: cached 10 min per instance |
| Webhook drains the sheet outbox on every update | An extra database query on ~7,500 updates a day | Fixed: only when an order changed |
| Cron tick had a 4 min budget, cron-job.org gives up at 30 s | A slow tick counts as failed; 25 in a row silently disables the job | Fixed: cron runs have their own 15 s budget |
| `reconcile` overwrote every queued sheet sync with "retry now" each tick | Skipped the backoff during Sheets overload; failing orders retried every minute | Fixed: only adds missing queue entries, in one batched write |

## Cron schedule (cron-job.org, Asia/Singapore)

| Job | Expression | Runs |
|---|---|---|
| Dingo Bot Tick (active hours: 3pm - 4am) | `* 15-23,0-3 * * *` | Every minute, 15:00 to 03:59 |
| Dingo Bot Tick (slow - after hours) | `0 4-14 * * *` | Hourly, 04:00 to 14:00 |

Both need the `Authorization: Bearer <CRON_SECRET>` header.
Payment window is 2 minutes, so do not slow the in-service tick past 1 to 2 minutes (expiry lag holds stock).

## Planned code changes (not done yet)

| # | Change | Saves |
|---|---|---|
| 1 | ~~Skip unchanged Today's Orders rewrite~~ **Done** (still rewritten every 10 min as a heal) | CPU and Sheets writes |
| 2 | ~~Cache `ensureHeaders` per instance~~ **Done** (10 min cache) | ~50% of Sheets reads |
| 3 | Use the append response's row number: **dropped**, saves no requests (each sync still needs one read to find or verify the row) | nothing |
| 4 | Serve a stale hall list when a refresh fails | Customer errors |
| 5 | Run housekeeping deletes and menu/preorder refresh less often (expiry stays every tick) | CPU |
| 6 | ~~Drain the outbox from the webhook only when an order changed~~ **Done** | CPU |
| 7 | ~~Turn off `mozjpeg` or cap receipt shrinking~~ **Done**: receipt images are no longer shrunk or uploaded by default | CPU and storage |

## Sources

- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [Vercel fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)
- [Why a deployment is paused](https://vercel.com/kb/guide/why-is-my-account-deployment-blocked)
- [Google Sheets API limits](https://developers.google.com/workspace/sheets/api/limits)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Supabase pricing](https://supabase.com/pricing)
- [Telegram bot rate limits](https://pipsync.io/en/blog/telegram-rate-limits)
