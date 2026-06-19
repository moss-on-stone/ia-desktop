'use strict';

/**
 * ui-util.js
 *
 * Pure helper functions for the renderer. No DOM access, so they can be unit
 * tested with `node --test`. Loaded both as a CommonJS module (tests) and as a
 * plain <script> in the browser (attaches to window.uiUtil).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.uiUtil = api;
})(typeof window !== 'undefined' ? window : null, function () {
  /** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let val = n;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return i === 0 ? `${Math.round(val)} ${units[i]}` : `${val.toFixed(1)} ${units[i]}`;
  }

  /** Integer percent of received/total, clamped to 0..100. */
  function percent(received, total) {
    const r = Number(received);
    const t = Number(total);
    if (!Number.isFinite(t) || t <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((r / t) * 100)));
  }

  /** Split a comma-separated subjects string into a trimmed, non-empty array. */
  function parseSubjects(input) {
    if (!input) return [];
    return String(input)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Top-15 upload languages with the codes archive.org actually uses — MARC /
   * ISO 639-2 *bibliographic* codes (e.g. Chinese=chi not zho, French=fre not
   * fra, German=ger not deu), verified against live archive.org item counts.
   * Ordered roughly by IA item volume; includes Japanese/Chinese/Korean.
   */
  const UPLOAD_LANGUAGES = [
    { code: 'eng', label: 'English' },
    { code: 'spa', label: 'Spanish' },
    { code: 'ger', label: 'German' },
    { code: 'fre', label: 'French' },
    { code: 'chi', label: 'Chinese' },
    { code: 'hin', label: 'Hindi' },
    { code: 'dut', label: 'Dutch' },
    { code: 'ara', label: 'Arabic' },
    { code: 'rus', label: 'Russian' },
    { code: 'por', label: 'Portuguese' },
    { code: 'ita', label: 'Italian' },
    { code: 'jpn', label: 'Japanese' },
    { code: 'kor', label: 'Korean' },
    { code: 'per', label: 'Persian' },
    { code: 'tur', label: 'Turkish' },
  ];

  /** Assemble a clean metadata object for upload from the upload form fields. */
  function buildUploadMetadata(fields = {}) {
    const md = {};
    if (fields.title) md.title = fields.title.trim();
    if (fields.creator) md.creator = fields.creator.trim();
    if (fields.date) md.date = fields.date.trim();
    if (fields.mediatype) md.mediatype = fields.mediatype.trim();
    if (fields.description) md.description = fields.description.trim();
    if (fields.language && String(fields.language).trim()) md.language = String(fields.language).trim();
    const subjects = parseSubjects(fields.subjects);
    if (subjects.length) md.subject = subjects;
    // BookReader hints (texts). Only emitted when the user opts in.
    //  - page-progression=rl → pages turn right-to-left (CJK/RTL books)
    //  - bookreader-defaults=mode/1up → open in single-page view (default is 2up)
    if (fields.pageProgressionRl) md['page-progression'] = 'rl';
    if (fields.oneUp) md['bookreader-defaults'] = 'mode/1up';
    return md;
  }

  /**
   * Whether a string is a valid archive.org identifier. Real identifiers contain
   * uppercase (e.g. "NPTCM19400622"), so the check is case-insensitive.
   */
  function validIdentifier(id) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(String(id || ''));
  }

  /** Return the first element of an array, or the value itself, or ''. */
  function firstOf(value) {
    if (Array.isArray(value)) return value.length ? value[0] : '';
    return value == null ? '' : value;
  }

  /**
   * Build the array shape that the download pipeline expects from a single
   * item. `startDownload`/`download:start` want an ARRAY of
   * { identifier, title, files? } objects — passing a bare identifier string
   * (as the item-modal buttons once did) makes main.js iterate the string's
   * characters. This is the single normalization point for modal callers.
   *
   * Files are only included when a non-empty list is given; otherwise main
   * resolves them from metadata. Title falls back to the identifier.
   */
  function toDownloadItems(identifier, title, files, mediatype) {
    const item = { identifier, title: title || identifier };
    if (Array.isArray(files) && files.length) item.files = files;
    // Carry the mediatype so main can pick the Text vs Other download format
    // without re-fetching metadata.
    if (mediatype) item.mediatype = mediatype;
    return [item];
  }

  // Monotonic counter of factories created in this JS context. Combined with a
  // random component, it guarantees that two factories (e.g. created before and
  // after a renderer reload) never share a prefix even if both count from 1.
  let factoryInstance = 0;

  /**
   * Create a jobId generator with a per-session prefix (H5). Each returned
   * function yields `job-<prefix>-<n>`; the prefix is unique per factory, so a
   * reload that resets the counter to 1 can't collide with an in-flight job's
   * id from a previous factory.
   *
   * @param {string} [prefix] explicit session prefix (mainly for tests)
   */
  function makeJobIdFactory(prefix) {
    const p =
      prefix != null
        ? String(prefix)
        : `${++factoryInstance}${Math.random().toString(36).slice(2, 8)}`;
    let seq = 0;
    return () => `job-${p}-${++seq}`;
  }

  /**
   * Turn a metadata `description` (string or array of strings) into a single
   * plain-text string. Arrays are joined with a blank line between paragraphs.
   * The result is meant for textContent insertion — any HTML in it stays inert
   * (H2: descriptions are attacker-controlled, so we never parse them as HTML).
   */
  function descriptionText(description) {
    if (description == null) return '';
    if (Array.isArray(description)) {
      return description.map((d) => String(d == null ? '' : d)).filter(Boolean).join('\n\n');
    }
    return String(description);
  }

  /**
   * Summary line for a finished download job (#4). When `mismatches` files
   * failed checksum verification, append a warning so the user knows to retry
   * those files.
   */
  function downloadDoneSummary(count, mismatches) {
    const base = `Done — ${count} file(s)`;
    const m = Number(mismatches) || 0;
    if (m <= 0) return base;
    return `${base} — ⚠ ${m} failed checksum`;
  }

  /**
   * Compute the Downloads-tab badge state from the number of active+queued
   * download jobs. Hidden at zero; shows the count, capped at "99+".
   * @returns {{visible: boolean, text: string}}
   */
  function queueBadge(count) {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n <= 0) return { visible: false, text: '' };
    return { visible: true, text: n > 99 ? '99+' : String(n) };
  }

  /**
   * Transfers-tab badge from the active+queued download and upload counts. One
   * pill showing the combined total, capped at "99+". `kind` selects the color:
   * 'upload' whenever any upload is active (so an ongoing upload stands out),
   * else 'download'. Hidden when nothing is transferring.
   * @returns {{visible: boolean, text: string, kind: 'download'|'upload'}}
   */
  function transferBadge(downloadCount, uploadCount) {
    const d = Math.floor(Number(downloadCount));
    const up = Math.floor(Number(uploadCount));
    const dn = Number.isFinite(d) && d > 0 ? d : 0;
    const un = Number.isFinite(up) && up > 0 ? up : 0;
    const total = dn + un;
    const badge = queueBadge(total);
    return { ...badge, kind: un > 0 ? 'upload' : 'download' };
  }

  /** The archive.org item (details) page URL for an identifier, or '' if none. */
  function itemPageUrl(identifier) {
    const id = String(identifier == null ? '' : identifier).trim();
    if (!id) return '';
    return `https://archive.org/details/${encodeURIComponent(id)}`;
  }

  /**
   * The archive.org profile page URL for a logged-in account's screenname.
   * Profiles live at /details/@<screenname>. Tolerates a leading '@' and
   * whitespace; returns '' when there's no usable screenname (e.g. only an
   * email is known).
   */
  function userProfileUrl(slug) {
    const name = String(slug == null ? '' : slug).trim().replace(/^@+/, '');
    // Only a VALID account slug (ASCII letters/digits/._-) yields a link. The
    // display screenname can be CJK/spaced (e.g. 石上苔), which is NOT a profile
    // slug and would 400 at /details/@石上苔 — return '' so the caller shows a
    // non-clickable name instead of a broken link.
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return '';
    return `https://archive.org/details/@${name}`;
  }

  /**
   * Confirm message before downloading a whole collection with more than
   * `threshold` (default 50) items, or null when no confirmation is needed.
   */
  function largeCollectionWarning(count, name, threshold = 50) {
    const n = Number(count) || 0;
    if (n <= threshold) return null;
    return `Are you sure you want to download all ${n.toLocaleString()} items from the collection “${name}”?`;
  }

  /**
   * Disclosure for the facet sidebar (#8): the counts are tallied from ONLY the
   * docs loaded on the current page (`lastDocs`), not the full result set — so a
   * "1940 — 15" facet can become 452 after clicking, because the click re-queries
   * archive.org for the whole set. This returns the caption + tooltip that make
   * that scope explicit, or `null` when no disclosure is needed (the whole result
   * set is already loaded, so the counts ARE the totals).
   *
   * @param {number} loaded the number of docs loaded on this page (lastDocs.length)
   * @param {number} total  the true result count from archive.org (numFound)
   * @returns {{caption:string, tooltip:string}|null}
   */
  function facetScopeNote(loaded, total) {
    const l = Math.floor(Number(loaded));
    const t = Math.floor(Number(total));
    // Bad input, nothing loaded, or the whole set is in hand → no disclosure.
    if (!Number.isFinite(l) || !Number.isFinite(t) || l <= 0 || t <= 0 || l >= t) {
      return null;
    }
    return {
      caption: `from the ${l.toLocaleString()} items shown`,
      tooltip:
        `Counts reflect the ${l.toLocaleString()} results loaded on this page. ` +
        `Clicking a value searches all ${t.toLocaleString()}.`,
    };
  }

  /**
   * Decide what the search-box scope dropdown should show for the current input.
   * The dropdown (Everything/Title/Creator/…) auto-blanks the moment the user
   * types a recognized `field:` token — the inline filter now governs the field,
   * so a dropdown scope would be redundant/confusing. With no recognized token in
   * the box it reverts to 'Everything'.
   *
   * @param {string} text the raw search-box text
   * @param {string[]} fields the recognized field names (e.g. ia-query SEARCH_FIELDS)
   * @returns {'Everything'|''} 'Everything' (plain text) or '' (blank — a token is present)
   */
  function scopeFromInput(text, fields) {
    const s = String(text == null ? '' : text);
    const known = (fields || []).map((f) => String(f).toLowerCase());
    // Any `word:` token whose name is a recognized field blanks the dropdown.
    const re = /(\w+):/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (known.includes(m[1].toLowerCase())) return '';
    }
    return 'Everything';
  }

  /**
   * Desired state of the BASIC search controls (search box, scope dropdown, year
   * boxes) given whether the Advanced panel is expanded. Opening Advanced
   * disables AND clears them (so stale basic input can't silently mix into the
   * advanced query); collapsing re-enables them but does NOT restore the cleared
   * values (the user deliberately switched to advanced).
   *
   * @param {boolean} advancedOpen whether the Advanced panel is showing
   * @returns {{disabled: boolean, clear: boolean}}
   */
  function basicControlsUpdate(advancedOpen) {
    return { disabled: !!advancedOpen, clear: !!advancedOpen };
  }

  /**
   * Render milliseconds remaining as "m:ss" for the overload auto-resume
   * countdown. Negative/NaN → "0:00". Partial seconds round UP so the display
   * never hits 0:00 while still waiting.
   */
  function formatCountdown(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '0:00';
    const totalSec = Math.ceil(n / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Map the broadcast `overload` block to the Transfers alert's display state.
   * `null` (gate open) → hidden. 'pause' → manual Resume, no countdown. 'delay'
   * → "Resume now" + a live countdown to resumeAt.
   *
   * @param {{mode:'pause'|'delay', resumeAt:number|null, reason:string}|null} overload
   * @returns {{visible:boolean, title?:string, message?:string, showCountdown?:boolean, buttonLabel?:string}}
   */
  function overloadAlertView(overload) {
    if (!overload || !overload.mode) return { visible: false };
    const message = overload.reason || 'Server appears to be overloaded or down.';
    if (overload.mode === 'pause') {
      return { visible: true, title: 'Transfers paused', message, showCountdown: false, buttonLabel: 'Resume' };
    }
    // 'delay'
    return {
      visible: true,
      title: 'Server overloaded — auto-resuming',
      message,
      showCountdown: true,
      buttonLabel: 'Resume now',
    };
  }

  /**
   * Startup banner text offering to resume transfers left unfinished by a
   * previous session (Phase 2). Empty string when there are none (banner hidden).
   *
   * @param {Array<{jobId,kind,label,count}>} summaries
   */
  function resumeOfferText(summaries) {
    const n = Array.isArray(summaries) ? summaries.length : 0;
    if (!n) return '';
    const noun = n === 1 ? 'transfer' : 'transfers';
    return `Resume ${n} unfinished ${noun} from your last session?`;
  }

  /**
   * Map persisted resume descriptors to an executable plan (Phase 2). Pure: the
   * renderer just runs each plan (createJobCard + the named window.ia.* call).
   * Uploads/bulk are marked `skipped` when logged out (they need a session and
   * stay persisted for a later launch); unknown kinds are dropped.
   *
   * @param {Array} jobs persisted descriptors
   * @param {{loggedIn:boolean}} ctx
   * @returns {Array<{channel,startArgs,card:{jobId,label,count,kind},skipped:boolean}>}
   */
  function planResumeReissue(jobs, { loggedIn } = {}) {
    const out = [];
    for (const d of jobs || []) {
      if (!d) continue;
      const isUpload = d.kind === 'upload' || d.kind === 'bulk';
      const skipped = isUpload && !loggedIn;
      if (d.kind === 'download') {
        out.push({
          channel: 'download.start',
          startArgs: { jobId: d.jobId, items: d.items, prefs: d.prefs, destRoot: d.destRoot, label: d.label },
          card: { jobId: d.jobId, label: d.label || 'download', count: 0, kind: 'download' },
          skipped: false,
        });
      } else if (d.kind === 'collection') {
        out.push({
          channel: 'download.collection',
          startArgs: { jobId: d.jobId, collection: d.collection, prefs: d.prefs, destRoot: d.destRoot, maxItems: d.maxItems },
          card: { jobId: d.jobId, label: d.label || `Collection: ${d.collection}`, count: 0, kind: 'download' },
          skipped: false,
        });
      } else if (d.kind === 'upload') {
        out.push({
          channel: 'upload.start',
          startArgs: { jobId: d.jobId, identifier: d.identifier, files: d.files, metadata: d.metadata, derive: d.derive },
          card: { jobId: d.jobId, label: d.identifier, count: (d.files || []).length, kind: 'upload' },
          skipped,
        });
      } else if (d.kind === 'bulk') {
        out.push({
          channel: 'bulk.upload',
          startArgs: { jobId: d.jobId, plan: d.plan, derive: d.derive },
          card: { jobId: d.jobId, label: d.label || `Bulk upload (${(d.plan || []).length} items)`, count: (d.plan || []).length, kind: 'upload' },
          skipped,
        });
      }
      // unknown kind → dropped
    }
    return out;
  }

  /**
   * The About-tab content as a structured, testable model. Blocks are headings
   * or paragraphs; a paragraph is an array of segments that are either plain
   * strings or {text, url} links. The renderer turns links into
   * shell.openExternal clicks (the strict CSP forbids in-page navigation, and
   * there are no raw <a href> links in the renderer).
   */
  function aboutContent() {
    const link = (text, url) => ({ text, url });
    // No leading "About" heading here — the About panel already renders an
    // <h2>About</h2> page title; adding one would show "About" twice.
    return [
      {
        type: 'para',
        segments: [
          'Grimmia was created in the spring of 2026 using Claude Opus 4.8 to help fans of the Internet Archive engage with its collections. The wonderful Internet Archive ',
          link('Command-Line Interface', 'https://archive.org/developers/internetarchive/cli.html'),
          ' provides a powerful way to interact with the rich collections at the Internet Archive via search, download, and upload. This application was built to help users less comfortable with the command line benefit from just some of these capabilities.',
        ],
      },
      {
        type: 'para',
        segments: [
          'This application provides a range of search options, and allows users to identify one or more items to add to a queue for sequential download. The app downloads only one file at a time, and by default has a few seconds between each download to mitigate impact on the IA servers. It aims to follow all IA best practices for use of its API. The application also supports upload features.',
        ],
      },
      {
        type: 'para',
        segments: [
          'The application requires that you have a free account with the Internet Archive, which may be created through their ',
          link('signup page', 'https://archive.org/signup'),
          '.',
        ],
      },
      { type: 'heading', text: 'Other Notes' },
      {
        type: 'para',
        segments: [
          'Grimmia is a cross-platform Electron application released into the public domain, and the code for it may be found ',
          link('at its repository', 'https://github.com/moss-on-stone/grimmia'),
          ' on GitHub. It has no third-party runtime dependencies: it relies only on Node’s built-in modules (such as https, fetch, and crypto) and the Electron runtime, with no external libraries bundled into the app. Its only build-time tools are Electron itself and electron-builder (used to package the installers). This keeps the install small and the code straightforward to audit.',
        ],
      },
      {
        type: 'para',
        segments: [
          'I do not believe I’ll have much time to work on this app, which may have bugs and shortcomings. I encourage anyone to fork the application and develop it as you see fit. I would be especially delighted if the Internet Archive was inspired to take this application as inspiration for a desktop application of their own.',
        ],
      },
      { type: 'para', segments: ['— Moss on Stone, June 2026'] },
    ];
  }

  /** Escape text for safe insertion as HTML text content. */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    formatBytes,
    percent,
    parseSubjects,
    buildUploadMetadata,
    validIdentifier,
    firstOf,
    escapeHtml,
    toDownloadItems,
    makeJobIdFactory,
    descriptionText,
    downloadDoneSummary,
    queueBadge,
    transferBadge,
    itemPageUrl,
    userProfileUrl,
    largeCollectionWarning,
    facetScopeNote,
    scopeFromInput,
    basicControlsUpdate,
    formatCountdown,
    overloadAlertView,
    resumeOfferText,
    planResumeReissue,
    aboutContent,
    UPLOAD_LANGUAGES,
  };
});
