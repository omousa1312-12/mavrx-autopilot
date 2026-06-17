'use strict';
/*
 * drive.js — read-only Google Drive access with a service account, using only
 * Node stdlib (crypto + global fetch). No googleapis dependency.
 *
 * Replaces the Drive MCP that pinned the old flow to an interactive Claude
 * session. The service account key is provided via the GDRIVE_SA_JSON env var
 * (the full JSON of the key). The Drive folder "Mavrx Media 1" must be shared
 * with the service account's client_email as Viewer.
 *
 * Exports: getAccessToken(sa), loadSA(), listFolder(token, folderId),
 *          downloadFile(token, fileId, destPath).
 */
const https = require('https'); // eslint-disable-line no-unused-vars
const crypto = require('crypto');
const fs = require('fs');

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function loadSA() {
  const raw = process.env.GDRIVE_SA_JSON || '';
  if (!raw) throw new Error('GDRIVE_SA_JSON not set');
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error('GDRIVE_SA_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('service account JSON missing client_email / private_key');
  }
  return sa;
}

// Mint a short-lived OAuth access token from the service account JWT.
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud, iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = b64url(signer.sign(sa.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`drive token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('drive token response had no access_token');
  return j.access_token;
}

// List image/video files in a folder (handles pagination + shared drives).
// Returns [{id, name, mimeType, size, modifiedTime}].
async function listFolder(token, folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      pageSize: '100',
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`drive list HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Download a file's bytes to destPath. Returns byte length.
async function downloadFile(token, fileId, destPath) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`drive download HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

module.exports = { loadSA, getAccessToken, listFolder, downloadFile };
