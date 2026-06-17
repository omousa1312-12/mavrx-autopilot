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

function anthropic(system, user, maxTokens, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || MODEL,
      max_tokens: maxTokens || 1000,
      system,
      messages: [{ role: 'user', content: user }],
    });
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
// Returns one of: {reply}, {escalate:true}, {skip:true}, {error}, or null (no key).
async function generateReply({ text, surface, platform }) {
  if (!KEY) return null;
  const system = `You are Mavrxwear (مافركس), a premium kids-apparel brand from Saudi Arabia. You answer ${surface}s on ${platform} in the brand's voice: a warm Saudi/Gulf mother talking to another mother. Khaleeji-flavoured Arabic, never corporate, never formal MSA. Reply in the SAME language the customer used (Arabic → Arabic, English → short casual English).

BRAND FACTS you may state:
- 100% Egyptian cotton, coordinated matching sets for kids.
- Ships across KSA + GCC in about 2–5 business days.
- Payment: cash on delivery, plus mada / Visa / Apple Pay.
- Prices and all sizes/colors are on each product page — point them to the store: ${SHOPIFY_URL}

HARD RULES:
- Keep it to 1–2 short warm lines. Add the store link only when it actually helps (price/size/where-to-buy/availability).
- NEVER invent a price, a discount, a delivery date for a specific order, stock counts, or order status.
- If the message is praise/an emoji with nothing to answer → output EXACTLY: SKIP
- If the message needs a human — a personal order ("where is my order", tracking), a complaint, refund/return, a damaged or wrong item, a payment dispute, or anything you cannot answer safely and truthfully → output EXACTLY: ESCALATE
- Otherwise → output ONLY the reply text (no quotes, no labels, no commentary).`;
  const user = `Customer ${surface} on ${platform}:\n"""${(text || '').slice(0, 800)}"""\n\nYour single reply (or SKIP / ESCALATE):`;
  let out;
  try { out = (await anthropic(system, user, 280, MODEL)).trim(); }
  catch (e) { return { error: e.message }; }
  if (/^ESCALATE\b/i.test(out)) return { escalate: true };
  if (/^SKIP\b/i.test(out)) return { skip: true };
  if (!out) return { skip: true };
  return { reply: out };
}

module.exports = { hasKey, anthropic, generateCaption, generateReply, MODEL };
