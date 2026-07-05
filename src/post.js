#!/usr/bin/env node
'use strict';
/*
 * post.js — the daily Mavrx post, fully headless (no MCP, no Claude session).
 *
 * Headless port of the /mavrx-post skill state machine (FEED ↔ STORY,
 * occasion-aware). The post queue is the repo's /assets folder. Writes the
 * Arabic caption with the ported brand-voice prompt, publishes to IG + FB via
 * the Meta Graph API, advances state, hands off TikTok/Snap, reports to
 * Telegram. Runs on a GitHub Actions cron with the Mac off.
 *
 * Env:
 *   DRY_RUN=1     do everything except the actual publish (logs would-be post)
 *   FORCE_RUN=1   ignore the same-day date gate
 * Secrets (env): META_SECRETS_JSON, ANTHROPIC_API_KEY,
 *                TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Exit non-zero ONLY on a real failure; a clean no-op (already posted / dry run
 * / empty pool) exits 0.
 */
const fs = require('fs');

const { todayRiyadh, envFlag, log } = require('./lib/util');
const { loadState, saveState, loadCalendar } = require('./lib/state');
const { resolveOccasion } = require('./lib/occasion');
const assets = require('./lib/assets');
const meta = require('./lib/meta');
const { generateCaption, anthropic, hasKey, MODEL } = require('./lib/caption');
const catalogLib = require('./lib/catalog');
const notify = require('./lib/notify');
const { maybeCrossDispatch } = require('./lib/crossbundle');

const STORY_CAPTION = '👆 شوفي بوست اليوم في البروفايل\nSee today\'s post — link in bio ✨';
const DRY = envFlag('DRY_RUN');
const FORCE = envFlag('FORCE_RUN');

function rankScore(f) {
  if (f.isVideo && f.size > 5 * 1024 * 1024) return 3;
  if (!f.isVideo && f.size > 800 * 1024) return 2;
  return 1;
}

// Identify which catalog product this post shows, so the engagement agent can
// answer "how much is this?" with the exact price/link. SKU-in-filename first
// (e.g. 02mv25202-...), else one cheap Claude match on filename+caption. All
// fail-soft — an unmapped post just falls back to caption+catalog matching.
async function matchPostProduct(assetName, caption) {
  try {
    const catalog = await catalogLib.fetchCatalog();
    if (!catalog) return null;
    const m = assetName.match(/\d{2}mv\d{5}/i);
    if (m) {
      const p = catalogLib.findBySkuPrefix(catalog, m[0].toLowerCase());
      if (p) return { sku_prefix: p.skuPrefix, handle: p.handle, title: p.title, price: p.priceMin, matched: 'sku' };
    }
    if (!hasKey()) return null;
    const list = catalog.map((p) => `${p.handle} | ${p.title}`).join('\n');
    const out = (await anthropic(
      'You match a social post to a store product. Output ONLY the product handle from the list, or NONE. No commentary.',
      `Post asset filename: ${assetName}\nPost caption:\n"""${(caption || '').slice(0, 500)}"""\n\nProducts (handle | title):\n${list}\n\nWhich product does this post show? Output the handle or NONE:`,
      50, MODEL,
    )).trim().toLowerCase();
    if (out && out !== 'none') {
      const p = catalogLib.findByHandle(catalog, out);
      if (p) return { sku_prefix: p.skuPrefix, handle: p.handle, title: p.title, price: p.priceMin, matched: 'claude' };
    }
  } catch (e) { log(`post-product match failed (${e.message}) — post stays unmapped`); }
  return null;
}

async function runFeed(state, calendar, occasion) {
  const all = assets.listAssets();
  const used = new Set(state.posted_assets || []);
  const fresh = all.filter((f) => !used.has(f.name));
  log(`FEED: ${all.length} assets in /assets, ${fresh.length} unused`);
  if (!fresh.length) {
    await notify.tg('⚠️ Mavrx: post queue empty. Add photos/videos to the repo /assets folder (GitHub app works) — nothing posted today.');
    log('LOW_STOCK — not advancing state');
    return { status: 'low-stock' };
  }
  fresh.sort((a, b) => rankScore(b) - rankScore(a));
  const chosen = fresh[0];
  log(`FEED pick: ${chosen.name} (${chosen.isVideo ? 'video' : 'image'}, ${(chosen.size / 1024).toFixed(0)} KB)`);

  const caption = await generateCaption({
    title: chosen.name, type: chosen.isVideo ? 'video' : 'image', occasion,
  });
  if (!caption) throw new Error('caption generation returned empty');
  log(`caption (${caption.length} chars): ${caption.slice(0, 80).replace(/\n/g, ' ')}…`);

  if (DRY) {
    await notify.tg(`🧪 DRY RUN — FEED\nAsset: ${chosen.name}\nOccasion: ${occasion?.id || 'none'}\n\n${caption}`);
    log('DRY_RUN — skipping publish, not advancing state');
    return { status: 'dry-run', asset: chosen.name };
  }

  const secrets = meta.loadSecrets();
  const res = await meta.publishFeed({ imagePath: chosen.path, caption, secrets });
  log(`published FEED: ${JSON.stringify(res)}`);

  state.next_mode = 'STORY';
  state.posted_assets = state.posted_assets || [];
  state.posted_assets.push(chosen.name);
  state.last_feed_asset = chosen.name;
  state.last_run_date = todayRiyadh();
  state.last_published_status = 'live';
  state.last_ig_post_id = res.ig_post_id;
  state.last_fb_post_id = res.fb_post_id;
  state.last_active_occasion = occasion?.id || null;

  // Map this post to the product it shows (for the engagement agent). Fail-soft.
  const productEntry = await matchPostProduct(chosen.name, caption);
  if (productEntry) {
    state.post_products = state.post_products || {};
    if (res.ig_post_id) state.post_products[res.ig_post_id] = productEntry;
    if (res.fb_post_id) state.post_products[res.fb_post_id] = productEntry;
    log(`post-product map: ${productEntry.handle} (${productEntry.matched})`);
  }

  saveState(state); // record the publish durably BEFORE cross-dispatch / notify

  const cross = await maybeCrossDispatch(state, calendar, chosen.path, chosen.name);
  saveState(state);

  const warn = [
    res.ig_error && `⚠️ IG failed: ${res.ig_error}`,
    res.fb_error && `⚠️ FB failed: ${res.fb_error}`,
  ].filter(Boolean).join('\n');
  await notify.tg(
    `📸 Mavrx FEED posted (${res.media_type})\nAsset: ${chosen.name}\nOccasion: ${occasion?.id || 'none'}\nIG: ${res.ig_post_id || '—'}\nFB: ${res.fb_post_id || '—'}\n` +
    (warn ? warn + '\n' : '') +
    (cross.dispatched ? '📲 TikTok/Snap hand-off sent above.' : `TikTok/Snap: ${cross.reason || 'n/a'}`),
  );
  return { status: 'live', ...res };
}

async function runStory(state, calendar) {
  const name = state.last_feed_asset;
  const p = name ? assets.assetPath(name) : null;
  if (!name || !p || !fs.existsSync(p)) {
    state.next_mode = 'FEED';
    state.last_run_date = todayRiyadh();
    saveState(state);
    await notify.tg('⚠️ Mavrx: STORY day but the parent asset is gone — reset to FEED for next run.');
    log('MISSING_PARENT — reset to FEED');
    return { status: 'missing-parent' };
  }
  if (DRY) {
    await notify.tg(`🧪 DRY RUN — STORY\nParent: ${name}`);
    log('DRY_RUN — skipping story publish, not advancing state');
    return { status: 'dry-run' };
  }
  const secrets = meta.loadSecrets();
  const res = await meta.publishStory({ imagePath: p, secrets });
  log(`published STORY: ${JSON.stringify(res)}`);

  state.next_mode = 'FEED';
  state.last_run_date = todayRiyadh();
  state.last_published_status = 'live';
  state.last_ig_story_id = res.ig_story_id;
  saveState(state); // record the publish durably first

  const cross = await maybeCrossDispatch(state, calendar, p, name);
  saveState(state);

  await notify.tg(
    `📸 Mavrx STORY posted (IG only)\nParent: ${name}\nStory: ${res.ig_story_id}\n` +
    (cross.dispatched ? '📲 TikTok/Snap hand-off sent above.' : `TikTok/Snap: ${cross.reason || 'n/a'}`),
  );
  return { status: 'live', ...res };
}

async function main() {
  const state = loadState();
  const calendar = loadCalendar();
  const today = todayRiyadh();

  if (state.last_run_date === today && !FORCE) {
    log(`already posted today (${today}) — no-op. Set FORCE_RUN=1 to override.`);
    return;
  }

  const occasion = resolveOccasion(calendar);
  log(`mode=${state.next_mode} today=${today} occasion=${occasion?.id || 'none'} dry=${DRY} force=${FORCE}`);

  try {
    const out = state.next_mode === 'FEED'
      ? await runFeed(state, calendar, occasion)
      : await runStory(state, calendar);
    log(`done: ${JSON.stringify(out)}`);
  } catch (e) {
    // Real failure (publish/caption). Do NOT advance state — retry next run.
    await notify.tg(`🛑 Mavrx ${state.next_mode} post FAILED: ${e.message}\n(state not advanced — will retry next run)`);
    log(`FATAL: ${e.message}\n${e.stack || ''}`);
    process.exit(1);
  }
}

if (require.main === module) main();
