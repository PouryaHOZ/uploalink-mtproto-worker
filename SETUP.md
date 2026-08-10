# Setup Guide — Subscription & Payment System

This document describes how to set up and deploy the new subscription/payment system added to the Uploalink MTProto Worker.

## Overview

The system adds:

- **Subscription tiers:** trial (auto, 500MB/day, 7 days) and shared (paid, 5GB/day, 30 days, 80,000 toman)
- **Payment flow via Daramet webintent links** with automatic verification via Daramet API
- **Daily quota management** with atomic check-and-reserve
- **10,000 unique pure donation messages** (no embedded codes — the message text itself is the unique identifier)
- **Automatic payment verification** every 2 minutes via cron
- **Manual verification fallback** via `/verify CODE` command

## Architecture

| Data | Storage | Reason |
|------|---------|--------|
| Subscriptions | D1 (`subscriptions` table) | Relational, indexed |
| Pending payments | D1 (`pending_payments` table) | Filter+sort by status/expiry |
| Daily quota | D1 (`daily_quota` table) | Atomic increment via UPSERT |
| Message state | D1 (`message_state` table) | Atomic lock claim via UPDATE...WHERE...RETURNING |
| Message corpus | `src/data/messages.ts` | Bundled in Worker memory (fast access) |
| Sessions, transfers, queue | KV (existing) | TTL-based, ephemeral |
| Connected accounts | KV (existing) | Read-heavy, exact-key lookup |

## Setup steps

### 1. Create D1 database

```bash
npx wrangler d1 create tg-bot-db --location apac
```

Copy the `database_id` from the output and paste it into `wrangler.jsonc`:

```jsonc
"d1_databases": [
    {
        "binding": "DB",
        "database_name": "tg-bot-db",
        "database_id": "PASTE_YOUR_DATABASE_ID_HERE",
        "preview_database_id": "PASTE_PREVIEW_DB_ID_HERE_OR_SAME",
        "migrations_dir": "migrations"
    }
]
```

For local dev, also create a preview database or use the same ID.

### 2. Apply D1 migrations

```bash
# Apply to remote (production)
npx wrangler d1 migrations apply tg-bot-db --remote

# Apply to local (for wrangler dev)
npx wrangler d1 migrations apply tg-bot-db --local
```

This will:
1. Create the schema (`subscriptions`, `pending_payments`, `daily_quota`, `message_state`, `settings`)
2. Seed `message_state` with 10,000 empty rows (one per message in `messages.ts`)

### 3. Verify message pool

```bash
npx wrangler d1 execute tg-bot-db --remote \
    --command "SELECT COUNT(*) as total, SUM(CASE WHEN used=1 THEN 1 ELSE 0 END) as used, SUM(CASE WHEN locked=1 THEN 1 ELSE 0 END) as locked FROM message_state;"
```

Expected: `total=10000`, `used=0`, `locked=0`

### 4. Set the Daramet API token as a secret

```bash
npx wrangler secret put DARAMET_API_TOKEN
# Paste your Daramet API token (from daramet.com developer panel)
```

### 5. (Optional) Regenerate the message corpus

The `src/data/messages.ts` file is already pre-generated with 10,000 unique messages. If you want to regenerate it (e.g., to change phrase banks):

```bash
python3 scripts/generate_messages.py
```

This will overwrite `src/data/messages.ts` with a fresh batch of 10,000 messages. The seed in `migrations/0002_seed_message_state.sql` doesn't need to be re-applied — only the text in the `.ts` file changes, the row count stays the same.

### 6. Deploy

```bash
npx wrangler deploy
```

### 7. Set up webhook for cron triggers (automatic)

Cloudflare automatically runs the cron triggers defined in `wrangler.jsonc`:

```jsonc
"triggers": {
    "crons": [
        "*/1 * * * *",      // Queue processing (existing)
        "*/2 * * * *",      // Auto-verify payments + TTL cleanup
        "0 * * * *",        // Link expiry reminders + cleanup expired payments
        "0 0 * * *",        // Daily admin report (placeholder)
        "0 */6 * * *"       // Recycle used messages (90-day cooldown)
    ]
}
```

No additional setup needed — these run automatically after deploy.

### 8. Test the bot

In Telegram (or Bale/Rubika):

1. Send `/start` to the bot — should show new inline buttons "💎 خرید اشتراک" and "📊 وضعیت اشتراک"
2. Tap "💎 خرید اشتراک" or send `/subscribe` — should receive a payment link
3. Click the link, complete payment on Daramet (do NOT modify the message)
4. Within 2 minutes, the cron will auto-verify and activate your subscription
5. Alternatively, send `/verify <tracking_code>` to verify manually

## User-facing commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + inline buttons |
| `/status` | Show subscription, quota, transfers, pending payments |
| `/subscribe` | Buy a 30-day subscription (80,000 toman) |
| `/verify CODE` | Manually verify a payment with tracking code |
| `/sub_status` | Detailed subscription status |
| `/link` | Connect other platforms (existing) |
| `/unlink` | Disconnect platforms (existing) |

## Files added/modified

### New files
- `migrations/0001_init_schema.sql` — D1 schema
- `migrations/0002_seed_message_state.sql` — Seed 10,000 empty rows
- `scripts/generate_messages.py` — Message corpus generator
- `src/data/messages.ts` — 10,000 unique messages (auto-generated)
- `src/services/daramet.ts` — Daramet API client
- `src/services/messagePool.ts` — Atomic message claim/release
- `src/services/quota.ts` — Daily quota with atomic check-and-reserve
- `src/services/payment.ts` — Payment lifecycle (create, verify, activate, cleanup)
- `src/handlers/subscriptions.ts` — /subscribe, /verify, /sub_status handlers
- `src/utils/persianDate.ts` — Asia/Tehran date utilities

### Modified files
- `src/types/index.ts` — Added Subscription, PendingPayment, DailyQuota, DarametDonation, QuotaCheckResult
- `src/config/constants.ts` — Added SUBSCRIPTION, PAYMENT, DARAMET constants; bumped SYSTEM_VERSION to 0.7.0
- `src/services/kv.ts` — Fixed TS generics for KVNamespace.get<T>
- `src/handlers/transfers.ts` — Added quota gate at the start of processFileTransfer
- `src/handlers/commands.ts` — Extended handleStatusCommand; added inline buttons to /start
- `src/index.ts` — Added /subscribe, /verify, /sub_status routes; new callbacks (sub_buy, sub_status, sub_verify_input, sub_cancel); cron handlers
- `src/platforms/messenger.ts` — Renamed from `messages.ts` (was conflicting with `src/data/messages.ts`)
- `wrangler.jsonc` — Added D1 binding, cron triggers, DARAMET_* vars
- `worker-configuration.d.ts` — Added DB binding, DARAMET_* types
- `test/index.spec.ts` — Updated to test /health endpoint

## Backward compatibility

All existing functionality is preserved:
- ✅ `/start`, `/status`, `/link`, `/unlink` commands work as before
- ✅ File transfers via Telegram, Bale, Rubika work as before (with added quota check)
- ✅ Queue system, GitHub Actions triggers, cancel flags — unchanged
- ✅ Existing KV keys (sessions, transfers, queue, cancel flags, version, connected accounts) — unchanged
- ✅ `/check-cancel` and `/action-webhook` endpoints — unchanged (only added quota confirmation on `completed`)

## Cost

Both D1 and KV sit deep inside the **$5/month Workers Paid plan** free tier at the expected workload (~1k DAU, ~5k transfers/day, ~100 purchases/day). No additional cost expected.

## Troubleshooting

### "DARAMET_API_TOKEN is not configured"
Run: `npx wrangler secret put DARAMET_API_TOKEN`

### "All 10,000 messages are locked/used"
This means too many concurrent pending payments. Check:
```bash
npx wrangler d1 execute tg-bot-db --remote \
    --command "SELECT COUNT(*) FROM message_state WHERE used=0 AND (locked=0 OR lock_expires_at <= CAST(strftime('%s','now') AS INTEGER));"
```
If 0, wait for the cron to recycle used messages (every 6 hours) or manually:
```bash
npx wrangler d1 execute tg-bot-db --remote \
    --command "UPDATE message_state SET used=0, used_by=NULL, used_at=NULL, used_expires_at=NULL WHERE used=1 AND used_expires_at <= CAST(strftime('%s','now') AS INTEGER);"
```

### Payment not auto-verified
1. Check Daramet API token is set
2. Check the user did NOT modify the donation message
3. Try `/verify <tracking_code>` manually
4. Check logs: `npx wrangler tail`

### Quota not resetting
Quota resets at 00:00 Asia/Tehran time. The day key is computed via `Intl.DateTimeFormat` with `timeZone: 'Asia/Tehran'`. If your Worker's runtime doesn't support `Intl.DateTimeFormat` with timeZone (it should), this would break.

## Regenerating messages

If you want to change the phrase banks or distribution:

1. Edit `scripts/generate_messages.py` — modify `PHRASES` dict
2. Run `python3 scripts/generate_messages.py`
3. Redeploy: `npx wrangler deploy`

The `message_state` table doesn't need to be touched — only the text in `messages.ts` changes. Note: existing pending payments reference the old text in their `message_text` column (snapshot), so they will still verify correctly.

## License

Same as the parent project.
