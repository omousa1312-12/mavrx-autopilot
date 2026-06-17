'use strict';
/*
 * assets.js — the post queue is just files in the repo's /assets folder.
 *
 * This replaces the Google Drive service-account path (drive.js, kept as an
 * optional advanced source) so there is NO Google Cloud setup. Omar drops
 * photos/videos into /assets (drag-drop, or the GitHub mobile/web app), commits,
 * and the bot posts one per day, deduping by filename via state.posted_assets.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ASSETS_DIR = process.env.MAVRX_ASSETS_DIR || path.join(REPO_ROOT, 'assets');
const VIDEO = new Set(['mp4', 'mov', 'm4v']);
const PHOTO = new Set(['jpg', 'jpeg', 'png', 'webp']);

function isVideoName(n) { return VIDEO.has(path.extname(n).slice(1).toLowerCase()); }

// All media files currently in /assets → [{name, path, size, isVideo}].
function listAssets() {
  if (!fs.existsSync(ASSETS_DIR)) return [];
  return fs.readdirSync(ASSETS_DIR)
    .filter((n) => !n.startsWith('.') && n.toLowerCase() !== 'readme.md')
    .map((n) => {
      const p = path.join(ASSETS_DIR, n);
      let size = 0; try { size = fs.statSync(p).size; } catch { /* skip */ }
      const ext = path.extname(n).slice(1).toLowerCase();
      return { name: n, path: p, size, isVideo: VIDEO.has(ext), isMedia: VIDEO.has(ext) || PHOTO.has(ext) };
    })
    .filter((f) => f.isMedia);
}

function assetPath(name) { return path.join(ASSETS_DIR, name); }

module.exports = { ASSETS_DIR, listAssets, assetPath, isVideoName };
