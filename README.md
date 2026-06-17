# Mavrx Autopilot

Autonomous social manager for **Mavrx KSA** that runs entirely in the cloud (GitHub Actions) — **your Mac can stay closed**. It replaces the old Mac-pinned `/mavrx-post` flow (Drive MCP + cowork-agent caption + LaunchAgents).

## What it does, unattended

| Job | Workflow | Cadence | Behaviour |
|---|---|---|---|
| **Daily post** | `.github/workflows/post.yml` | 20:00 Asia/Riyadh | Picks an unused Drive asset → writes the Arabic caption with Claude (same brand-voice prompt as the cowork agent) → publishes to **IG + FB** → advances FEED↔STORY state → hands off TikTok/Snap to Telegram. |
| **Smart engagement** | `.github/workflows/engage.yml` | every 2h | AI replies to **IG + FB comments & DMs** in brand voice. Spam → hidden. Complaints / refunds / "where's my order" / wrong-item → **never auto-replied**, flagged to you on Telegram. |

**Honest limits**
- **TikTok & Snap**: no free headless API for organic posting. The day's asset + ready captions are pushed to **Telegram** so you tap "post" on your phone (~10s).
- **Out of scope** (by design — an unattended bot shouldn't decide these): ad spend, Shopify writes (price/inventory/discounts), pricing, finance. Those stay with the `mavrx-business:*` cowork agents + your approval.

## How it stays $0 + hands-off
- **Host**: GitHub Actions on a **private** repo (free minutes; ~1,000/mo used of 2,000).
- **AI**: Claude API over HTTPS for captions + replies (~$1/mo). No Claude Code session needed.
- **Assets**: a plain `assets/` folder in the repo — drop files in (GitHub app works), the bot posts one/day and dedupes by filename. No Google Cloud setup. (`src/lib/drive.js` is an optional advanced Drive source, not used by default.)
- **Publishing**: Meta Graph API with your existing never-expiring Page token.
- **State**: `state/*.json`, committed back to the repo after each run (also keeps the schedule alive).
- **Reporting**: a free Telegram bot (digests, escalations, TikTok/Snap hand-off).

## Setup
One-time, ~30 min. See **[SETUP.md](SETUP.md)**.

## Layout
```
src/post.js          daily post orchestrator (FEED↔STORY)
src/engage.js        smart comment+DM replies
src/lib/assets.js    the post queue = files in assets/
src/lib/meta.js      IG+FB publish (Meta Graph API)
src/lib/drive.js     OPTIONAL Drive source (read-only SA JWT) — not used by default
src/lib/caption.js   Claude caption + reply (ported brand-voice prompt)
src/lib/crossbundle.js  TikTok/Snap Telegram hand-off
src/lib/notify.js    Telegram
src/lib/occasion.js  KSA occasion resolver
src/lib/state.js     state load/save
state/               state.json · engagement.json · ksa-calendar.json (committed)
scripts/secret-scan.sh   pre-push guard (run `npm run secret-scan`)
```

## Manual triggers
From the repo's **Actions** tab → pick a workflow → **Run workflow**.
- `mavrx-post` has **dry_run** (pick + caption, no publish) and **force** (ignore the same-day gate) toggles.
