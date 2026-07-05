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
const { loadEngagement, saveEngagement, loadState } = require('./lib/state');
const { generateReply, generateDmReply, hasKey } = require('./lib/caption');
const catalogLib = require('./lib/catalog');
const meta = require('./lib/meta');
const notify = require('./lib/notify');

// MAVRX_DRY=1 → log every would-be send with full text, send nothing, and skip
// marking comments/messages as handled (so a real run can process them later).
const DRY = process.env.MAVRX_DRY === '1';

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

// Detect a dead/under-scoped Meta token so it can't fail silently 288×/day.
// Set a module flag when a Graph OAuth error is seen; main() alerts once per day.
let authErrorSeen = false;
function markAuthError(e) {
  const m = (e && e.message) || '';
  if (/OAuthException|"code":\s*190|error validating access token|session has been invalidated/i.test(m)) {
    authErrorSeen = true;
  }
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

// Private reply — DM the author of a comment (Meta allows exactly ONE per
// comment, within 7 days). recipient is the comment id, not a user id.
async function sendPrivateReply(secrets, commentId, text, isFb) {
  const senderId = isFb ? secrets.fb_page_id : secrets.ig_business_id;
  const body = { recipient: { comment_id: commentId }, message: { text } };
  if (isFb) body.messaging_type = 'RESPONSE';
  const res = await fetch(`${GRAPH}/${senderId}/messages?access_token=${secrets.fb_page_token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`private-reply HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// "(#10) …" family = already privately replied / outside the allowed window.
function isAlreadyRepliedError(e) {
  return /"code":\s*10\b|#10\)|once per comment|already.{0,20}repl/i.test((e && e.message) || '');
}

// Deterministic product DM — price/sizes/link come straight from catalog JSON,
// never from the model, so they can't be hallucinated. Openers rotate.
const DM_OPENERS = [
  'هلا حبيبتي 🤍', 'يا هلا فيكِ ✨', 'أهلين حبيبتي 🌸', 'حياكِ الله 🤍',
];
function buildProductDm(product, availability, seed) {
  const opener = DM_OPENERS[Math.abs(seed || 0) % DM_OPENERS.length];
  if (!product) {
    return `${opener}\nتسعدنا رسالتك! تلاقين كل الإطلالات والأسعار هنا: ${catalogLib.SHOP_URL}\nوقوليلي أي إطلالة تقصدين وأرسل لك سعرها ومقاساتها على طول 🤍`;
  }
  const price = product.priceMin === product.priceMax
    ? `${product.priceMin} ريال`
    : `من ${product.priceMin} إلى ${product.priceMax} ريال`;
  let sizesLine = '';
  if (availability) {
    const inStock = Object.entries(availability).filter(([, ok]) => ok).map(([s]) => s);
    if (inStock.length) sizesLine = `\nالمقاسات المتوفرة حالياً: ${inStock.join(' / ')}`;
    else sizesLine = '\nحالياً كل المقاسات نفدت 💔 بس ترجع قريب — تابعينا!';
  }
  return `${opener}\nسعر «${product.title}» ${price}${sizesLine}\nتطلبينه من هنا مباشرة: ${product.url}\nوالدفع عند الاستلام متوفر ✨`;
}

function isSpam(t) { return SPAM_PATTERNS.some((p) => p.test(t)); }
function isEscalate(t) { return ESCALATE_PATTERNS.some((p) => p.test(t)); }

// Decide what to do with a piece of customer text. Returns {action, reply?}.
//   action ∈ hide | escalate | reply | skip | defer
//   ctx: { username, postCaption, recentReplies } — passed through to the AI so
//   replies are grounded in the specific comment/post and never repeat phrasing.
async function decide(text, surface, platform, ctx = {}) {
  const t = (text || '').trim();
  if (!t) return { action: 'skip' };
  if (surface === 'comment' && isSpam(t)) return { action: 'hide' };
  if (isEscalate(t)) return { action: 'escalate' };
  if (!hasKey()) return { action: 'skip' }; // no AI → don't guess
  if (AI_BUDGET <= 0) return { action: 'defer' }; // storm guard → handled next poll
  AI_BUDGET--;
  const r = await generateReply({
    text: t, surface, platform,
    username: ctx.username, postCaption: ctx.postCaption, recentReplies: ctx.recentReplies,
  });
  if (!r || r.error) { log(`  AI reply error: ${r ? r.error : 'no key'}`); return { action: 'escalate' }; }
  if (r.escalate) return { action: 'escalate' };
  if (r.skip) return { action: 'skip' };
  return { action: 'reply', reply: r.reply };
}

const MAX_RECENT_REPLIES = 20;
const MAX_COMMENT_AGE_MS = 48 * 60 * 60 * 1000; // skip comments older than 48h on the fast poll

// Record a sent reply into the rolling anti-repetition window.
function recordReply(state, platform, text) {
  state.recent_replies.push({ t: Date.now(), platform, text });
  if (state.recent_replies.length > MAX_RECENT_REPLIES) {
    state.recent_replies = state.recent_replies.slice(-MAX_RECENT_REPLIES);
  }
}

// True if a comment is older than the age cutoff (best-effort; missing ts → keep).
function tooOld(ts) {
  if (!ts) return false;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && (Date.now() - ms) > MAX_COMMENT_AGE_MS;
}

// ───────── COMMENTS ─────────
// brand = { catalog, catBlock, postProducts } — all null-safe (fail-soft catalog).
// Resolve the product a post shows: publish-time map first, availability live.
async function resolvePostProduct(brand, postId) {
  const mapped = brand.postProducts?.[postId];
  if (!mapped || !brand.catalog) return null;
  const product = catalogLib.findByHandle(brand.catalog, mapped.handle);
  if (!product) return null;
  const availability = await catalogLib.fetchAvailability(product.handle); // memoized per run
  return { product, availability };
}

function productContextLine(product, availability) {
  const price = product.priceMin === product.priceMax ? `${product.priceMin} SAR` : `${product.priceMin}–${product.priceMax} SAR`;
  const inStock = availability ? Object.entries(availability).filter(([, ok]) => ok).map(([s]) => s).join('/') : null;
  return `${product.title}, ${price}${inStock !== null ? `, sizes in stock: ${inStock || 'none'}` : ''}, link: ${product.url}`;
}

async function pollIgComments(secrets, state, brand) {
  const limit = Number(process.env.MAVRX_MEDIA_LIMIT || 25);
  // Fetch caption alongside id so replies can react to the specific post.
  const media = await gj(
    `${GRAPH}/${secrets.ig_business_id}/media?fields=id,caption,timestamp&limit=${limit}&access_token=${secrets.fb_page_token}`,
    'ig-media-list');
  const ourUsername = (secrets.ig_business_username || '').toLowerCase();
  for (const post of media.data || []) {
    const page = await gj(
      `${GRAPH}/${post.id}/comments?fields=id,text,username,timestamp&limit=50&access_token=${secrets.fb_page_token}`,
      `ig-comments:${post.id}`);
    if (!(page.data || []).some((c) => !state.last_comment_ids.ig.includes(c.id))) continue;
    const resolved = await resolvePostProduct(brand, post.id);
    for (const c of page.data || []) {
      if (state.last_comment_ids.ig.includes(c.id)) continue;
      // Never reply to our own comments (self-reply loop guard); mark seen so we don't re-check.
      if (ourUsername && (c.username || '').toLowerCase() === ourUsername) { state.last_comment_ids.ig.push(c.id); continue; }
      // Skip stale comments on the fast poll; mark seen so they don't flood a first run.
      if (tooOld(c.timestamp)) { state.last_comment_ids.ig.push(c.id); continue; }
      const { action, reply } = await decide(c.text, 'comment', 'instagram', {
        username: c.username, postCaption: post.caption, recentReplies: state.recent_replies.map((r) => r.text),
        productContext: resolved ? productContextLine(resolved.product, resolved.availability) : null,
        catalogBlock: resolved ? null : brand.catBlock,
      });
      log(`IG comment ${c.id} (@${c.username || '?'}) → ${action}`);
      if (action === 'defer') { log('  AI budget hit — defer to next run'); continue; }
      if (DRY) {
        log(`  DRY public: ${reply || '(none)'}`);
        if (action === 'dm_lead') log(`  DRY private DM: ${buildProductDm(resolved?.product, resolved?.availability, state.stats.dms_from_comments)}`);
        continue; // don't send, don't mark seen
      }
      try {
        if (action === 'hide') {
          await postForm(`${GRAPH}/${c.id}`, { hide: 'true', access_token: secrets.fb_page_token }, `ig-hide:${c.id}`);
          state.stats.comments_hidden++;
        } else if (action === 'reply') {
          await postForm(`${GRAPH}/${c.id}/replies`, { message: reply, access_token: secrets.fb_page_token }, `ig-reply:${c.id}`);
          state.stats.comments_replied++;
          recordReply(state, 'instagram', reply);
        } else if (action === 'dm_lead') {
          // Public "check your DMs" + private DM with real price/sizes/link.
          await postForm(`${GRAPH}/${c.id}/replies`, { message: reply, access_token: secrets.fb_page_token }, `ig-reply:${c.id}`);
          state.stats.comments_replied++;
          recordReply(state, 'instagram', reply);
          if (!state.private_replied.ig.includes(c.id)) {
            const dmText = buildProductDm(resolved?.product, resolved?.availability, state.stats.dms_from_comments);
            try {
              await sendPrivateReply(secrets, c.id, dmText, false);
              state.private_replied.ig.push(c.id);
              state.stats.dms_from_comments++;
              log(`  private DM sent to @${c.username || '?'}`);
            } catch (e) {
              if (isAlreadyRepliedError(e)) { state.private_replied.ig.push(c.id); }
              else {
                // Privacy settings / window expired → answer publicly so they still get it.
                log(`  private DM failed (${e.message.slice(0, 120)}) — public fallback`);
                const fb = resolved?.product
                  ? `تفاصيل «${resolved.product.title}» والسعر هنا مباشرة: ${resolved.product.url} 🤍`
                  : `تلاقين كل التفاصيل والأسعار هنا: ${catalogLib.SHOP_URL} 🤍`;
                await postForm(`${GRAPH}/${c.id}/replies`, { message: fb, access_token: secrets.fb_page_token }, `ig-reply-fb:${c.id}`).catch(() => {});
              }
            }
          }
        } else if (action === 'escalate') {
          flag('IG', 'comment', c.username, c.text); state.stats.comments_escalated++;
        }
        state.last_comment_ids.ig.push(c.id);
      } catch (e) { log(`  failed: ${e.message}`); state.stats.errors++; markAuthError(e); }
    }
  }
}

async function pollFbComments(secrets, state, brand) {
  const limit = Number(process.env.MAVRX_MEDIA_LIMIT || 25);
  const posts = await gj(
    `${GRAPH}/${secrets.fb_page_id}/posts?fields=id,message,created_time&limit=${limit}&access_token=${secrets.fb_page_token}`,
    'fb-posts-list');
  for (const post of posts.data || []) {
    const page = await gj(
      `${GRAPH}/${post.id}/comments?fields=id,message,from,created_time&limit=50&order=reverse_chronological&access_token=${secrets.fb_page_token}`,
      `fb-comments:${post.id}`);
    if (!(page.data || []).some((c) => !state.last_comment_ids.fb.includes(c.id))) continue;
    const resolved = await resolvePostProduct(brand, post.id);
    for (const c of page.data || []) {
      if (state.last_comment_ids.fb.includes(c.id)) continue;
      // Never reply to the Page's own comments; mark seen so we don't re-check.
      if (c.from?.id && c.from.id === secrets.fb_page_id) { state.last_comment_ids.fb.push(c.id); continue; }
      if (tooOld(c.created_time)) { state.last_comment_ids.fb.push(c.id); continue; }
      const text = c.message || '';
      const { action, reply } = await decide(text, 'comment', 'facebook', {
        username: c.from?.name, postCaption: post.message, recentReplies: state.recent_replies.map((r) => r.text),
        productContext: resolved ? productContextLine(resolved.product, resolved.availability) : null,
        catalogBlock: resolved ? null : brand.catBlock,
      });
      log(`FB comment ${c.id} (${c.from?.name || '?'}) → ${action}`);
      if (action === 'defer') { log('  AI budget hit — defer to next run'); continue; }
      if (DRY) {
        log(`  DRY public: ${reply || '(none)'}`);
        if (action === 'dm_lead') log(`  DRY private DM: ${buildProductDm(resolved?.product, resolved?.availability, state.stats.dms_from_comments)}`);
        continue;
      }
      try {
        if (action === 'hide') {
          await postForm(`${GRAPH}/${c.id}`, { is_hidden: 'true', access_token: secrets.fb_page_token }, `fb-hide:${c.id}`);
          state.stats.comments_hidden++;
        } else if (action === 'reply') {
          await postForm(`${GRAPH}/${c.id}/comments`, { message: reply, access_token: secrets.fb_page_token }, `fb-reply:${c.id}`);
          state.stats.comments_replied++;
          recordReply(state, 'facebook', reply);
        } else if (action === 'dm_lead') {
          await postForm(`${GRAPH}/${c.id}/comments`, { message: reply, access_token: secrets.fb_page_token }, `fb-reply:${c.id}`);
          state.stats.comments_replied++;
          recordReply(state, 'facebook', reply);
          if (!state.private_replied.fb.includes(c.id)) {
            const dmText = buildProductDm(resolved?.product, resolved?.availability, state.stats.dms_from_comments);
            try {
              await sendPrivateReply(secrets, c.id, dmText, true);
              state.private_replied.fb.push(c.id);
              state.stats.dms_from_comments++;
              log(`  private DM sent to ${c.from?.name || '?'}`);
            } catch (e) {
              if (isAlreadyRepliedError(e)) { state.private_replied.fb.push(c.id); }
              else {
                log(`  private DM failed (${e.message.slice(0, 120)}) — public fallback`);
                const fb = resolved?.product
                  ? `تفاصيل «${resolved.product.title}» والسعر هنا مباشرة: ${resolved.product.url} 🤍`
                  : `تلاقين كل التفاصيل والأسعار هنا: ${catalogLib.SHOP_URL} 🤍`;
                await postForm(`${GRAPH}/${c.id}/comments`, { message: fb, access_token: secrets.fb_page_token }, `fb-reply-fb:${c.id}`).catch(() => {});
              }
            }
          }
        } else if (action === 'escalate') {
          flag('FB', 'comment', c.from?.name, text); state.stats.comments_escalated++;
        }
        state.last_comment_ids.fb.push(c.id);
      } catch (e) { log(`  failed: ${e.message}`); state.stats.errors++; markAuthError(e); }
    }
  }
}

// ───────── DMS ─────────
// Customer-facing holding message while a human takes over (Arabic/English by
// what the customer wrote).
function holdingMessage(text) {
  const looksEnglish = /^[\x00-\x7F\s]*$/.test(text || '') && /[a-z]/i.test(text || '');
  return looksEnglish
    ? 'Got your message! 🤍 Someone from our team will get back to you personally very soon.'
    : 'وصلتنا رسالتك حبيبتي 🤍 وحد من فريقنا بيرد عليك شخصيًا بأقرب وقت';
}

async function processConvo(secrets, state, brand, { convoId, platform, ourId, endpoint, isFb }) {
  const msgs = await gj(
    `${GRAPH}/${convoId}?fields=messages.limit(10){id,from,message,created_time}&access_token=${secrets.fb_page_token}`,
    `${platform}-convo:${convoId}`);
  const messages = msgs.messages?.data || [];
  if (!messages.length) return;
  const latest = messages[0]; // Graph returns newest-first
  if (!latest?.from?.id || latest.from.id === ourId) return; // latest is from us → nothing new
  if (state.last_dm_message_ids[platform][convoId] === latest.id) return; // already handled

  const text = latest.message || '';
  const platformName = platform === 'ig' ? 'instagram' : 'facebook';
  const weEverReplied = messages.some((m) => m.from?.id === ourId);
  // Chronological role-tagged transcript for the DM brain.
  const transcript = messages.slice().reverse()
    .filter((m) => m.message)
    .map((m) => ({ fromUs: m.from?.id === ourId, text: m.message }));

  // Deterministic gates first (same order as decide()), then the DM brain.
  let action, reply;
  if (!text.trim()) { action = 'skip'; }
  else if (isEscalate(text)) { action = 'escalate'; }
  else if (!hasKey()) { action = 'skip'; }
  else if (AI_BUDGET <= 0) { action = 'defer'; }
  else {
    AI_BUDGET--;
    const r = await generateDmReply({ messages: transcript, catalogBlock: brand.catBlock, platform: platformName });
    if (!r || r.error) { log(`  DM AI error: ${r ? r.error : 'no key'}`); action = 'escalate'; }
    else if (r.escalate) { action = 'escalate'; }
    else if (r.skip) { action = 'skip'; }
    else { action = 'reply'; reply = r.reply; }
  }
  if (action === 'skip' && !weEverReplied) { action = 'reply'; reply = DM_WELCOME; } // warm first touch
  log(`${platform.toUpperCase()} DM convo=${convoId} → ${action}: "${text.slice(0, 50)}"`);
  if (action === 'defer') { log('  AI budget hit — defer to next run'); return; }
  if (DRY) {
    if (action === 'reply') log(`  DRY DM reply: ${reply}`);
    if (action === 'escalate') log(`  DRY escalate → holding msg: ${holdingMessage(text)}`);
    return; // don't send, don't mark handled
  }

  try {
    if (action === 'reply' && reply) {
      await sendDm(endpoint, secrets.fb_page_token, latest.from.id, reply, isFb);
      state.stats.dms_replied++;
    } else if (action === 'escalate') {
      // Tell the customer a human is coming, then flag Omar with context.
      await sendDm(endpoint, secrets.fb_page_token, latest.from.id, holdingMessage(text), isFb).catch((e) => log(`  holding msg failed: ${e.message}`));
      const lastMsgs = transcript.slice(-3).map((m) => `${m.fromUs ? 'us' : 'them'}: ${m.text.slice(0, 80)}`).join(' | ');
      escalations.push({ platform: platform.toUpperCase(), surface: 'DM', who: latest.from.id, text: (text || '').slice(0, 160), convoId, context: lastMsgs });
      state.stats.dms_escalated++;
    }
    state.last_dm_message_ids[platform][convoId] = latest.id; // also stops the holding msg repeating
    if (!state.last_dm_first_touch[platform].includes(convoId)) state.last_dm_first_touch[platform].push(convoId);
  } catch (e) { log(`  send failed: ${e.message}`); state.stats.errors++; markAuthError(e); } // don't mark seen → retry next poll
}

async function pollDms(secrets, state, platform, brand) {
  const isFb = platform === 'fb';
  const q = isFb ? '' : 'platform=instagram&';
  const convos = await gj(
    `${GRAPH}/${secrets.fb_page_id}/conversations?${q}fields=id&limit=25&access_token=${secrets.fb_page_token}`,
    `${platform}-conversations`);
  for (const convo of convos.data || []) {
    try {
      await processConvo(secrets, state, brand, {
        convoId: convo.id, platform,
        ourId: isFb ? secrets.fb_page_id : secrets.ig_business_id,
        endpoint: `${GRAPH}/${isFb ? secrets.fb_page_id : secrets.ig_business_id}/messages`,
        isFb,
      });
    } catch (e) { log(`${platform} convo ${convo.id} error: ${e.message}`); state.stats.errors++; markAuthError(e); }
  }
}

async function sendSummary(sub, state, before) {
  const replied = state.stats.comments_replied + state.stats.dms_replied - (before.comments_replied + before.dms_replied);
  const hidden = state.stats.comments_hidden - before.comments_hidden;
  if (!replied && !hidden && !escalations.length) return; // stay silent on a quiet poll
  // Quiet mode (fast 5-min poll): Telegram only when there's something to action.
  // Routine reply/hide counts go to the job log instead of pinging 288×/day.
  if (process.env.MAVRX_TG_QUIET === '1' && !escalations.length) {
    log(`summary ${sub}: replied ${replied}, hid ${hidden} (quiet mode — no Telegram)`);
    return;
  }
  let msg = `💬 Mavrx ${sub}: replied ${replied}, hid ${hidden}, flagged ${escalations.length}.`;
  if (escalations.length) {
    msg += '\n\n🔔 Needs you (reply from the app):';
    escalations.forEach((e, i) => {
      msg += `\n${i + 1}. [${e.platform} ${e.surface}] ${e.who}: "${e.text}"`;
      if (e.context) msg += `\n   ↳ convo ${e.convoId}\n   ↳ ${e.context}`;
    });
  }
  await notify.tg(msg);
}

async function main() {
  const sub = process.argv[2];
  if (!sub) { log('usage: engage.js <fast-poll|comments-poll|dms-poll>'); process.exit(2); }
  AI_BUDGET = Number(process.env.MAVRX_AI_REPLY_BUDGET || 60);
  let secrets;
  try { secrets = meta.loadSecrets(); }
  catch (e) { await notify.tg(`🛑 Mavrx engage FAILED at secrets: ${e.message}`); log(e.message); process.exit(1); }

  const state = loadEngagement();
  const before = { ...state.stats };

  // Brand knowledge for this run — all fail-soft: a Shopify hiccup degrades to
  // the pre-catalog behavior (no DMLEAD routing, generic store-link replies).
  const catalog = await catalogLib.fetchCatalog();
  const brand = {
    catalog,
    catBlock: catalogLib.catalogBlock(catalog),
    postProducts: (loadState().post_products) || {},
  };

  try {
    const doComments = sub === 'comments-poll' || sub === 'fast-poll';
    const doDms = sub === 'dms-poll' || sub === 'fast-poll';
    if (!doComments && !doDms) { log(`unknown subcommand: ${sub}`); process.exit(2); }
    if (doComments) {
      await pollIgComments(secrets, state, brand).catch((e) => { log(`IG comments: ${e.message}`); state.stats.errors++; markAuthError(e); });
      await pollFbComments(secrets, state, brand).catch((e) => { log(`FB comments: ${e.message}`); state.stats.errors++; markAuthError(e); });
    }
    if (doDms) {
      await pollDms(secrets, state, 'ig', brand).catch((e) => { log(`IG DMs: ${e.message}`); state.stats.errors++; markAuthError(e); });
      await pollDms(secrets, state, 'fb', brand).catch((e) => { log(`FB DMs: ${e.message}`); state.stats.errors++; markAuthError(e); });
    }

    // Loud, once-a-day alert if the Meta token is dead — so it can't fail silently.
    if (authErrorSeen) {
      const today = new Date().toISOString().slice(0, 10);
      if (state.last_auth_alert_date !== today) {
        state.last_auth_alert_date = today;
        await notify.tg('🛑 Mavrx: the Meta Page token looks invalid or expired — comment/DM replies are DOWN until it is refreshed (scripts/mavrx-meta-setup.js).');
      }
    }

    // Trim processed-id arrays.
    for (const k of ['ig', 'fb']) {
      if (state.last_comment_ids[k].length > MAX_PROCESSED_IDS) state.last_comment_ids[k] = state.last_comment_ids[k].slice(-MAX_PROCESSED_IDS);
      if (state.last_dm_first_touch[k].length > MAX_PROCESSED_IDS) state.last_dm_first_touch[k] = state.last_dm_first_touch[k].slice(-MAX_PROCESSED_IDS);
      if (state.private_replied[k].length > MAX_PROCESSED_IDS) state.private_replied[k] = state.private_replied[k].slice(-MAX_PROCESSED_IDS);
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
