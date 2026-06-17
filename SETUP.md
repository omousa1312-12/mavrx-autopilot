# Mavrx Autopilot — one-time setup (~30 min)

Do these in order. After step 6 the system runs itself with your Mac off.

---

## 1. Push this folder to a PRIVATE GitHub repo

> ⚠️ Must be **private** — it carries store state (not secrets, but keep it private anyway).

```bash
cd ~/"claude code 1"/mavrx-autopilot
npm run secret-scan          # must print "✅ clean" before you continue
git init -b main
git add .
git commit -m "mavrx-autopilot: initial"
# With the GitHub CLI (easiest):
gh repo create mavrx-autopilot --private --source=. --push
# …or create an empty private repo on github.com, then:
#   git remote add origin git@github.com:<you>/mavrx-autopilot.git && git push -u origin main
```

---

## 2. Add the 5 GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add each:

| Secret | Value |
|---|---|
| `META_SECRETS_JSON` | The **full contents** of `~/.claude/secrets/meta.json` (already exists, token verified live). `pbcopy < ~/.claude/secrets/meta.json` then paste. |
| `ANTHROPIC_API_KEY` | From <https://console.anthropic.com> → API Keys. (Used for captions + replies, ~$1/mo.) |
| `GDRIVE_SA_JSON` | The service-account JSON from step 3. |
| `TELEGRAM_BOT_TOKEN` | From step 4. |
| `TELEGRAM_CHAT_ID` | From step 4. |

---

## 3. Google Drive read-only service account

1. <https://console.cloud.google.com> → create/pick a project.
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account** (any name, no roles needed).
4. Open the new service account → **Keys → Add key → Create new key → JSON** → download. Paste the whole file as the `GDRIVE_SA_JSON` secret.
5. Copy the service account's email (looks like `name@project.iam.gserviceaccount.com`).
6. **Share the Drive folder with it**: signed in as `mavrxksa@gmail.com`, open the **"Mavrx Media 1"** folder (`https://drive.google.com/drive/folders/1InS926od9JmUS4EuVo9GF0m6C-ANXgsY`) → **Share** → paste the service-account email → **Viewer** → Send.

---

## 4. Telegram bot (your phone alerts + TikTok/Snap hand-off)

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **bot token** → that's `TELEGRAM_BOT_TOKEN`.
2. Open a chat with your new bot and send it any message (e.g. "hi").
3. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*' | head -1
   ```
   The number is `TELEGRAM_CHAT_ID`.

---

## 5. Test before trusting it

Repo → **Actions** tab → enable workflows if prompted.

1. **Dry run**: Actions → **mavrx-post** → **Run workflow** → tick **dry_run** + **force** → Run. Watch the log; you should get a **Telegram** message with the chosen asset + generated caption, and **nothing is published**.
2. **Live**: run **mavrx-post** again with only **force** ticked. Confirm the post appears on IG + FB, the `state.json` commit lands, and Telegram shows the digest (+ TikTok/Snap hand-off on a cadence day).
3. **Engagement**: leave a test comment + DM on a Mavrx post → run **mavrx-engage** → confirm a brand-voice reply for a normal question, and a **Telegram escalation (no auto-reply)** for "where's my order".

---

## 6. Cut over — disable the Mac flow (prevents double-posting)

> 🚨 The cloud and the Mac use **separate** state files. If both stay active, you'll **double-post**. Do this once the cloud is verified (step 5), and before the next 20:00 Riyadh.

```bash
launchctl unload ~/Library/LaunchAgents/com.mavrx.dailypost.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.mavrx.comments.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.mavrx.dms.plist 2>/dev/null
```

Also stop the SessionStart auto-fire so opening Claude Code in the Mavrx dir doesn't re-post: in `~/claude code 1/.claude/settings.local.json` remove the `SessionStart` hook block (or edit `scripts/mavrx-session-start.sh` to `exit 0` at the top). The `/mavrx-post` skill stays available for manual one-offs.

Done — Mavrx KSA now posts and replies on its own.

---

## Day-to-day
- **Watch**: Telegram. Digests after each post; escalations when a customer needs you; the TikTok/Snap card to tap-post.
- **Refill assets**: when Telegram says "asset pool empty", upload to "Mavrx Media 1" in Drive.
- **Tune the voice**: edit the prompt in `src/lib/caption.js`, push — next run uses it.
- **Costs**: GitHub Actions free; Claude API ~$1/mo. Watch usage at console.anthropic.com.
- **Token note**: the Meta Page token is long-lived/never-expiring; if Meta ever invalidates it, re-run `~/claude code 1/scripts/mavrx-meta-setup.js` on the Mac and update the `META_SECRETS_JSON` secret.
