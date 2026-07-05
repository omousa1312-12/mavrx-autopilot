'use strict';
/*
 * catalog.js — the brand agent's product knowledge, straight from the live
 * Shopify storefront. No credentials needed: mavrxksa.com exposes
 *   /products.json            → full catalog (title, handle, variants w/ price+sku)
 *   /products/<handle>.js     → live per-variant availability (in/out of stock)
 *
 * Everything here is FAIL-SOFT: on any error, functions return null/'' and log,
 * so callers degrade to the pre-catalog behavior (generic store-link replies)
 * instead of killing a poll. A Shopify hiccup must never take engagement down.
 */
const { log } = require('./util');

const SHOP_URL = (process.env.MAVRX_SHOP_URL || 'https://mavrxksa.com').replace(/\/$/, '');
const FETCH_TIMEOUT_MS = 10000;

let _catalog = null;               // per-run cache of the parsed catalog
const _availability = new Map();   // per-run cache: handle → {size: available}

async function fetchJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

// Full catalog, normalized. Returns null on failure (fail-soft).
async function fetchCatalog() {
  if (_catalog) return _catalog;
  try {
    const j = await fetchJson(`${SHOP_URL}/products.json?limit=250`, 'catalog');
    const products = (j.products || []).map((p) => {
      const variants = (p.variants || []).map((v) => ({
        sku: v.sku || '', size: v.title || '', price: Number(v.price) || 0,
      }));
      const prices = variants.map((v) => v.price).filter((n) => n > 0);
      const firstSku = (variants.find((v) => v.sku) || {}).sku || '';
      return {
        title: p.title,
        handle: p.handle,
        url: `${SHOP_URL}/products/${p.handle}`,
        priceMin: prices.length ? Math.min(...prices) : 0,
        priceMax: prices.length ? Math.max(...prices) : 0,
        skuPrefix: firstSku.split('-')[0].toLowerCase(),
        variants,
      };
    });
    _catalog = products;
    log(`catalog: loaded ${products.length} products from ${SHOP_URL}`);
    return _catalog;
  } catch (e) {
    log(`catalog: fetch failed (${e.message}) — degrading to no-catalog behavior`);
    return null;
  }
}

// Live per-size availability for one product. Returns {size: bool} or null.
async function fetchAvailability(handle) {
  if (_availability.has(handle)) return _availability.get(handle);
  try {
    const p = await fetchJson(`${SHOP_URL}/products/${handle}.js`, `availability:${handle}`);
    const out = {};
    for (const v of p.variants || []) out[v.title] = !!v.available;
    _availability.set(handle, out);
    return out;
  } catch (e) {
    log(`catalog: availability fetch failed for ${handle} (${e.message})`);
    return null;
  }
}

// Compact prompt block — one line per product. '' when no catalog.
function catalogBlock(catalog) {
  if (!catalog || !catalog.length) return '';
  const lines = catalog.map((p) => {
    const price = p.priceMin === p.priceMax ? `${p.priceMin}` : `${p.priceMin}–${p.priceMax}`;
    const sizes = p.variants.map((v) => v.size).join('/');
    return `• ${p.title} | ${price} SAR | sizes: ${sizes} | ${p.url}`;
  });
  return lines.join('\n');
}

function findBySkuPrefix(catalog, prefix) {
  if (!catalog || !prefix) return null;
  const want = String(prefix).toLowerCase();
  return catalog.find((p) => p.skuPrefix === want) || null;
}

function findByHandle(catalog, handle) {
  if (!catalog || !handle) return null;
  return catalog.find((p) => p.handle === handle) || null;
}

module.exports = { SHOP_URL, fetchCatalog, fetchAvailability, catalogBlock, findBySkuPrefix, findByHandle };
