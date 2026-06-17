'use strict';

/**
 * ia-client.js
 *
 * Networked Internet Archive client. Composes the pure helpers in ia-core.js
 * with Node's built-in fetch/https — no third-party deps, so the packaged app
 * stays tiny. Covers the operations the app exposes:
 *
 *   - login          POST https://archive.org/services/xauthn/?op=login
 *   - search         GET  https://archive.org/advancedsearch.php
 *   - getMetadata    GET  https://archive.org/metadata/{identifier}
 *   - downloadFile   GET  https://archive.org/download/{identifier}/{file}
 *   - uploadFile     PUT  https://s3.us.archive.org/{identifier}/{file}
 *   - modifyMetadata POST https://archive.org/metadata/{identifier}
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const core = require('./ia-core');
const { decideExisting } = require('./download-prefs');
const { IAError } = core;
const { HOST, S3_HOST, USER_AGENT } = require('../shared/constants');

/* --------------------------------------------------------------------------
 * Low-level request helper
 * ------------------------------------------------------------------------ */

// Deadline for the small JSON endpoints (login/search/metadata/tasks/scrape).
// These return quickly in practice; a stalled one must not hang forever (C1).
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;

async function request(method, url, { headers = {}, body, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  // C1: bound every request with a timeout, combined with the caller's signal
  // (so a cancel still aborts) when AbortSignal.any is available.
  let effectiveSignal = signal;
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    effectiveSignal = signal && AbortSignal.any ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    body,
    signal: effectiveSignal,
    redirect: 'follow',
  });
  const text = await res.text();
  let json;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json') || (text && (text[0] === '{' || text[0] === '['))) {
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json undefined */
    }
  }
  return { ok: res.ok, status: res.status, headers: res.headers, text, json };
}

/* --------------------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------------------ */

async function login(email, password) {
  const url = `https://${HOST}/services/xauthn/?op=login`;
  const form = new URLSearchParams({ email, password });
  const { json, status, text } = await request('POST', url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!json) {
    throw new IAError('Unexpected response from archive.org during login.', { status, body: text });
  }
  return core.parseLoginResponse(json, email);
}

/* --------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------ */

async function search(query, opts = {}) {
  const url = core.buildSearchUrl(query, opts);
  const { ok, json, status, text } = await request('GET', url);
  if (!ok || !json || !json.response) {
    // L6: surface archive.org's real error (e.g. a malformed-query message)
    // instead of a generic "Search failed." so the user can fix the query.
    const reason = (json && json.error) || 'Search request failed.';
    throw new IAError(reason, { status, body: text });
  }
  return {
    numFound: json.response.numFound,
    start: json.response.start,
    docs: json.response.docs || [],
  };
}

/* --------------------------------------------------------------------------
 * Scraping API (cursor-paged bulk listing) — #2
 * ------------------------------------------------------------------------ */

/** Fetch one scrape page for a query (optionally continuing from a cursor). */
async function scrapeCollectionPage(query, cursor) {
  const url = core.buildScrapeUrl(query, cursor ? { cursor } : {});
  const { ok, json, status, text } = await request('GET', url);
  if (!ok || !json || !Array.isArray(json.items)) {
    throw new IAError('Could not list the collection.', { status, body: text });
  }
  return { items: json.items, cursor: json.cursor };
}

/**
 * Page through a scrape query, collecting identifiers until the cursor is
 * exhausted (or `maxItems` is reached). `fetchPage(cursor)` is injectable for
 * tests; in production it defaults to the networked page fetch.
 *
 * @returns {Promise<string[]>} identifiers
 */
async function scrapeAll(query, { fetchPage = (c) => scrapeCollectionPage(query, c), maxItems = Infinity, onProgress } = {}) {
  const ids = [];
  let cursor;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchPage(cursor);
    const items = (page && page.items) || [];
    if (!items.length) break; // empty page → done (guards a stuck cursor)
    for (const it of items) {
      if (it && it.identifier) ids.push(it.identifier);
      if (ids.length >= maxItems) return ids.slice(0, maxItems);
    }
    if (onProgress) onProgress({ count: ids.length });
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return ids;
}

/* --------------------------------------------------------------------------
 * Item metadata
 * ------------------------------------------------------------------------ */

async function getMetadata(identifier) {
  if (!identifier) throw new IAError('No identifier provided.');
  const url = `https://${HOST}/metadata/${encodeURIComponent(identifier)}`;
  const { ok, json, status, text } = await request('GET', url);
  if (!ok || !json) {
    throw new IAError(`Could not load metadata for "${identifier}".`, { status, body: text });
  }
  if (json.metadata == null && (!json.files || json.files.length === 0)) {
    throw new IAError(`Item "${identifier}" was not found.`, { status: 404 });
  }
  return json;
}

/* --------------------------------------------------------------------------
 * Item tasks (derive / catalog status) — #16, read-only
 * ------------------------------------------------------------------------ */

async function getTasks(identifier) {
  if (!identifier) throw new IAError('No identifier provided.');
  const url = `https://${HOST}/services/tasks.php?identifier=${encodeURIComponent(identifier)}`;
  const { ok, json, status, text } = await request('GET', url);
  if (!ok || !json) {
    throw new IAError(`Could not load tasks for "${identifier}".`, { status, body: text });
  }
  return json;
}

/* --------------------------------------------------------------------------
 * Download with progress + resume
 * ------------------------------------------------------------------------ */

/**
 * Parse a `Content-Range: bytes <start>-<end>/<total>` header.
 * @returns {{start:number,end:number,total:number|null}|null}
 */
function parseContentRange(value) {
  if (!value) return null;
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(value));
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

// Default idle timeout for a download/upload: abort if the connection goes
// silent (no headers, or a stalled body) for this long. Resets on each chunk so
// a slow-but-steady transfer is never killed.
const DEFAULT_IDLE_TIMEOUT_MS = 60000;

function downloadFile({ url, destPath, expectedSize, onProgress, signal, force, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const knownSize = expectedSize != null ? Number(expectedSize) : null;

    // Decide skip / resume / fresh for a possibly-existing same-named file.
    // `fs.existsSync` resolves case-insensitively on Windows + default macOS, so
    // "Book.pdf" already on disk counts as "book.pdf" present — matching the OS.
    // `force` (the reDownload pref, and the H4 checksum-mismatch retry) overrides
    // skip/resume and always re-downloads fresh.
    let startByte = 0;
    const exists = fs.existsSync(destPath);
    const existingSize = exists ? fs.statSync(destPath).size : 0;
    const decision = decideExisting({ exists, existingSize, knownSize, reDownload: !!force });
    if (decision.action === 'skip') {
      resolve({ path: destPath, bytes: existingSize, skipped: true });
      return;
    }
    if (decision.action === 'resume') {
      startByte = decision.startByte;
    }

    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': USER_AGENT };
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const req = lib.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        // Carry the signal AND timeout through the redirect so a cancel/stall on
        // the redirected request is still honored (H3).
        downloadFile({ url: next, destPath, expectedSize, onProgress, signal, force, timeoutMs }).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new IAError(`Download failed (HTTP ${res.statusCode}) for ${path.basename(destPath)}.`, { status: res.statusCode }));
        return;
      }

      // H1.2: validate a 206's Content-Range actually starts at the byte we
      // asked for. A server that ignores Range (returns from 0, or a different
      // offset) must NOT be appended to — restart the file fresh from 0.
      let resuming = res.statusCode === 206 && startByte > 0;
      if (resuming) {
        const cr = parseContentRange(res.headers['content-range']);
        if (!cr || cr.start !== startByte) {
          resuming = false;
          startByte = 0;
        }
      } else {
        // A 206 we didn't ask to resume, or a 200 — write from the beginning.
        resuming = false;
        startByte = 0;
      }

      const total =
        (knownSize != null ? knownSize : 0) ||
        (Number(res.headers['content-length']) || 0) + startByte;

      const out = fs.createWriteStream(destPath, { flags: resuming ? 'a' : 'w' });
      let received = startByte;
      let settled = false;
      let pendingError = null;

      // H3: never settle the promise until the write fd is actually CLOSED.
      // On Windows an open handle locks the file, so resolving/rejecting before
      // close lets a retry re-open a still-locked path. We destroy the stream,
      // then settle in its 'close' handler.
      const finish = () => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        // Cancel the idle timeout so it can't fire (and destroy the socket) after
        // we've already settled (L3 hygiene).
        try {
          req.setTimeout(0);
        } catch {
          /* request already torn down */
        }
        if (pendingError) reject(pendingError);
        else resolve({ path: destPath, bytes: received, skipped: false });
      };
      const fail = (err) => {
        if (settled || pendingError) return;
        pendingError = err;
        out.destroy(); // 'close' → finish() rejects with pendingError
      };

      const onAbort = () => {
        req.destroy();
        fail(new IAError('Download cancelled.'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      res.on('error', (err) => fail(err));
      // A connection that drops mid-body (or a Content-Length the server never
      // fulfils) fires 'aborted' / a premature 'close' without 'end'. Treat the
      // download as failed rather than hanging forever waiting on 'finish'.
      res.on('aborted', () =>
        fail(new IAError(`Connection dropped during download of ${path.basename(destPath)}.`))
      );
      res.on('close', () => {
        if (!settled && !pendingError && !res.complete) {
          fail(new IAError(`Connection closed before download of ${path.basename(destPath)} finished.`));
        }
      });
      out.on('error', (err) => fail(err));
      out.on('close', () => {
        // The fd is now released — safe to settle (resolve or the pending error).
        if (pendingError) return finish();
        // H1.3: a finished stream short of the known size is a truncation.
        if (knownSize != null && received !== knownSize) {
          pendingError = new IAError(
            `Incomplete download for ${path.basename(destPath)}: got ${received} of ${knownSize} bytes.`,
            { status: res.statusCode }
          );
          return finish();
        }
        finish();
      });
      res.pipe(out);
    });

    // C1: idle timeout. Fires if no socket activity for `timeoutMs`; resets on
    // every byte received (the http req emits 'timeout' on socket idle). Without
    // this a server that accepts the socket then stalls hangs forever.
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new IAError(`Download timed out for ${path.basename(destPath)}.`, { code: 'ETIMEDOUT' }));
      });
    }
    req.on('error', (err) => reject(err));
  });
}

/* --------------------------------------------------------------------------
 * Metadata write (JSON patch)
 * ------------------------------------------------------------------------ */

/**
 * Modify an item's metadata. `patches` must be an RFC 6902 JSON Patch ARRAY,
 * e.g. [{ op: 'replace', path: '/title', value: '…' }] — that is what
 * archive.org's metadata-write API expects for `-patch`.
 *
 * Auth travels in the `Authorization: LOW access:secret` HEADER (consistent with
 * uploadFile), NOT as access/secret form fields (M1).
 */
async function modifyMetadata(identifier, patches, creds, { target = 'metadata' } = {}) {
  const auth = core.authHeader(creds);
  if (!auth) throw new IAError('You must be logged in to modify metadata.');
  const body = new URLSearchParams();
  body.set('-target', target);
  body.set('-patch', JSON.stringify(patches));

  const url = `https://${HOST}/metadata/${encodeURIComponent(identifier)}`;
  const { ok, json, status, text } = await request('POST', url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth },
    body: body.toString(),
  });
  if (!ok || (json && json.success === false)) {
    const reason = (json && (json.error || json.log)) || 'Metadata update failed.';
    throw new IAError(reason, { status, body: text });
  }
  return json || { success: true };
}

/* --------------------------------------------------------------------------
 * Upload (S3-like PUT)
 * ------------------------------------------------------------------------ */

function uploadFile({
  identifier,
  filePath,
  remoteName,
  metadata = {},
  creds,
  makeBucket = true,
  derive = true,
  onProgress,
  signal,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const auth = core.authHeader(creds);
    if (!auth) return reject(new IAError('You must be logged in to upload.'));
    if (!fs.existsSync(filePath)) return reject(new IAError(`File not found: ${filePath}`));

    const remote = remoteName || path.basename(filePath);
    const size = fs.statSync(filePath).size;
    const u = new URL(`https://${S3_HOST}/${encodeURIComponent(identifier)}/${encodeURIComponent(remote)}`);

    const headers = {
      'User-Agent': USER_AGENT,
      Authorization: auth,
      'Content-Length': String(size),
      'x-archive-size-hint': String(size),
    };
    if (makeBucket) {
      headers['x-archive-auto-make-bucket'] = '1';
      Object.assign(headers, core.buildMetaHeaders(metadata));
    }
    if (!derive) headers['x-archive-queue-derive'] = '0';

    // Single-settle wrapper that also removes the abort listener and cancels the
    // idle timer, so neither leaks/fires after the upload finishes (L3 hygiene).
    let settled = false;
    let onAbort = null;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      try {
        req.setTimeout(0);
      } catch {
        /* already torn down */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const req = https.request(u, { method: 'PUT', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          done(null, { identifier, remote, bytes: size });
        } else {
          done(new IAError(`Upload failed (HTTP ${res.statusCode}) for ${remote}.`, { status: res.statusCode, body }));
        }
      });
    });
    req.on('error', (err) => done(err));
    // C1: idle timeout so a stalled upload (server stops reading) fails instead
    // of hanging the transfer queue forever. Resets on socket activity.
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new IAError(`Upload timed out for ${remote}.`, { code: 'ETIMEDOUT' }));
      });
    }

    const stream = fs.createReadStream(filePath);
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress({ sent, total: size });
    });
    stream.on('error', (err) => {
      req.destroy();
      done(err);
    });

    if (signal) {
      onAbort = () => {
        stream.destroy();
        req.destroy();
        done(new IAError('Upload cancelled.'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    stream.pipe(req);
  });
}

module.exports = {
  IAError,
  login,
  search,
  getMetadata,
  getTasks,
  scrapeCollectionPage,
  scrapeAll,
  downloadUrl: core.downloadUrl,
  downloadFile,
  modifyMetadata,
  uploadFile,
};
