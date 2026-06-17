'use strict';
/*
 * occasion.js — resolve today's KSA occasion from ksa-calendar.json.
 * Ported verbatim from scripts/mavrx-cross-dispatch.js resolveOccasion() so
 * the cloud picks the exact same hook angle the Mac flow used.
 * Priority: lunar_dates → fixed_dates → seasonal.
 */
const { todayRiyadh } = require('./util');

function resolveOccasion(cal) {
  if (!cal) return null;
  const t = todayRiyadh();
  const [y, m, d] = t.split('-').map(Number);
  const mmdd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  for (const lunar of cal.lunar_dates || []) {
    if (t >= lunar.start && t <= lunar.end) return lunar;
  }
  for (const fixed of cal.fixed_dates || []) {
    if (fixed.match_range) {
      const [s, e] = fixed.match_range.split('..');
      if (mmdd >= s && mmdd <= e) return fixed;
    } else if (fixed.match) {
      const [fm, fd] = fixed.match.split('-').map(Number);
      const fixedDate = new Date(Date.UTC(y, fm - 1, fd));
      const todayDate = new Date(Date.UTC(y, m - 1, d));
      const diff = Math.round((todayDate - fixedDate) / 86400000);
      const [lo, hi] = fixed.window_days || [0, 0];
      if (diff >= lo && diff <= hi) return fixed;
    }
  }
  for (const seasonal of cal.seasonal || []) {
    if (seasonal.match_range) {
      const [s, e] = seasonal.match_range.split('..');
      if (s <= e) {
        if (mmdd >= s && mmdd <= e) return seasonal;
      } else {
        if (mmdd >= s || mmdd <= e) return seasonal; // wrap-around (e.g. 11-01..01-31)
      }
    }
  }
  return null;
}

module.exports = { resolveOccasion };
