# Mavrx Autopilot — setup (simple, ~20 min)

Posting to IG + FB and replying to customers, with your Mac off. **No ads, no money, no Shopify changes** — ever.

I already initialized the repo and made the first commit for you. You do the steps below once.

---

## Step 1 — Put some photos/videos in the queue
Drop a handful of Mavrx images/videos into the **`assets/`** folder (drag them in now, or later from your phone via the GitHub app). The bot posts one per day, best/newest first, never repeats.

## Step 2 — Put it on GitHub (free) + add your keys
Open Terminal and paste these one block at a time:

```bash
# install GitHub CLI + log in (opens your browser once)
brew install gh
gh auth login          # choose: GitHub.com → HTTPS → Login with a web browser

# create your PRIVATE repo and upload the code
cd ~/"claude code 1"/mavrx-autopilot
gh repo create mavrx-autopilot --private --source=. --push
```

Now add the keys (these live encrypted in GitHub, never in the code):

```bash
# Meta token — already on your Mac, this just copies it up:
gh secret set META_SECRETS_JSON < ~/.claude/secrets/meta.json

# Claude key (for captions + replies) — paste it when asked:
gh secret set ANTHROPIC_API_KEY
```
> Don't have a Claude API key? Make one at <https://console.anthropic.com> → API Keys. It's pay-as-you-go, about **$1/month** at this volume. (This is separate from your Claude Code subscription.)

## Step 3 — (Recommended) Telegram alerts on your phone
So you get a ping when a customer needs you (refund/complaint/"where's my order") and the TikTok/Snap post to tap-share:

1. In Telegram, message **@BotFather** → `/newbot` → copy the **token**.
2. Message your new bot "hi", then run:
   ```bash
   curl -s "https://api.telegram.org/bot<PASTE_TOKEN>/getUpdates" | grep -o '"id":[0-9-]*' | head -1
   ```
   The number is your chat id.
3. Save both:
   ```bash
   gh secret set TELEGRAM_BOT_TOKEN
   gh secret set TELEGRAM_CHAT_ID
   ```
(Skip this and everything still posts + replies — you just won't get phone pings or the TikTok/Snap hand-off.)

## Step 4 — Test it (no real post)
```bash
gh workflow run mavrx-post -f dry_run=true -f force=true
```
Open the repo on github.com → **Actions** tab → watch the run. It picks an asset and writes a caption but **publishes nothing**. If you set up Telegram, you'll get the preview there.

When that looks good, do a real one:
```bash
gh workflow run mavrx-post -f force=true
```
Check IG + FB. From now on it runs by itself at **20:00 Riyadh daily**, and replies to comments/DMs **every 2 hours**.

## Step 5 — Turn off the old Mac version (so it doesn't double-post)
Once the cloud post worked, run:
```bash
launchctl unload ~/Library/LaunchAgents/com.mavrx.dailypost.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.mavrx.comments.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.mavrx.dms.plist 2>/dev/null
```

Done. Mavrx posts and answers customers on its own.

---

### Day-to-day
- **Refill the queue** when Telegram says it's empty: upload more files to `assets/`.
- **Change the writing style**: edit `src/lib/caption.js`, push.
- **Costs**: GitHub = free, Claude ≈ $1/month.
- **Out of scope on purpose**: no ad spend, no price/inventory changes — those stay yours.
