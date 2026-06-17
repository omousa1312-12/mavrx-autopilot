'use strict';
/*
 * notify.js — push to Omar via a free Telegram bot.
 *
 * Replaces the macOS notifications (which can't reach him with the Mac off).
 * Used for: the daily post digest, engagement summaries, escalations that need
 * a human, and the TikTok/Snap one-tap hand-off (media + caption to his phone).
 *
 * Gated on TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — if unset, every call is a
 * silent no-op, and all failures are swallowed so notifications can never break
 * a post or a reply.
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const enabled = !!(TOKEN && CHAT);

async function tg(text) {
  if (!enabled || !text) return false;
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
    });
    return res.ok;
  } catch { return false; }
}

// Send a local photo/video with an optional caption (for the cross-platform hand-off).
async function tgMedia(localPath, caption, isVideo) {
  if (!enabled || !localPath || !fs.existsSync(localPath)) return false;
  try {
    const buf = fs.readFileSync(localPath);
    const form = new FormData();
    form.append('chat_id', CHAT);
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    form.append(isVideo ? 'video' : 'photo', new Blob([buf]), path.basename(localPath));
    const res = await fetch(`${API}/${isVideo ? 'sendVideo' : 'sendPhoto'}`, { method: 'POST', body: form });
    return res.ok;
  } catch { return false; }
}

module.exports = { tg, tgMedia, enabled };
