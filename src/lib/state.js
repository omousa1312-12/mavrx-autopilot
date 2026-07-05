'use strict';
/*
 * state.js — load/save the post + engagement state.
 *
 * On GitHub Actions, state lives in <repo>/state/ and is committed back after
 * each run (set MAVRX_STATE_DIR=$GITHUB_WORKSPACE/state in the workflow).
 * Locally it can point at ~/.claude/mavrx-posts for parity with the Mac flow.
 */
const path = require('path');
const { loadJson, writeJson } = require('./util');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.MAVRX_STATE_DIR || path.join(REPO_ROOT, 'state');

const STATE_FILE = path.join(STATE_DIR, 'state.json');
const ENGAGEMENT_FILE = path.join(STATE_DIR, 'engagement.json');
const CALENDAR_FILE = path.join(STATE_DIR, 'ksa-calendar.json');

const DEFAULT_STATE = {
  next_mode: 'FEED',
  posted_assets: [],         // filenames already posted (dedupe for /assets queue)
  last_feed_asset: null,     // filename re-shared on the next STORY day
  posted_drive_ids: [],      // legacy (Drive source); unused by the /assets path
  last_feed_drive_id: null,
  last_feed_drive_title: null,
  last_run_date: null,
  last_published_status: null,
  last_ig_post_id: null,
  last_fb_post_id: null,
  last_ig_story_id: null,
  last_active_occasion: null,
  cross_last_dispatch_date: null,
  cross_history: [],
  post_products: {},         // { ig/fb post id: {sku_prefix, handle, title, price, matched} } — written at publish
};

const DEFAULT_ENGAGEMENT = {
  last_comment_ids: { ig: [], fb: [] },
  last_dm_first_touch: { ig: [], fb: [] },
  last_dm_message_ids: { ig: {}, fb: {} },
  recent_replies: [],        // rolling window of the last ~20 sent replies (for anti-repetition)
  last_auth_alert_date: null, // dedupes the "token dead" Telegram alert to once/day
  private_replied: { ig: [], fb: [] }, // comment ids already privately DM'd (Meta allows exactly one per comment)
  stats: { comments_replied: 0, comments_liked: 0, comments_hidden: 0, dms_replied: 0, dms_escalated: 0, comments_escalated: 0, dms_from_comments: 0, errors: 0 },
};

function loadState() {
  return { ...DEFAULT_STATE, ...(loadJson(STATE_FILE, {}) || {}) };
}
function saveState(s) { writeJson(STATE_FILE, s); }

function loadEngagement() {
  const s = { ...DEFAULT_ENGAGEMENT, ...(loadJson(ENGAGEMENT_FILE, {}) || {}) };
  s.last_comment_ids = { ig: [], fb: [], ...(s.last_comment_ids || {}) };
  s.last_dm_first_touch = { ig: [], fb: [], ...(s.last_dm_first_touch || {}) };
  s.last_dm_message_ids = { ig: {}, fb: {}, ...(s.last_dm_message_ids || {}) };
  s.recent_replies = Array.isArray(s.recent_replies) ? s.recent_replies : [];
  if (typeof s.last_auth_alert_date === 'undefined') s.last_auth_alert_date = null;
  s.private_replied = { ig: [], fb: [], ...(s.private_replied || {}) };
  s.stats = { ...DEFAULT_ENGAGEMENT.stats, ...(s.stats || {}) };
  return s;
}
function saveEngagement(s) { writeJson(ENGAGEMENT_FILE, s); }

function loadCalendar() { return loadJson(CALENDAR_FILE, {}); }

module.exports = {
  STATE_DIR, STATE_FILE, ENGAGEMENT_FILE, CALENDAR_FILE,
  loadState, saveState, loadEngagement, saveEngagement, loadCalendar,
};
