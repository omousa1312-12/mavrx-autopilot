'use strict';
/*
 * crossbundle.js — TikTok + Snap hand-off.
 *
 * There is no $0 headless API for organic TikTok/Snap posting, so we can't
 * fully auto-post there. Instead, on the same 2-day cadence the Mac flow used,
 * we send the day's hero asset + ready-made Snap/TikTok captions to Telegram so
 * Omar taps "post" on his phone (~10s). Occasion captions are ported verbatim
 * from scripts/mavrx-cross-dispatch.js (existing brand copy, not freshly written).
 */
const { todayRiyadh, daysBetween, log } = require('./util');
const { resolveOccasion } = require('./occasion');
const notify = require('./notify');

const CAPTIONS = {
  eid_aladha_1447: {
    snap: `عيد مبارك من مافركس 🤍`,
    tiktok: `صباح العيد لمّي اطفالك بإطلالات متطابقة 🤍\n\n#عيد_الاضحى #عيد_مبارك #اطفال_السعودية #الرياض #جدة #fyp #اكسبلور #mavrxwear_mena #MAVRX`,
  },
  eid_alfitr_1447: {
    snap: `كل عام وانتم بخير ✨ #MAVRX`,
    tiktok: `اطقم العيد جاهزة 🤍 اطلالة موحدة لصور صباح العيد\n\n#عيد_الفطر #ملابس_العيد #امهات_السعودية #اطفال_الخليج #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  ramadan_1447: {
    snap: `رمضان كريم من مافركس 🌙`,
    tiktok: `اطقم تجمع العيلة في لمّة رمضان 🌙\n\n#رمضان_كريم #رمضان_2026 #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  ramadan_1448: {
    snap: `رمضان كريم من مافركس 🌙`,
    tiktok: `اطقم تجمع العيلة في لمّة رمضان 🌙\n\n#رمضان_كريم #رمضان_2027 #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  saudi_national_day: {
    snap: `كلنا السعودية 🇸🇦 #MAVRX`,
    tiktok: `اطقم اطفال صنعت لاطفال السعودية 🤍🇸🇦\n\n#اليوم_الوطني_السعودي #كلنا_السعودية #السعودية #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  saudi_founding_day: {
    snap: `يوم التأسيس 🇸🇦 #MAVRX`,
    tiktok: `جذورنا وفخرنا 🤍🇸🇦\n\n#يوم_التأسيس #يوم_تأسيس_الدولة_السعودية #السعودية #امهات_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  white_friday: {
    snap: `وايت فرايداي على ابواب مافركس 🛒`,
    tiktok: `جهزي طلب اطفالك 🛒\n\n#وايت_فرايدي #WhiteFriday #السعودية #امهات_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  back_to_school: {
    snap: `جاهزين للمدرسة 🎒 #MAVRX`,
    tiktok: `اطقم مريحة لاول يوم مدرسة 🎒\n\n#العودة_للمدارس #مدارس_2026 #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  summer_break: {
    snap: `صيف اطفالنا 🌞 #MAVRX`,
    tiktok: `اطقم خفيفة لرحلات الصيف 🌞\n\n#صيف_2026 #رحلات_العائلة #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  winter_layering: {
    snap: `قطن دافي شتاء اطفالك 🤍 #MAVRX`,
    tiktok: `اكمام طويلة من قطن مصري دافي بدون ثقل 🤍\n\n#شتاء_2026 #ملابس_شتوية #امهات_السعودية #اطفال_السعودية #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
  evergreen: {
    snap: `اطلالات اطفالنا اليوم 🤍`,
    tiktok: `اطقم اطفال قطن مصري ١٠٠٪ 🤍\nاطلالات موحدة لصور العيلة\n\n#امهات_السعودية #اطفال_السعودية #الرياض #جدة #اطقم_اطفال #قطن_مصري #fyp #اكسبلور #MAVRX #mavrxwear_mena`,
  },
};

const VIDEO_RE = /\.(mp4|mov|m4v)$/i;

// Self-gates on the 2-day cadence. Mutates state.cross_* and returns a summary.
async function maybeCrossDispatch(state, calendar, heroPath, heroName) {
  const t = todayRiyadh();
  const last = state.cross_last_dispatch_date || null;
  if (last && daysBetween(last, t) < 2) {
    return { skipped: true, reason: `cadence (last ${last})` };
  }
  if (!notify.enabled) {
    log('cross-dispatch: Telegram not configured — skipping hand-off');
    return { skipped: true, reason: 'no telegram' };
  }
  const occ = resolveOccasion(calendar);
  const preset = CAPTIONS[occ?.id] || CAPTIONS.evergreen;
  const isVid = VIDEO_RE.test(heroName);
  const caption =
    `📲 TikTok + Snap hand-off — post on your phone (~10s)\n` +
    `Occasion: ${occ?.id || 'evergreen'}\n\n` +
    `══ SNAP ══\n${preset.snap}\n\n` +
    `══ TIKTOK ══\n${preset.tiktok}`;
  await notify.tgMedia(heroPath, caption, isVid);

  state.cross_last_dispatch_date = t;
  state.cross_history = Array.isArray(state.cross_history) ? state.cross_history : [];
  state.cross_history.unshift({ date: t, asset: heroName, occasion: occ?.id || 'evergreen' });
  state.cross_history = state.cross_history.slice(0, 30);
  return { dispatched: true, occasion: occ?.id || 'evergreen' };
}

module.exports = { maybeCrossDispatch };
