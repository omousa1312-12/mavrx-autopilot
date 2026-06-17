'use strict';
/*
 * util.js — tiny shared helpers (no deps).
 */
const fs = require('fs');
const path = require('path');

// Asia/Riyadh calendar date as YYYY-MM-DD (en-CA locale → ISO-ish ordering).
function todayRiyadh() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
}

// Whole days between two YYYY-MM-DD strings (b - a).
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

function loadJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Truthy env flag: "1", "true", "yes" (case-insensitive). Empty/unset → false.
function envFlag(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || '').trim());
}

function log(msg) {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { todayRiyadh, daysBetween, loadJson, writeJson, envFlag, log, sleep };
