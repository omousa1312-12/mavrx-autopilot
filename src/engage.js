#!/usr/bin/env node
'use strict';
/*
 * engage.js <comments-poll|dms-poll> — smart IG + FB engagement, headless.
 *
 * Upgrade of scripts/mavrx-engagement.js: keeps the Meta Graph fetch/dedupe/
 * state machine, but replaces hardcoded template replies with Claude-generated
 * brand-voice replies (caption.js → generateReply). Safety rails:
 *   1. Deterministic spam regex  → hide (no AI).
 *   2. Deterministic escalate regex (complaint/refund/order-status/late/wrong)
 *      → never auto-reply; flag to Omar on Telegram.
 *   3. Otherwise → AI reply, which can itself answer SKIP (just acknowledge) or
 *      ESCALATE (hand to a human) — a second safety net beyond the regex.
 * If ANTHROPIC_API_KEY is unset it degrades to "spam-hide + escalate only, no
 * replies" rather than guessing.
 *
 * State (committed back by the workflow): <state>/engagement.json.
 */
const { log } = require('./lib/util');
const { loadEngagement, saveEngagement } = require('./lib/state');
const { generateReply, hasKey } = require('./lib/caption');
const meta = require('./lib/meta');
const notify = require('./lib/notify');

const GRAPH = 'https://graph.facebook.com/v18.0';
const MAX_PROCESSED_IDS = 500;
const SHOPIFY_URL = 'https://mavrxksa.com';

const SPAM_PATTERNS = [
  /follow.{0,5}me/i, /check.{0,5}my.{0,5}profile/i, /\bdm.{0,5}for.{0,5}collab/i,
  /(viagra|casino|bitcoin|crypto)/i,
];

// Sensitive intents that must go to a human, never an auto-reply.
const ESCALATE_PATTERNS = [
  /شكوى|مشكلة|سيء|سيئة|خراب|broken|defect|complain|complaint|refund|استرداد|استرجاع|return/i,
  /(ما.{0,5}وصل|لم.{0,5}يصل|تأخر|متأخر|late|never.{0,5}arrived|delayed)/i,
  /(غلط|خطأ|wrong|incorrect|اختلاف)/i,
  /(وين|أين).{0,10}(طلبي|الطلب)/i, /\b(track|tracking|where.{0,5}order|order.{0,5}status)\b/i,
];

// First-touch fallback when the AI says SKIP on a brand-new conversation.
const DM_WELCOME = `هلا وسهلاً 🤍 أنا هنا لأي سؤال عن الإطلالات والمقاسات أو الطلب.\nتصفحي المتجر: ${SHOPIFY_URL}`;

const escalations = [];
// Bound AI calls per run so a viral post can't blow up cost / job time / Meta
// write-rate. Overflow items are left UNmarked so the next poll handles them.
let AI_BUDGET = Infinity;

function flag(platform, surface, who, text) {
  escalations.push({ platform, surface, who: who || '?', text: (text || '').slice(0, 160) });
}

async function gj(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}
async function postForm(url, params, label) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}
async function sendDm(endpoint, token, recipientId, text, isFb) {
  const body = { recipient: { id: recipientId }, message: { text } };
  if (isFb) body.messaging_type = 'RESPONSE';
  const res = await fetch(`${endpoint}?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function isSpam(t) { return SPAM_PATTERNS.some((p) => p.test(t)); }
function isEscalate(t) { return ESCALATE_PATTERNS.some((p) => p.test(t)); }

// Decide what to do with a piece of customer text. Returns {action, reply?}.
//   action ∈ hide | escalate | reply | skip
async function decide(text, surface, platform) {
  const t = (text || '').trim();
  if (!t) return { action: 'skip' };
  if (surface === 'comment' && isSpam(t)) return { action: 'hide' };
  if (isEscalate(t)) return { action: 'escalate' };
  if (!hasKey()) return { action: 'skip' }; // no AI → don't guess
  if (AI_BUDGET <= 0) return { action: 'defer' }; // storm guard → handled next poll
  AI_BUDGET--;
  const r = await generateReply({ text: t, surface, platform });
  if (!r || r.error) { log(`  AI reply error: ${r ? r.error : 'no key'}`); return { action: 'escalate' }; }
  if (r.escalate) return { action: 'escalate' };
  if (r.skip) return { action: 'skip' };
  return { action: 'reply', reply: r.reply };
}

// ───────── COMMENTS ─────────
async function pollIgComments(secrets, state) {
  const media = await gj(
    `${GRAPH}/${secrets.ig_business_id}/media?fields=id&limit=25&access_token=${secrets.fb_page_token}`,
    'ig-media-list');
  for (const post of media.data || []) {
    const page = await gj(
      `${GRAPH}/${post.id}/comments?fields=id,text,username,timestamp&limit=50&access_token=${secrets.fb_page_token}`,
      `ig-comments:${post.id}`);
    for (const c of page.data || []) {
      if (state.last_comment_ids.ig.includes(c.id)) continue;
      const { action, reply } = await decide(c.text, 'comment', 'instagram');
      log(`IG comment ${c.id} (@${c.username || '?'}) → ${action}`);
      if (action === 'defer') { log('  AI budget hit — defer to next run'); continue; }
      try {
        if (action === 'hide') {
          await postForm(`${GRAPH}/${c.id}`, { hide: 'true', access_token: secrets.fb_page_token }, `ig-hide:${c.id}`);
          state.stats.comments_hidden++;
        } else if (action === 'reply') {
          await postForm(`${GRAPH}/${c.id}/replies`, { message: reply, access_token: secrets.fb_page_token }, `ig-reply:${c.id}`);
          state.stats.comments_replied++;
        } else if (action === 'escalate') {
          flag('IG', 'comment', c.username, c.text); state.stats.dms_escalated++;
        }
        state.last_comment_ids.ig.push(c.id);
      } catch (e) { log(`  failed: ${e.message}`); state.stats.errors++; }
    }
  }
}

async function pollFbComments(secrets, state) {
  const posts = await gj(
    `${GRAPH}/${secrets.fb_page_id}/posts?fields=id&limit=25&access_token=${secrets.fb_page_token}`,
    'fb-posts-list');
  for (const post of posts.data || []) {
    const page = await gj(
      `${GRAPH}/${post.id}/comments?fields=id,message,from&limit=50&order=reverse_chronological&access_token=${secrets.fb_page_token}`,
      `fb-comments:${post.id}`);
    for (const c of page.data || []) {
      if (state.last_comment_ids.fb.includes(c.id)) continue;
      const text = c.message || '';
      const { action, reply } = await decide(text, 'comment', 'facebook');
      log(`FB comment ${c.id} (${c.from?.name || '?'}) → ${action}`);
      if (action === 'defer') { log('  AI budget hit — defer to next run'); continue; }
      try {
        if (action === 'hide') {
          await postForm(`${GRAPH}/${c.id}`, { is_hidden: 'true', access_token: secrets.fb_page_token }, `fb-hide:${c.id}`);
          state.stats.comments_hidden++;
        } else if (action === 'reply') {
          await postForm(`${GRAPH}/${c.id}/comments`, { message: reply, access_token: secrets.fb_page_token }, `fb-reply:${c.id}`);
          state.stats.comments_replied++;
        } else if (action === 'escalate') {
          flag('FB', 'comment', c.from?.name, text); state.stats.dms_escalated++;
        }
        state.last_comment_ids.fb.push(c.id);
      } catch (e) { log(`  failed: ${e.message}`); state.stats.errors++; }
    }
  }
}

// ───────── DMS ─────────
async function processConvo(secrets, state, { convoId, platform, ourId, endpoint, isFb }) {
  const msgs = await gj(
    `${GRAPH}/${convoId}?fields=messages.limit(10){id,from,message}&access_token=${secrets.fb_page_token}`,
    `${platform}-convo:${convoId}`);
  const messages = msgs.messages?.data || [];
  if (!messages.length) return;
  const latest = messages[0];
  if (!latest?.from?.id || latest.from.id === ourId) return; // latest is from us → nothing new
  if (state.last_dm_message_ids[platform][convoId] === latest.id) return; // already handled

  const text = latest.message || '';
  const weEverReplied = messages.some((m) => m.from?.id === ourId);
  let { action, reply } = await decide(text, 'dm', platform === 'ig' ? 'instagram' : 'facebook');
  if (action === 'skip' && !weEverReplied) { action = 'reply'; reply = DM_WELCOME; } // warm first touch
  log(`${platform.toUpperCase()} DM convo=${convoId} → ${action}: "${text.slice(0, 50)}"`);
  if (action === 'defer') { log('  AI budget hit — defer to next run'); return; }

  try {
    if (action === 'reply' && reply) {
      await sendDm(endpoint, secrets.fb_page_token, latest.from.id, reply, isFb);
      state.stats.dms_replied++;
    } else if (action === 'escalate') {
      flag(platform.toUpperCase(), 'DM', latest.from.id, text); state.stats.dms_escalated++;
    }
    state.last_dm_message_ids[platform][convoId] = latest.id;
    if (!state.last_dm_first_touch[platform].includes(convoId)) state.last_dm_first_touch[platform].push(convoId);
  } catch (e) { log(`  send failed: ${e.message}`); state.stats.errors++; } // don't mark seen → retry next poll
}

async function pollDms(secrets, state, platform) {
  const isFb = platform === 'fb';
  const q = isFb ? '' : 'platform=instagram&';
  const convos = await gj(
    `${GRAPH}/${secrets.fb_page_id}/conversations?${q}fields=id&limit=25&access_token=${secrets.fb_page_token}`,
    `${platform}-conversations`);
  for (const convo of convos.data || []) {
    try {
      await processConvo(secrets, state, {
        convoId: convo.id, platform,
        ourId: isFb ? secrets.fb_page_id : secrets.ig_business_id,
        endpoint: `${GRAPH}/${isFb ? secrets.fb_page_id : secrets.ig_business_id}/messages`,
        isFb,
      });
    } catch (e) { log(`${platform} convo ${convo.id} error: ${e.message}`); state.stats.errors++; }
  }
}

async function sendSummary(sub, state, before) {
  const replied = state.stats.comments_replied + state.stats.dms_replied - (before.comments_replied + before.dms_replied);
  const hidden = state.stats.comments_hidden - before.comments_hidden;
  if (!replied && !hidden && !escalations.length) return; // stay silent on a quiet poll
  let msg = `💬 Mavrx ${sub}: replied ${replied}, hid ${hidden}, flagged ${escalations.length}.`;
  if (escalations.length) {
    msg += '\n\n🔔 Needs you (reply from the app):';
    escalations.forEach((e, i) => { msg += `\n${i + 1}. [${e.platform} ${e.surface}] ${e.who}: "${e.text}"`; });
  }
  await notify.tg(msg);
}

async function main() {
  const sub = process.argv[2];
  if (!sub) { log('usage: engage.js <comments-poll|dms-poll>'); process.exit(2); }
  AI_BUDGET = Number(process.env.MAVRX_AI_REPLY_BUDGET || 60);
  let secrets;
  try { secrets = meta.loadSecrets(); }
  catch (e) { await notify.tg(`🛑 Mavrx engage FAILED at secrets: ${e.message}`); log(e.message); process.exit(1); }

  const state = loadEngagement();
  const before = { ...state.stats };
  try {
    if (sub === 'comments-poll') {
      await pollIgComments(secrets, state).catch((e) => { log(`IG comments: ${e.message}`); state.stats.errors++; });
      await pollFbComments(secrets, state).catch((e) => { log(`FB comments: ${e.message}`); state.stats.errors++; });
    } else if (sub === 'dms-poll') {
      await pollDms(secrets, state, 'ig').catch((e) => { log(`IG DMs: ${e.message}`); state.stats.errors++; });
      await pollDms(secrets, state, 'fb').catch((e) => { log(`FB DMs: ${e.message}`); state.stats.errors++; });
    } else { log(`unknown subcommand: ${sub}`); process.exit(2); }

    // Trim processed-id arrays.
    for (const k of ['ig', 'fb']) {
      if (state.last_comment_ids[k].length > MAX_PROCESSED_IDS) state.last_comment_ids[k] = state.last_comment_ids[k].slice(-MAX_PROCESSED_IDS);
      if (state.last_dm_first_touch[k].length > MAX_PROCESSED_IDS) state.last_dm_first_touch[k] = state.last_dm_first_touch[k].slice(-MAX_PROCESSED_IDS);
    }
    saveEngagement(state);
    await sendSummary(sub, state, before);
    log(`done ${sub}: ${JSON.stringify(state.stats)}`);
  } catch (e) {
    saveEngagement(state);
    await notify.tg(`🛑 Mavrx engage ${sub} crashed: ${e.message}`);
    log(`FATAL: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { isSpam, isEscalate, decide };
