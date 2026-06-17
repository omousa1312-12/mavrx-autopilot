'use strict';
/*
 * meta.js — publish to IG Business + FB Page via the Meta Graph API.
 *
 * Ported from scripts/mavrx-meta-publish.js (the proven Mac flow). Only change:
 * secrets are read from the META_SECRETS_JSON env var first (GitHub Actions),
 * falling back to ~/.claude/secrets/meta.json for local runs. Pure HTTPS — no
 * MCP, no Claude session. Public hosting for IG's image_url/video_url goes
 * through catbox.moe (anonymous, no key).
 *
 * Exports: loadSecrets(), publishFeed({imagePath,caption,secrets}),
 *          publishStory({imagePath,secrets}).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const GRAPH = 'https://graph.facebook.com/v18.0';
const BACKOFF_MS = [2000, 8000, 30000];
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 300000; // 5 min

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
};
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v']);

function loadSecrets() {
  let s;
  if (process.env.META_SECRETS_JSON) {
    try { s = JSON.parse(process.env.META_SECRETS_JSON); }
    catch { throw new Error('META_SECRETS_JSON is not valid JSON'); }
  } else {
    const f = path.join(os.homedir(), '.claude/secrets/meta.json');
    if (!fs.existsSync(f)) throw new Error('no META_SECRETS_JSON env and no ~/.claude/secrets/meta.json');
    s = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  for (const k of ['fb_page_id', 'fb_page_token', 'ig_business_id']) {
    if (!s[k]) throw new Error(`meta secrets missing key: ${k}`);
  }
  return s;
}

function isVideo(p) { return VIDEO_EXTS.has(path.extname(p).slice(1).toLowerCase()); }

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      process.stderr.write(`[${label}] attempt ${attempt + 1}/3 failed: ${e.message}\n`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
  throw new Error(`[${label}] failed after 3 attempts → ${lastErr.message}`);
}

// IG's Graph API needs a public HTTPS URL for the media. Free anonymous hosts
// differ on datacenter IPs (catbox blocks GitHub runners → "412 Invalid uploader"),
// so try several and use the first that works. Optionally set CATBOX_USERHASH
// (free catbox account) to make catbox reliable.
const UA = 'Mozilla/5.0 (mavrx-autopilot)';

async function upCloudinary(buf, name, mime) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) throw new Error('not configured (set CLOUDINARY_CLOUD_NAME + CLOUDINARY_UPLOAD_PRESET)');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), name);
  form.append('upload_preset', preset);
  // `auto` handles both images and videos.
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/auto/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  if (!j.secure_url) throw new Error('no secure_url in response');
  return j.secure_url;
}
async function upCatbox(buf, name, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  if (process.env.CATBOX_USERHASH) form.append('userhash', process.env.CATBOX_USERHASH);
  form.append('fileToUpload', new Blob([buf], { type: mime }), name);
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', headers: { 'User-Agent': UA }, body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const url = (await res.text()).trim();
  if (!/^https?:\/\/(files\.)?catbox\.moe\//.test(url)) throw new Error(`bad resp: ${url.slice(0, 120)}`);
  return url;
}
async function upTmpfiles(buf, name, mime) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), name);
  const res = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', headers: { 'User-Agent': UA }, body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const u = j && j.data && j.data.url;
  if (!u) throw new Error('no url in response');
  return u.replace('tmpfiles.org/', 'tmpfiles.org/dl/'); // direct-download form
}

async function uploadPublic(localPath) {
  const ext = path.extname(localPath).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(localPath);
  const name = path.basename(localPath);
  const hosts = [['cloudinary', upCloudinary], ['catbox', upCatbox], ['tmpfiles', upTmpfiles]];
  let lastErr;
  for (const [label, fn] of hosts) {
    try {
      const url = await fn(buf, name, mime);
      process.stderr.write(`[upload] via ${label}: ${url}\n`);
      return url;
    } catch (e) {
      lastErr = e;
      process.stderr.write(`[upload] ${label} failed: ${e.message}\n`);
    }
  }
  throw new Error(`all upload hosts failed → ${lastErr.message}`);
}

async function postIgPhoto(secrets, { imageUrl, caption, isStory }) {
  const createId = await withRetry(`ig-photo-${isStory ? 'story' : 'feed'}-container`, async () => {
    const params = new URLSearchParams({ image_url: imageUrl, access_token: secrets.fb_page_token });
    if (caption && !isStory) params.set('caption', caption);
    if (isStory) params.set('media_type', 'STORIES');
    if (secrets.default_location_id && !isStory) params.set('location_id', secrets.default_location_id);
    const res = await fetch(`${GRAPH}/${secrets.ig_business_id}/media`, { method: 'POST', body: params });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = await res.json();
    if (!body.id) throw new Error(`no container id: ${JSON.stringify(body).slice(0, 200)}`);
    return body.id;
  });
  await new Promise((r) => setTimeout(r, 3000));
  return publishIgContainer(secrets, createId, isStory ? 'ig-photo-story' : 'ig-photo-feed');
}

async function postIgVideo(secrets, { videoUrl, caption, isStory }) {
  const mediaType = isStory ? 'STORIES' : 'REELS';
  const createId = await withRetry(`ig-video-${isStory ? 'story' : 'reel'}-container`, async () => {
    const params = new URLSearchParams({
      media_type: mediaType, video_url: videoUrl, access_token: secrets.fb_page_token,
    });
    if (caption && !isStory) params.set('caption', caption);
    const res = await fetch(`${GRAPH}/${secrets.ig_business_id}/media`, { method: 'POST', body: params });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = await res.json();
    if (!body.id) throw new Error(`no container id: ${JSON.stringify(body).slice(0, 200)}`);
    return body.id;
  });
  await pollContainerReady(secrets, createId);
  return publishIgContainer(secrets, createId, isStory ? 'ig-video-story' : 'ig-video-reel');
}

async function publishIgContainer(secrets, creationId, label) {
  return withRetry(`${label}-publish`, async () => {
    const params = new URLSearchParams({ creation_id: creationId, access_token: secrets.fb_page_token });
    const res = await fetch(`${GRAPH}/${secrets.ig_business_id}/media_publish`, { method: 'POST', body: params });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = await res.json();
    if (!body.id) throw new Error(`no post id: ${JSON.stringify(body).slice(0, 200)}`);
    return body.id;
  });
}

async function pollContainerReady(secrets, containerId) {
  const start = Date.now();
  let lastStatus = '';
  while (Date.now() - start < POLL_MAX_MS) {
    try {
      const res = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${secrets.fb_page_token}`);
      if (res.ok) {
        const body = await res.json();
        if (body.status_code === 'FINISHED') return;
        if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') {
          throw new Error(`container ${containerId} entered ${body.status_code}`);
        }
        if (body.status_code !== lastStatus) {
          process.stderr.write(`[poll] container ${containerId} status: ${body.status_code}\n`);
          lastStatus = body.status_code;
        }
      } else {
        process.stderr.write(`[poll] HTTP ${res.status}, retrying\n`);
      }
    } catch (e) {
      process.stderr.write(`[poll] error: ${e.message}, retrying\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`container ${containerId} not FINISHED after ${POLL_MAX_MS / 1000}s`);
}

async function postFbPhoto(secrets, { imagePath, caption }) {
  return withRetry('fb-photo', async () => {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/jpeg';
    const form = new FormData();
    form.append('source', new Blob([buf], { type: mime }), path.basename(imagePath));
    form.append('message', caption || '');
    form.append('published', 'true');
    if (secrets.default_location_id) form.append('place', secrets.default_location_id);
    form.append('access_token', secrets.fb_page_token);
    const res = await fetch(`${GRAPH}/${secrets.fb_page_id}/photos`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = await res.json();
    return body.post_id || body.id;
  });
}

async function postFbVideo(secrets, { videoPath, caption }) {
  return withRetry('fb-video', async () => {
    const buf = fs.readFileSync(videoPath);
    const ext = path.extname(videoPath).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'video/mp4';
    const form = new FormData();
    form.append('source', new Blob([buf], { type: mime }), path.basename(videoPath));
    form.append('description', caption || '');
    form.append('access_token', secrets.fb_page_token);
    const res = await fetch(`${GRAPH}/${secrets.fb_page_id}/videos`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = await res.json();
    return body.id || body.post_id;
  });
}

// Publish image/video to IG feed + FB Page. Returns {ig_post_id, fb_post_id, media_type}.
async function publishFeed({ imagePath, caption, secrets }) {
  if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  if (!caption) throw new Error('caption is empty');
  const video = isVideo(imagePath);
  // FB uploads the binary directly (no external host). IG needs a public URL, so
  // ONLY the IG branch depends on uploadPublic — a host hiccup can't block FB.
  // allSettled (not all): a partial success never triggers a repost-to-both next run.
  const igTask = (async () => {
    const publicUrl = await uploadPublic(imagePath);
    return video ? postIgVideo(secrets, { videoUrl: publicUrl, caption, isStory: false })
                 : postIgPhoto(secrets, { imageUrl: publicUrl, caption, isStory: false });
  })();
  const fbTask = video ? postFbVideo(secrets, { videoPath: imagePath, caption })
                       : postFbPhoto(secrets, { imagePath, caption });
  const [igR, fbR] = await Promise.allSettled([igTask, fbTask]);
  const ig_post_id = igR.status === 'fulfilled' ? igR.value : null;
  const fb_post_id = fbR.status === 'fulfilled' ? fbR.value : null;
  if (!ig_post_id && !fb_post_id) {
    throw new Error(`publish failed on both — IG: ${igR.reason?.message}; FB: ${fbR.reason?.message}`);
  }
  return {
    ig_post_id, fb_post_id, media_type: video ? 'video' : 'image',
    ig_error: igR.status === 'rejected' ? igR.reason?.message : null,
    fb_error: fbR.status === 'rejected' ? fbR.reason?.message : null,
  };
}

// Publish image/video as an IG Story (FB Pages have no Story API).
// Returns {ig_story_id, media_type}.
async function publishStory({ imagePath, secrets }) {
  if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  const video = isVideo(imagePath);
  const publicUrl = await uploadPublic(imagePath);
  const ig_story_id = video
    ? await postIgVideo(secrets, { videoUrl: publicUrl, caption: null, isStory: true })
    : await postIgPhoto(secrets, { imageUrl: publicUrl, caption: null, isStory: true });
  return { ig_story_id, media_type: video ? 'video' : 'image' };
}

module.exports = { loadSecrets, publishFeed, publishStory, isVideo };
