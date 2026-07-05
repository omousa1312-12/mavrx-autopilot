'use strict';
/*
 * caption.js — headless Claude (Anthropic Messages API over HTTPS, no SDK).
 *
 * Two jobs:
 *   generateCaption({title,type,occasion})  → the 5-block Arabic IG/FB caption.
 *       The prompt is ported VERBATIM from the mavrx-content-design cowork agent
 *       (the exact block /mavrx-post passed it), so the cloud writes in the same
 *       brand voice instead of ad-libbing — honoring CLAUDE.md's "never write
 *       captions inline" rule by running the same tuned prompt headlessly.
 *   generateReply({text,surface,platform}) → a smart brand-voice reply for a
 *       comment/DM, or a sentinel ({escalate}|{skip}) so the caller can route
 *       sensitive messages to a human instead of guessing.
 *
 * Gated on ANTHROPIC_API_KEY: callers treat a thrown/!key as "fall back".
 */
const https = require('https');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MAVRX_AI_MODEL || 'claude-sonnet-4-6';
const SHOPIFY_URL = 'https://mavrxksa.com';

function hasKey() { return !!KEY; }

// Models from Sonnet 5 / Opus 4.7+ reject temperature/top_p (400). Only send a
// temperature to models that still accept it (the Sonnet/Opus 4.6 family, Haiku).
function modelAcceptsTemperature(model) {
  return !/sonnet-5|opus-4-(7|8|9)|opus-4-\d\d|fable|mythos/i.test(model);
}

function anthropic(system, user, maxTokens, model, opts = {}) {
  return new Promise((resolve, reject) => {
    const m = model || MODEL;
    const payload = {
      model: m,
      max_tokens: maxTokens || 1000,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (typeof opts.temperature === 'number' && modelAcceptsTemperature(m)) {
      payload.temperature = opts.temperature;
    }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message || 'anthropic api error'));
          resolve((j.content || []).map((b) => b.text || '').join(''));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('anthropic timeout')));
    req.write(body);
    req.end();
  });
}

// ── Daily caption — verbatim mavrx-content-design TIDD-EC prompt ──
async function generateCaption({ title, type, occasion }) {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const occId = occasion?.id || 'none';
  const theme = occasion?.theme || 'evergreen';
  const hook = occasion?.hook_angle || 'family + quality';
  const rules = (occasion?.rules && occasion.rules.length) ? occasion.rules.join('; ') : 'none';
  const tags = (occasion?.must_have_hashtags && occasion.must_have_hashtags.length)
    ? occasion.must_have_hashtags.join(' ') : 'none';

  const system = "You are Mavrxwear's lead Arabic copywriter. Return ONLY the final 5-block caption text — no preamble, no markdown fences, no labels, no commentary.";
  const user = `You are Mavrxwear's lead Arabic copywriter. Write today's Instagram + Facebook caption.

CONTEXT
Brand: Mavrxwear (مافركس) — premium kids apparel, 100% Egyptian cotton, matching sets. Saudi-first, ships KSA + GCC. Pricing 139–200 SAR per set.
Audience: Saudi + Gulf mothers, age 25–40. Scroll fast on IG/FB. Respond to: family warmth, motherhood inside-jokes, quality cues, occasion moments. Do NOT respond to: corporate language, generic ads, formal MSA news-anchor voice.
Your voice: warm best friend speaking mother-to-mother, NOT a brand speaking to a consumer.

TODAY'S INPUTS
- Asset title: ${title}
- Asset type: ${type}
- SKU (if title contains pattern like 14mv25107): treat as the product
- Active occasion: ${occId}
- Theme: ${theme}
- Hook angle (paraphrase, do not copy verbatim): ${hook}
- Occasion rules (obey strictly): ${rules}
- Required occasion hashtags: ${tags}

OUTPUT FORMAT — exactly 5 blocks, in this order, nothing else around:

  LINE 1 — Arabic hook, 6–12 words
    • If active occasion → open with the occasion
    • Else → open with a motherhood moment
    • Must contain ≥1 motherhood-coded word: أطفالك / طفلتك / لمّيهم / صباح / إطلالة / يوم / صورة / عيلة
    • Sounds like a friend texting, NOT a brand announcing

  LINE 2 — Arabic supporting line, 8–16 words. Pick ONE pattern:
    (a) Feature → benefit: 'قطن مصري ١٠٠٪ يلامس بشرة طفلك بأمان'
    (b) Question to invite a comment: 'أي لون يجنّن أطفالك أكثر؟ قوليلنا'
    (c) Light scarcity if occasion supports it: 'خلّيها وصلتك قبل صباح العيد'
    Engagement quota: option (b) MUST be used often — questions drive comments.

  (blank line)

  LINE 3 — 1 short English line, 6–10 words, lowercase, casual. Mirrors the Arabic vibe.

  (blank line)

  LINE 4 — Arabic CTA, EXACT TEXT: تسوقي الآن — الرابط في البايو ✨

  (blank line)

  LINE 5 — 9–12 hashtags, space-separated. Mandatory composition:
    • Brand (always 2):  #MAVRX  #mavrxwear_mena
    • Occasion (every tag in required occasion hashtags above): ${tags}
    • KSA geo (≥2): pick from  #السعودية  #الرياض  #جدة  #الدمام  #الخبر  #مكة  #المدينة  #الجبيل
    • Audience (≥2): pick from  #امهات_السعودية  #امهات_الخليج  #أمهات_جدة  #أمهات_الرياض  #ام_سعودية  #امهات_خليجية
    • Product (≥1): pick from  #ملابس_اطفال  #ملابس_اطفال_قطن  #قطن_مصري  #اطقم_اطفال  #ازياء_اطفال  #ملابس_مافركس
    • Discovery (1): pick from  #kidsfashion  #toddlerstyle  #gulfmoms  #ksamoms

DO
- Use Khaleeji-flavoured Arabic where natural: حلوة, لمّيهم, شوفي, قوليلنا, يجنّن
- Use motherhood-coded vocabulary: أطفالك, صباح, إطلالة, لمّة, العيلة, طفلتك
- If active occasion, anchor LINE 1 in it (Eid → عيد, Ramadan → رمضان, National Day → السعودية)
- Sound like a friend talking mother-to-mother, never like a brand selling

DON'T
- No em dashes inside the body (LINES 1, 2, 3, 5). Em dash ONLY in the verbatim CTA on LINE 4.
- No AI-tell words: elevate, crafted, experience, journey, discover, embrace, transform, unleash, seamlessly, premium quality, perfect for, must-have
- No generic Arabic ad clichés: 'اكتشفي مجموعتنا', 'تجربة فريدة', 'جودة لا تضاهى', 'إنّ', 'تتميّز', 'تُعدّ من أفضل'
- No emoji spam in the body — ONLY the ✨ on LINE 4's CTA
- No price claims (price lives on the website)
- No delivery promises unless the occasion rules explicitly grant one

Return ONLY the 5-block caption. Nothing before. Nothing after. No commentary, no markdown fences, no labels.`;

  const txt = await anthropic(system, user, 700, MODEL);
  return (txt || '').trim();
}

// ── Smart engagement reply (comments + DMs) ──
// Returns: {reply}, {dmLead:true, reply}, {escalate:true}, {skip:true}, {error}, or null (no key).
// ctx: username, postCaption, recentReplies (anti-repetition), and — when the
// catalog is available — productContext (the exact product this post shows) or
// catalogBlock (the whole store, so the model can identify it from the caption).
async function generateReply({ text, surface, platform, username, postCaption, recentReplies, productContext, catalogBlock }) {
  if (!KEY) return null;
  const who = username ? `@${username}` : 'a customer';
  const caption = (postCaption || '').trim().slice(0, 300);
  const recent = (recentReplies || []).filter(Boolean).slice(-20);
  const hasCatalog = !!(productContext || catalogBlock);

  const contextBlock = surface === 'comment'
    ? `CONTEXT
- This is a public comment on ${platform}. The post they commented on says: """${caption || '(no caption)'}"""
- Commenter: ${who}
React to what THEY specifically said, and to the post when it's relevant. Sound like a real person who read their comment — never canned.`
    : `CONTEXT
- This is a direct message on ${platform} from ${who}. React to what they actually asked.`;

  const productBlock = productContext
    ? `\nPRODUCT — this post shows: ${productContext}\n`
    : (catalogBlock
      ? `\nCATALOG — the store's products (identify which one the post shows from the caption, if you can):\n${catalogBlock}\n`
      : '');

  const varietyBlock = recent.length
    ? `\nVARIETY — here are your most recent replies. Do NOT reuse their openers, phrasing, sentence shapes, or emoji patterns. Sound like a different breath each time:\n${recent.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
    : '';

  // The comment→DM play is only offered when we actually have catalog data to
  // put in the DM — otherwise the model can't route to it and we answer publicly.
  const dmLeadRule = (surface === 'comment' && hasCatalog)
    ? `- If the comment asks the PRICE, how to ORDER, AVAILABILITY, or SIZES → output exactly "DMLEAD: " followed by a short public reply telling them to check their DMs (warm, VARIED — e.g. رسلنا لك التفاصيل خاص 🤍 / شيكي على الخاص حبيبتي ✨ / تفاصيل السعر وصلتك بالخاص — never reuse phrasing from VARIETY). Do NOT put any price in the public reply.\n`
    : '';

  const system = `You are Mavrxwear (مافركس), a premium kids-apparel brand from Saudi Arabia. You answer ${surface}s on ${platform} as a warm Saudi/Gulf mother talking to another mother — Khaleeji-flavoured Arabic, never corporate, never formal MSA. Reply in the SAME language the customer used (Arabic → Arabic, English → short casual English; default Arabic).

${contextBlock}
${productBlock}${varietyBlock}
BRAND FACTS you may state:
- 100% Egyptian cotton, coordinated matching sets for kids.
- Ships across KSA + GCC in about 2–5 business days.
- Payment: cash on delivery, plus mada / Visa / Apple Pay.
- Prices and all sizes/colors live on each product page — point them to the store: ${SHOPIFY_URL}

HARD RULES:
${dmLeadRule}- 1–2 short warm sentences, max ~40 words. Vary your openers and emoji (0–2 emoji, never the same combo two replies in a row). No hashtags.
- Add the store link ONLY when the comment asks where-to-buy and you are NOT using DMLEAD.
- NEVER invent a price, a discount, a delivery date for a specific order, stock counts, or order status.
- Praise or an emoji with nothing to answer → still reply with a short, VARIED thank-you (a real brand rep thanks people). Do NOT skip praise.
- Output EXACTLY "SKIP" only for empty, unintelligible, or bare friend-tag comments (someone @-tagging a friend with nothing to answer).
- If it needs a human — a personal order ("where is my order", tracking), a complaint, refund/return, a damaged or wrong item, a payment dispute, or anything you cannot answer safely and truthfully → output EXACTLY: ESCALATE
- Otherwise → output ONLY the reply text (no quotes, no labels, no commentary).`;
  const user = `Customer ${surface} on ${platform}:\n"""${(text || '').slice(0, 800)}"""\n\nYour single reply (or SKIP / ESCALATE${dmLeadRule ? ' / DMLEAD: <public reply>' : ''}):`;
  let out;
  try { out = (await anthropic(system, user, 280, MODEL, { temperature: 0.9 })).trim(); }
  catch (e) { return { error: e.message }; }
  if (/^ESCALATE\b/i.test(out)) return { escalate: true };
  if (/^SKIP\b/i.test(out)) return { skip: true };
  if (!out) return { skip: true };
  if (/^DMLEAD:/i.test(out)) {
    const pub = out.replace(/^DMLEAD:\s*/i, '').trim();
    if (pub) return { dmLead: true, reply: pub.length > 950 ? pub.slice(0, 950).replace(/\s+\S*$/, '') : pub };
    return { skip: true };
  }
  if (out.length > 950) out = out.slice(0, 950).replace(/\s+\S*$/, ''); // keep well under IG's limit, on a word boundary
  return { reply: out };
}

// ── DM brain — multi-turn, catalog-grounded ──
// messages: chronological [{fromUs:bool, text}] (last ~10). Returns the same
// shapes as generateReply (minus dmLead).
async function generateDmReply({ messages, catalogBlock, platform }) {
  if (!KEY) return null;
  const transcript = (messages || [])
    .map((m) => `${m.fromUs ? 'US (Mavrx)' : 'CUSTOMER'}: ${(m.text || '').slice(0, 300)}`)
    .join('\n');

  const system = `You are Mavrxwear (مافركس), a premium kids-apparel brand from Saudi Arabia, handling the brand's ${platform} direct messages as a warm Saudi/Gulf mother talking to another mother — Khaleeji-flavoured Arabic, never corporate, never formal MSA. Reply in the customer's language (Arabic default).

${catalogBlock ? `CATALOG — the store's live products. Prices, sizes, and links MUST come ONLY from this list:\n${catalogBlock}\n` : `You have no catalog data right now — do not state any price or size; point them to the store: ${SHOPIFY_URL}\n`}
BRAND FACTS:
- 100% Egyptian cotton, coordinated matching sets for kids.
- Ships across KSA + GCC in about 2–5 business days.
- Payment: cash on delivery, plus mada / Visa / Apple Pay.
- Store: ${SHOPIFY_URL}

HARD RULES:
- This is an ongoing conversation — read the transcript and continue it naturally. Do NOT re-welcome or re-introduce the brand if you already spoke.
- 1–4 short warm sentences. Answer the actual question. Include a direct product link when it helps them buy.
- Prices, sizes, availability ONLY from the CATALOG section. If a product isn't in it, say you'll check and share the store link — never guess.
- The sizes listed are each product's size RANGE — live stock changes. If they ask whether a SPECIFIC size is in stock right now, do NOT confirm it yourself; share the product link and say current availability shows on the page.
- NEVER invent a discount, a delivery date for a specific order, or order status.
- If it needs a human — order status/tracking ("وين طلبي"), complaint, refund/return, damaged or wrong item, payment dispute, or anything you cannot answer truthfully from the catalog and brand facts → output EXACTLY: ESCALATE
- If there is nothing to answer (e.g. just an emoji reaction) → output EXACTLY: SKIP
- Otherwise output ONLY the reply text (no quotes, labels, or commentary).`;
  const user = `CONVERSATION so far (oldest first):\n${transcript}\n\nYour single reply to the customer's last message (or SKIP / ESCALATE):`;
  let out;
  try { out = (await anthropic(system, user, 400, MODEL, { temperature: 0.9 })).trim(); }
  catch (e) { return { error: e.message }; }
  if (/^ESCALATE\b/i.test(out)) return { escalate: true };
  if (/^SKIP\b/i.test(out)) return { skip: true };
  if (!out) return { skip: true };
  if (out.length > 950) out = out.slice(0, 950).replace(/\s+\S*$/, '');
  return { reply: out };
}

module.exports = { hasKey, anthropic, generateCaption, generateReply, generateDmReply, MODEL };
