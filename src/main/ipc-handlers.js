'use strict';

/**
 * ipc-handlers.js
 *
 * Extracted, dependency-injected bodies for the heavier IPC handlers so they
 * can be unit-tested without Electron or the network (T2). The Electron
 * `ipcMain.handle` closures in main.js are thin wrappers that build the
 * `{ ia, send }` deps and delegate here.
 */

const path = require('node:path');

const { resolveDownloadPlan, isRealFile, parsePatterns, formatForItem, sanitizeSegment, FORMAT_PRESETS } = require('./download-prefs');
const { normalizePrefs } = require('../shared/view-prefs');
const { validateDownloadItems, validateDestRoot, containWithin } = require('./ipc-validate');
const { verifyFile } = require('./checksum');
const { runQueue } = require('./download-queue');
const logger = require('./logger');

// Downloads always run ONE AT A TIME. archive.org throttles parallel transfers
// (503 SlowDown), so we never download more than one file concurrently. The
// queue is still used for its automatic retry/backoff on transient failures.
const DOWNLOAD_CONCURRENCY = 1;

// Short, user-facing names for format keys (for the fallback notice).
const FORMAT_LABELS = {
  pdf: 'PDF',
  text_pdf: 'searchable text PDF',
  epub: 'EPUB',
  text: 'plain text / DjVu',
  all: 'all available files',
};
function formatLabel(key) {
  if (FORMAT_LABELS[key]) return FORMAT_LABELS[key];
  const p = FORMAT_PRESETS.find((x) => x.key === key);
  return (p && p.label) || key;
}

/**
 * Default inter-item pause (#16); injectable as `sleep` for tests. Resolves
 * after `ms`, or EARLY if `signal` aborts (H6) — so a cancel during the pause
 * takes effect immediately instead of waiting out the full delay.
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    }
  });
}

/**
 * Sanitize an identifier into a single safe directory segment — Windows-safe
 * (reserved names escaped, trailing dots/spaces trimmed, illegal chars replaced)
 * and length-capped.
 */
function sanitizeDir(name) {
  return sanitizeSegment(name, 'item').slice(0, 200);
}

// Classic Windows path limit (without the long-path opt-in). Leave a small
// margin under 260 for safety.
const WIN_MAX_PATH = 250;

/**
 * Bound the assembled write path to Windows' MAX_PATH (260) by shortening the
 * filename's STEM (never the extension, never the interior IA subdirs) so that
 * `itemDir + sep + saveAs` fits. No-op on posix (long paths are allowed) and a
 * no-op when the path already fits. `platform` lets tests drive win32 rules.
 *
 * @param {string} itemDir the resolved directory the file lands in
 * @param {string} saveAs  the relative save-as path (may contain subdirs)
 */
function boundedSaveAs(itemDir, saveAs, platform = process.platform) {
  if (platform !== 'win32') return saveAs;
  const p = path.win32;
  const sep = p.sep;
  const full = itemDir + sep + saveAs;
  if (full.length <= WIN_MAX_PATH) return saveAs;

  // Split off the directory part of saveAs (interior IA subdirs) from the basename.
  const lastSep = saveAs.lastIndexOf(sep);
  const dirPart = lastSep >= 0 ? saveAs.slice(0, lastSep + 1) : ''; // includes trailing sep
  const base = lastSep >= 0 ? saveAs.slice(lastSep + 1) : saveAs;
  const ext = p.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  // Budget left for the stem after the fixed parts.
  const fixed = itemDir.length + sep.length + dirPart.length + ext.length;
  const stemBudget = WIN_MAX_PATH - fixed;
  if (stemBudget <= 0) {
    // Even the dir+ext alone overflow; keep just the extension (best effort).
    return dirPart + (ext || '_');
  }
  const newStem = stem.slice(0, stemBudget) || '_';
  return dirPart + newStem + ext;
}

/**
 * Keep IA's internal subdirectories but strip traversal and make EVERY segment
 * Windows-safe (each interior dir, not just the basename). IA names use '/' as
 * the separator regardless of client OS.
 */
function sanitizeRel(name) {
  return String(name)
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeSegment(seg))
    .join(path.sep);
}

/**
 * Build the flat download work list from validated items. Items without a file
 * list have their metadata fetched via `ia.getMetadata`. Each entry carries the
 * item directory and the local save-as name.
 */
async function buildWorkList(items, { formatText, formatOther, rename, include, exclude, subfolders }, destRoot, ia) {
  const work = [];
  const fallbacks = []; // { identifier, usedFormat } per item that fell back
  let lastDir = destRoot;
  for (const item of items) {
    let files = item.files;
    let mediatype = item.mediatype;
    if (!files || !files.length) {
      const md = await ia.getMetadata(item.identifier);
      files = (md.files || []).filter(isRealFile);
      if (!item.title && md.metadata) {
        item.title = Array.isArray(md.metadata.title) ? md.metadata.title[0] : md.metadata.title;
      }
      if (mediatype == null && md.metadata) mediatype = md.metadata.mediatype;
    }
    // Choose the format from the item's mediatype: a "texts" item follows the
    // Text dropdown, anything else the Other dropdown. The texts fallback tail
    // (largest vs all) tracks the Other dropdown too.
    const { format, fallbackTail } = formatForItem(mediatype, formatText, formatOther);
    // Graceful fallback: if the chosen format matches nothing for this item,
    // take the next-best readable file instead of failing outright.
    const { plan, usedFormat, fellBack } = resolveDownloadPlan(files, {
      format,
      fallbackTail,
      rename,
      title: item.title || '',
      include,
      exclude,
    });
    if (fellBack) fallbacks.push({ identifier: item.identifier, usedFormat, requestedFormat: format });
    // #5: a per-item subfolder only when the pref is on; otherwise files go
    // straight into the destination folder (the default, "flat").
    const itemDir = subfolders ? path.join(destRoot, sanitizeDir(item.identifier)) : destRoot;
    lastDir = itemDir;
    for (const p of plan) {
      work.push({
        identifier: item.identifier,
        remote: p.name,
        saveAs: p.saveAs,
        size: p.size,
        itemDir,
        checksums: { md5: p.md5, sha1: p.sha1, crc32: p.crc32 },
      });
    }
  }
  return { work, lastDir, fallbacks };
}

/**
 * Run a download job. `deps.send(payload)` emits a `download:progress`-shaped
 * event; `deps.ia` is the IA client (real or a stub). `signal` is an optional
 * AbortSignal. Returns `{ ok, dir?, count?, error? }`.
 *
 * @param {{items: import('../shared/types').DownloadItem[], prefs: Object, destRoot: string, signal?: AbortSignal}} args
 * @param {{ia: Object, send: (p: import('../shared/types').ProgressEvent) => void, verify?: Function, log?: Object}} deps
 */
async function handleDownloadStart(
  { items, prefs, destRoot, signal },
  { ia, send, verify = verifyFile, log = logger, sleep = defaultSleep }
) {
  const np = normalizePrefs(prefs || {});
  // Two-dropdown format model: texts items use formatText (pdf/text_pdf/epub/
  // text), other mediatypes use formatOther (largest/all). Per-item choice is
  // made in buildWorkList via formatForItem.
  const formatText = np.formatText;
  const formatOther = np.formatOther;
  const rename = np.rename;
  const subfolders = np.downloadSubfolders; // #5
  const delayMs = np.downloadDelaySec * 1000; // #16: pause between items
  const reDownload = np.reDownload; // re-download/overwrite existing files instead of skipping
  // #3: per-download glob include/exclude filters (raw strings from prefs).
  const include = parsePatterns((prefs || {}).includeGlobs);
  const exclude = parsePatterns((prefs || {}).excludeGlobs);

  try {
    validateDownloadItems(items);
    validateDestRoot(destRoot);

    const { work, lastDir, fallbacks } = await buildWorkList(items, { formatText, formatOther, rename, include, exclude, subfolders }, destRoot, ia);

    if (!work.length) {
      log.warn('download: no matching files', { items: items.length, formatText, formatOther });
      send({ phase: 'error', message: 'This item has no downloadable files.' });
      return { ok: false, error: 'No files to download.' };
    }
    // Soft warning: one or more items didn't have the chosen format, so we fell
    // back to the next-best file. Tell the user instead of failing.
    if (fallbacks && fallbacks.length) {
      const first = fallbacks[0];
      const used = formatLabel(first.usedFormat);
      const requested = formatLabel(first.requestedFormat);
      // If different items fell back to DIFFERENT formats, don't claim a single
      // one — use generic phrasing (M5).
      const sameUsed = fallbacks.every((fb) => fb.usedFormat === first.usedFormat);
      const sameRequested = fallbacks.every((fb) => fb.requestedFormat === first.requestedFormat);
      let message;
      if (fallbacks.length === 1) {
        message = `No “${requested}” for this item — downloading ${used} instead.`;
      } else if (sameUsed && sameRequested) {
        message = `${fallbacks.length} item(s) had no “${requested}” — downloading ${used} instead.`;
      } else {
        message = `${fallbacks.length} item(s) didn’t have the chosen format — downloading the next-best available file instead.`;
      }
      log.warn('download: format fallback', { requested: first.requestedFormat, used: first.usedFormat, items: fallbacks.length });
      send({ phase: 'notice', level: 'warn', message });
    }
    log.info('download started', { items: items.length, files: work.length, formatText, formatOther, dest: destRoot });

    // Resolve + containment-check every destPath up front so a traversal fails
    // fast before any network work (M3).
    const total = work.length;
    for (const w of work) {
      // Shorten the basename so the full path fits Windows' MAX_PATH (M1, no-op
      // on posix and when it already fits).
      const rel = boundedSaveAs(w.itemDir, sanitizeRel(w.saveAs));
      w.destPath = path.join(w.itemDir, rel);
      if (!containWithin(w.itemDir, w.destPath) || !containWithin(destRoot, w.destPath)) {
        throw new ia.IAError(`Refusing to write outside the download folder: ${w.saveAs}.`);
      }
    }

    // Run the files through the queue serially, with retry/backoff on 503s.
    let done = 0;
    // #16: pause `delayMs` between consecutive ITEMS (when the identifier
    // changes), never before the first file and never within one item's files.
    let prevIdentifier = null;

    const runner = async (w, i) => {
      if (delayMs > 0 && prevIdentifier != null && w.identifier !== prevIdentifier) {
        await sleep(delayMs, signal);
        // H6: a cancel during the pause must stop here, not start the next item.
        if (signal && signal.aborted) throw new ia.IAError('Cancelled.');
      }
      prevIdentifier = w.identifier;
      const checksums = w.checksums || {};
      const hasChecksum = !!(checksums.md5 || checksums.sha1 || checksums.crc32);
      send({ phase: 'file-start', index: i, total, name: w.saveAs });
      const doDownload = (force) =>
        ia.downloadFile({
          url: ia.downloadUrl(w.identifier, w.remote),
          destPath: w.destPath,
          expectedSize: w.size,
          force,
          signal,
          onProgress: ({ received, total: t }) =>
            send({ phase: 'file-progress', index: i, total, name: w.saveAs, received, totalBytes: t }),
        });
      // reDownload pref forces a fresh overwrite; otherwise an existing same-name
      // file is skipped (decided in downloadFile via decideExisting).
      let r = await doDownload(reDownload);

      // #4 + H4: verify against the published checksum. A file SKIPPED purely on
      // a size match is still verified when a checksum exists — a same-size-but-
      // corrupt file would otherwise be silently accepted. On mismatch, force a
      // real re-download and verify that.
      let verified;
      const runVerify = async () => {
        try {
          return await verify(w.destPath, checksums);
        } catch {
          return 'unknown';
        }
      };
      if (!r.skipped) {
        verified = await runVerify();
      } else if (hasChecksum) {
        verified = await runVerify();
        if (verified === 'mismatch') {
          log.warn('download: skipped file failed checksum — re-downloading', { name: w.saveAs, identifier: w.identifier });
          r = await doDownload(true); // bypass the size-based skip
          verified = await runVerify();
        }
      }
      done++;
      if (verified === 'mismatch') log.warn('download: checksum mismatch', { name: w.saveAs, identifier: w.identifier });
      else log.info('download: file done', { name: w.saveAs, skipped: !!r.skipped, verified: verified || 'n/a' });
      send({ phase: 'file-done', index: i, total, completed: done, name: w.saveAs, skipped: r.skipped, verified });
      return r;
    };

    const results = await runQueue(work, runner, {
      concurrency: DOWNLOAD_CONCURRENCY,
      maxRetries: 3,
      signal,
      onEvent: (e) => {
        if (e.type === 'retry') {
          log.warn('download: retrying file', { name: work[e.index].saveAs, attempt: e.attempt });
          send({ phase: 'file-retry', index: e.index, total, attempt: e.attempt, name: work[e.index].saveAs });
        }
      },
    });

    const failed = results.filter((r) => r && !r.ok);
    if (failed.length) {
      const first = failed[0].error;
      log.error('download: files failed', { failed: failed.length, reason: (first && first.message) || 'unknown' });
      // Abort/cancel produces failures too; surface the first real message.
      send({ phase: 'error', message: (first && first.message) || `${failed.length} file(s) failed to download.` });
      return { ok: false, error: (first && first.message) || 'Some files failed.' };
    }

    log.info('download complete', { count: done, dir: lastDir });
    send({ phase: 'complete', dir: lastDir, count: done });
    return { ok: true, dir: lastDir, count: done };
  } catch (err) {
    log.error('download error', { reason: err.message });
    send({ phase: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { sanitizeDir, sanitizeRel, boundedSaveAs, buildWorkList, handleDownloadStart };
