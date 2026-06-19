'use strict';

/**
 * Red/green TDD tests for pure renderer helpers (no DOM, no Electron).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const u = require('../src/renderer/ui-util');

/* ------------------------------ formatBytes ------------------------------- */

test('formatBytes handles zero and small values', () => {
  assert.equal(u.formatBytes(0), '0 B');
  assert.equal(u.formatBytes(512), '512 B');
});

test('formatBytes scales to KB/MB/GB', () => {
  assert.equal(u.formatBytes(1024), '1.0 KB');
  assert.equal(u.formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(u.formatBytes(1536 * 1024 * 1024), '1.5 GB');
});

test('formatBytes is tolerant of bad input', () => {
  assert.equal(u.formatBytes(null), '0 B');
  assert.equal(u.formatBytes('not a number'), '0 B');
});

/* ----------------------------- percent helper ----------------------------- */

test('percent clamps to 0..100 and rounds', () => {
  assert.equal(u.percent(0, 0), 0);
  assert.equal(u.percent(50, 200), 25);
  assert.equal(u.percent(300, 200), 100);
});

/* -------------------------- parseSubjects --------------------------------- */

test('parseSubjects splits, trims and drops empties', () => {
  assert.deepEqual(u.parseSubjects(' history , music ,, 1977 '), ['history', 'music', '1977']);
});

test('parseSubjects returns empty array for blank input', () => {
  assert.deepEqual(u.parseSubjects(''), []);
  assert.deepEqual(u.parseSubjects('   '), []);
});

/* ------------------------- buildUploadMetadata ---------------------------- */

test('buildUploadMetadata assembles a clean metadata object', () => {
  const md = u.buildUploadMetadata({
    title: 'My Title',
    creator: 'Me',
    date: '2024-01-01',
    mediatype: 'texts',
    description: 'Hello',
    subjects: 'a, b',
  });
  assert.equal(md.title, 'My Title');
  assert.equal(md.creator, 'Me');
  assert.equal(md.mediatype, 'texts');
  assert.deepEqual(md.subject, ['a', 'b']);
});

test('buildUploadMetadata omits empty optional fields', () => {
  const md = u.buildUploadMetadata({ title: 'T', mediatype: 'texts', subjects: '' });
  assert.equal(md.title, 'T');
  assert.ok(!('creator' in md));
  assert.ok(!('subject' in md));
  assert.ok(!('description' in md));
  // No language / bookreader fields unless explicitly provided.
  assert.ok(!('language' in md));
  assert.ok(!('page-progression' in md));
  assert.ok(!('bookreader-defaults' in md));
});

test('buildUploadMetadata includes the language code when set', () => {
  const md = u.buildUploadMetadata({ title: 'T', language: 'jpn' });
  assert.equal(md.language, 'jpn');
});

test('buildUploadMetadata omits a blank language', () => {
  const md = u.buildUploadMetadata({ title: 'T', language: '' });
  assert.ok(!('language' in md));
});

test('buildUploadMetadata emits page-progression=rl only when the flag is on', () => {
  assert.equal(u.buildUploadMetadata({ title: 'T', pageProgressionRl: true })['page-progression'], 'rl');
  assert.ok(!('page-progression' in u.buildUploadMetadata({ title: 'T', pageProgressionRl: false })));
  assert.ok(!('page-progression' in u.buildUploadMetadata({ title: 'T' })));
});

test('buildUploadMetadata emits bookreader-defaults=mode/1up only when the flag is on', () => {
  assert.equal(u.buildUploadMetadata({ title: 'T', oneUp: true })['bookreader-defaults'], 'mode/1up');
  assert.ok(!('bookreader-defaults' in u.buildUploadMetadata({ title: 'T', oneUp: false })));
});

/* ----------------------------- UPLOAD_LANGUAGES --------------------------- */

test('UPLOAD_LANGUAGES lists 15 languages incl. Japanese/Chinese/Korean (IA MARC codes)', () => {
  assert.ok(Array.isArray(u.UPLOAD_LANGUAGES));
  assert.equal(u.UPLOAD_LANGUAGES.length, 15);
  const byCode = Object.fromEntries(u.UPLOAD_LANGUAGES.map((l) => [l.code, l.label]));
  // IA uses MARC/bibliographic codes (verified against live archive.org counts).
  assert.equal(byCode.jpn, 'Japanese');
  assert.equal(byCode.chi, 'Chinese'); // chi, NOT zho
  assert.equal(byCode.kor, 'Korean');
  assert.equal(byCode.eng, 'English');
  assert.equal(byCode.fre, 'French'); // fre, NOT fra
  assert.equal(byCode.ger, 'German'); // ger, NOT deu
  // Every entry has a non-empty code + label.
  for (const l of u.UPLOAD_LANGUAGES) {
    assert.ok(l.code && /^[a-z]{3}$/.test(l.code), `bad code: ${l.code}`);
    assert.ok(l.label && l.label.length > 0);
  }
});

/* ---------------------------- validIdentifier ----------------------------- */

test('validIdentifier accepts ids with hyphens/dots/underscores', () => {
  assert.equal(u.validIdentifier('my-item_01.v2'), true);
});

test('validIdentifier accepts real uppercase IA identifiers (NPTCM…)', () => {
  // archive.org identifiers contain uppercase — these are valid.
  assert.equal(u.validIdentifier('NPTCM19400622'), true);
  assert.equal(u.validIdentifier('GratefulDead-1977'), true);
});

test('validIdentifier rejects spaces and bad chars', () => {
  assert.equal(u.validIdentifier('Has Space'), false);
  assert.equal(u.validIdentifier('bad/slash'), false);
  assert.equal(u.validIdentifier(''), false);
});

/* ------------------------------ queueBadge -------------------------------- */

test('queueBadge hides when there are no active/queued downloads', () => {
  const b = u.queueBadge(0);
  assert.equal(b.visible, false);
  assert.equal(b.text, '');
});

test('queueBadge shows the count when downloads are active/queued', () => {
  assert.deepEqual(u.queueBadge(1), { visible: true, text: '1' });
  assert.deepEqual(u.queueBadge(3), { visible: true, text: '3' });
});

test('queueBadge caps the displayed number at 99+', () => {
  assert.deepEqual(u.queueBadge(150), { visible: true, text: '99+' });
});

test('queueBadge treats bad input as zero', () => {
  assert.equal(u.queueBadge(-2).visible, false);
  assert.equal(u.queueBadge(null).visible, false);
  assert.equal(u.queueBadge('x').visible, false);
});

/* ------------------------------ itemPageUrl ------------------------------- */

test('itemPageUrl builds the archive.org details URL', () => {
  assert.equal(u.itemPageUrl('NPTCM19400622'), 'https://archive.org/details/NPTCM19400622');
});

test('itemPageUrl encodes the identifier', () => {
  assert.equal(u.itemPageUrl('a b'), 'https://archive.org/details/a%20b');
});

test('itemPageUrl returns empty for a missing identifier', () => {
  assert.equal(u.itemPageUrl(''), '');
  assert.equal(u.itemPageUrl(null), '');
});

/* -------------------------- largeCollectionWarning ------------------------ */
// A confirm message shown before downloading a collection with more than the
// threshold (default 50) items; null when no confirm is needed.

test('largeCollectionWarning warns above the threshold with count + name', () => {
  const msg = u.largeCollectionWarning(359, 'north-china-daily-news');
  assert.match(msg, /359/);
  assert.match(msg, /north-china-daily-news/);
  assert.match(msg, /download all/i);
});

test('largeCollectionWarning returns null at or below the threshold (no confirm)', () => {
  assert.equal(u.largeCollectionWarning(50, 'x'), null);
  assert.equal(u.largeCollectionWarning(10, 'x'), null);
  assert.equal(u.largeCollectionWarning(51, 'x') === null, false, '51 needs a confirm');
});

test('largeCollectionWarning formats large counts with separators', () => {
  const msg = u.largeCollectionWarning(123456, 'big');
  assert.match(msg, /123,456/);
});

test('largeCollectionWarning honors a custom threshold', () => {
  assert.equal(u.largeCollectionWarning(5, 'x', 10), null);
  assert.ok(u.largeCollectionWarning(11, 'x', 10));
});

/* ----------------------------- userProfileUrl ----------------------------- */
// Clicking the logged-in username opens that account's archive.org profile at
// https://archive.org/details/@<slug>. The slug must be a VALID account
// identifier (ASCII letters/digits/._-) — the xauthn `itemname`, NOT the display
// `screenname`. A CJK/spaced display name (e.g. 石上苔) is NOT a slug and would
// 400, so we return '' (renderer then shows a non-clickable name).

test('userProfileUrl builds the @slug profile URL for a valid slug', () => {
  assert.equal(u.userProfileUrl('konrad'), 'https://archive.org/details/@konrad');
  assert.equal(u.userProfileUrl('stone-on_moss.1'), 'https://archive.org/details/@stone-on_moss.1');
  // The real-world slug form from the logged-in-user cookie (underscores).
  assert.equal(u.userProfileUrl('g_y_library'), 'https://archive.org/details/@g_y_library');
});

test('userProfileUrl tolerates a leading @ and trims whitespace', () => {
  assert.equal(u.userProfileUrl('@konrad'), 'https://archive.org/details/@konrad');
  assert.equal(u.userProfileUrl('  konrad  '), 'https://archive.org/details/@konrad');
});

test('userProfileUrl returns empty for a non-slug display name (the 400 bug)', () => {
  // CJK display name → not a valid account slug → no link (was /details/@石上苔 = 400).
  assert.equal(u.userProfileUrl('石上苔'), '');
  // Spaces are not valid in an account slug either.
  assert.equal(u.userProfileUrl('a b'), '');
});

test('userProfileUrl returns empty for a missing slug (e.g. only an email)', () => {
  assert.equal(u.userProfileUrl(''), '');
  assert.equal(u.userProfileUrl(null), '');
  assert.equal(u.userProfileUrl('@'), '');
});

/* -------------------------- basicControlsUpdate --------------------------- */
// When the Advanced panel is expanded, the basic search box + scope dropdown +
// year boxes to its left are disabled AND cleared (they'd otherwise silently mix
// into / conflict with the advanced query). Collapsing the panel re-enables them
// (we don't restore the cleared values — the user moved to advanced on purpose).

test('basicControlsUpdate disables and clears the basic controls when Advanced opens', () => {
  assert.deepEqual(u.basicControlsUpdate(true), { disabled: true, clear: true });
});

test('basicControlsUpdate re-enables (without clearing) when Advanced closes', () => {
  assert.deepEqual(u.basicControlsUpdate(false), { disabled: false, clear: false });
});

/* ----------------------------- formatCountdown ---------------------------- */
// Renders ms remaining until auto-resume as "m:ss" for the overload alert.

test('formatCountdown renders minutes:seconds', () => {
  assert.equal(u.formatCountdown(0), '0:00');
  assert.equal(u.formatCountdown(65000), '1:05');
  assert.equal(u.formatCountdown(3600000), '60:00');
  assert.equal(u.formatCountdown(5000), '0:05');
});

test('formatCountdown clamps negative/NaN to 0:00 and rounds up partial seconds', () => {
  assert.equal(u.formatCountdown(-1000), '0:00');
  assert.equal(u.formatCountdown('nope'), '0:00');
  // 1500ms should read as 0:02 (ceil) so the countdown never shows 0:00 while waiting.
  assert.equal(u.formatCountdown(1500), '0:02');
});

/* ----------------------------- overloadAlertView -------------------------- */
// Maps the broadcast `overload` block to the alert's display state. null → hidden.

test('overloadAlertView returns hidden for no overload', () => {
  const v = u.overloadAlertView(null);
  assert.equal(v.visible, false);
});

test('overloadAlertView describes pause mode (manual resume, no countdown)', () => {
  const v = u.overloadAlertView({ mode: 'pause', resumeAt: null, reason: 'Server down.' });
  assert.equal(v.visible, true);
  assert.equal(v.showCountdown, false);
  assert.match(v.title, /paused/i);
  assert.match(v.message, /Server down\./);
  assert.match(v.buttonLabel, /resume/i);
});

test('overloadAlertView describes delay mode (countdown + Resume now)', () => {
  const v = u.overloadAlertView({ mode: 'delay', resumeAt: 123, reason: 'Server overloaded.' });
  assert.equal(v.visible, true);
  assert.equal(v.showCountdown, true);
  assert.match(v.buttonLabel, /resume now/i);
});

test('overloadAlertView supplies a default message when no reason is given', () => {
  const v = u.overloadAlertView({ mode: 'pause' }); // no reason
  assert.equal(v.visible, true);
  assert.ok(v.message && v.message.length > 0, 'a fallback message is present');
});

/* ----------------------------- resumeOfferText ---------------------------- */
// The startup banner offering to resume transfers left unfinished by a previous
// session. Singular/plural; empty list → '' (banner stays hidden).

test('resumeOfferText is singular for one job', () => {
  assert.equal(
    u.resumeOfferText([{ jobId: 'a', kind: 'download', label: 'X', count: 1 }]),
    'Resume 1 unfinished transfer from your last session?'
  );
});

test('resumeOfferText is plural for several jobs', () => {
  const jobs = [
    { jobId: 'a', kind: 'download', label: 'X', count: 1 },
    { jobId: 'b', kind: 'upload', label: 'Y', count: 2 },
    { jobId: 'c', kind: 'bulk', label: 'Z', count: 3 },
  ];
  assert.equal(u.resumeOfferText(jobs), 'Resume 3 unfinished transfers from your last session?');
});

test('resumeOfferText is empty for no jobs (banner hidden)', () => {
  assert.equal(u.resumeOfferText([]), '');
  assert.equal(u.resumeOfferText(null), '');
});

/* --------------------------- planResumeReissue ---------------------------- */
// Pure mapping of persisted resume descriptors → {channel, startArgs, card,
// skipped}. The renderer just executes the plan (createJobCard + window.ia.*).
// Uploads are skipped (not executed) when logged out — they stay persisted.

test('planResumeReissue maps each kind to its channel + start args + card', () => {
  const jobs = [
    { kind: 'download', jobId: 'd1', items: [{ identifier: 'x' }], prefs: { a: 1 }, destRoot: '/dl', label: 'Two' },
    { kind: 'collection', jobId: 'c1', collection: 'col', prefs: {}, destRoot: '/dl', maxItems: 50, label: 'Collection: col' },
    { kind: 'upload', jobId: 'u1', identifier: 'it', files: [{ path: '/a', name: 'a' }], metadata: { t: 1 }, derive: true },
    { kind: 'bulk', jobId: 'b1', plan: [{}, {}], derive: false, label: 'Bulk upload (2 items)' },
  ];
  const plans = u.planResumeReissue(jobs, { loggedIn: true });
  assert.equal(plans.length, 4);

  const [dl, coll, up, bulk] = plans;
  assert.equal(dl.channel, 'download.start');
  assert.deepEqual(dl.startArgs, { jobId: 'd1', items: [{ identifier: 'x' }], prefs: { a: 1 }, destRoot: '/dl', label: 'Two' });
  assert.deepEqual(dl.card, { jobId: 'd1', label: 'Two', count: 0, kind: 'download' });
  assert.ok(!dl.skipped);

  assert.equal(coll.channel, 'download.collection');
  assert.deepEqual(coll.startArgs, { jobId: 'c1', collection: 'col', prefs: {}, destRoot: '/dl', maxItems: 50 });
  assert.equal(coll.card.kind, 'download');

  assert.equal(up.channel, 'upload.start');
  assert.deepEqual(up.startArgs, { jobId: 'u1', identifier: 'it', files: [{ path: '/a', name: 'a' }], metadata: { t: 1 }, derive: true });
  assert.equal(up.card.count, 1, 'upload card count = file count');

  assert.equal(bulk.channel, 'bulk.upload');
  assert.deepEqual(bulk.startArgs, { jobId: 'b1', plan: [{}, {}], derive: false });
  assert.equal(bulk.card.count, 2, 'bulk card count = plan length');
});

test('planResumeReissue marks upload/bulk jobs skipped when logged out', () => {
  const jobs = [
    { kind: 'download', jobId: 'd', items: [], prefs: {}, destRoot: '/dl', label: 'D' },
    { kind: 'upload', jobId: 'u', identifier: 'i', files: [], metadata: {} },
    { kind: 'bulk', jobId: 'b', plan: [], derive: false },
  ];
  const plans = u.planResumeReissue(jobs, { loggedIn: false });
  assert.equal(plans.find((p) => p.channel === 'download.start').skipped, false, 'downloads run when logged out');
  assert.equal(plans.find((p) => p.startArgs.jobId === 'u').skipped, true, 'upload skipped logged-out');
  assert.equal(plans.find((p) => p.startArgs.jobId === 'b').skipped, true, 'bulk skipped logged-out');
});

test('planResumeReissue tolerates an empty/unknown list', () => {
  assert.deepEqual(u.planResumeReissue([], { loggedIn: true }), []);
  assert.deepEqual(u.planResumeReissue(null, { loggedIn: true }), []);
  // Unknown kind → no plan entry (skipped silently).
  assert.deepEqual(u.planResumeReissue([{ kind: 'bogus', jobId: 'z' }], { loggedIn: true }), []);
});

/* ----------------------------- transferBadge ------------------------------ */

test('transferBadge hides when nothing is transferring', () => {
  const b = u.transferBadge(0, 0);
  assert.equal(b.visible, false);
  assert.equal(b.text, '');
});

test('transferBadge shows the combined total of downloads + uploads', () => {
  assert.equal(u.transferBadge(2, 1).text, '3');
  assert.equal(u.transferBadge(2, 1).visible, true);
});

test('transferBadge is colored "download" when only downloads are active', () => {
  assert.equal(u.transferBadge(2, 0).kind, 'download');
});

test('transferBadge is colored "upload" when any upload is active', () => {
  // Upload color takes priority so an ongoing upload is visible.
  assert.equal(u.transferBadge(0, 1).kind, 'upload');
  assert.equal(u.transferBadge(3, 1).kind, 'upload');
});

test('transferBadge caps the total at 99+', () => {
  assert.equal(u.transferBadge(80, 40).text, '99+');
});

test('transferBadge treats bad input as zero', () => {
  assert.equal(u.transferBadge(null, undefined).visible, false);
  assert.equal(u.transferBadge('x', 'y').visible, false);
});

/* ------------------------------- firstOf ---------------------------------- */

test('firstOf returns first element of array or the value itself', () => {
  assert.equal(u.firstOf(['a', 'b']), 'a');
  assert.equal(u.firstOf('solo'), 'solo');
  assert.equal(u.firstOf(undefined), '');
});

/* ---------------------------- facetScopeNote ------------------------------ */
// The facet counts are tallied client-side from only the docs loaded on the
// current page (lastDocs), NOT the full result set. So "1940 — 15" means "15
// of the loaded items", while clicking it re-queries archive.org and can show
// 452. facetScopeNote() produces the disclosure caption + tooltip that makes
// this scope explicit, given (loaded count, true total numFound).

test('facetScopeNote discloses the loaded subset when total exceeds loaded', () => {
  const note = u.facetScopeNote(200, 16359);
  assert.ok(note, 'a note should be returned when the loaded subset is partial');
  assert.equal(note.caption, 'from the 200 items shown');
  // The tooltip must mention BOTH the loaded count and the full total, and that
  // clicking searches the whole set — so the count change on click isn't a shock.
  assert.match(note.tooltip, /200/);
  assert.match(note.tooltip, /16,359/); // full total, thousands-separated
  assert.match(note.tooltip, /clic/i); // explains that clicking re-queries
});

test('facetScopeNote returns null when the whole result set is loaded', () => {
  // Counts ARE the totals here, so no disclosure is needed.
  assert.equal(u.facetScopeNote(40, 40), null);
  assert.equal(u.facetScopeNote(200, 120), null); // loaded >= total (e.g. last page)
});

test('facetScopeNote is tolerant of bad/zero input', () => {
  assert.equal(u.facetScopeNote(0, 0), null);
  assert.equal(u.facetScopeNote(null, null), null);
  assert.equal(u.facetScopeNote('x', 'y'), null);
});

/* ---------------------------- scopeFromInput ------------------------------ */
// The search-box scope dropdown auto-blanks when the user types a recognized
// `field:` token (the inline filter now governs), and reverts to 'Everything'
// when no such token is present. scopeFromInput decides which it should show,
// given the current text and the list of recognized field names.

const FIELDS = ['title', 'subject', 'creator', 'description', 'language', 'mediatype', 'date', 'collection', 'identifier'];

test('scopeFromInput returns Everything for plain text (no field token)', () => {
  assert.equal(u.scopeFromInput('black cats', FIELDS), 'Everything');
  assert.equal(u.scopeFromInput('', FIELDS), 'Everything');
  assert.equal(u.scopeFromInput('   ', FIELDS), 'Everything');
});

test('scopeFromInput blanks when a recognized field token is present', () => {
  assert.equal(u.scopeFromInput('title:kokoro', FIELDS), '');
  assert.equal(u.scopeFromInput('soseki creator:twain', FIELDS), '');
  // mid-typing: as soon as "subject:" appears, blank it.
  assert.equal(u.scopeFromInput('subject:', FIELDS), '');
});

test('scopeFromInput is case-insensitive on the field name', () => {
  assert.equal(u.scopeFromInput('Title:Kokoro', FIELDS), '');
});

test('scopeFromInput ignores unknown field-like tokens', () => {
  // foo: is not a recognized field, so the dropdown stays on Everything.
  assert.equal(u.scopeFromInput('foo:bar baz', FIELDS), 'Everything');
  assert.equal(u.scopeFromInput('http://example.com', FIELDS), 'Everything');
});

/* ------------------------------- aboutContent ----------------------------- */
// The About tab content as a structured, testable model (blocks of headings and
// paragraphs; paragraphs are segments of plain text or {text,url} links). The
// renderer turns links into shell.openExternal clicks (no raw <a href> under the
// strict CSP).

test('aboutContent returns headings and paragraphs with link segments', () => {
  const blocks = u.aboutContent();
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
  // Every block is a heading or a paragraph with a segments array.
  for (const b of blocks) {
    assert.ok(b.type === 'heading' || b.type === 'para', `unexpected block type ${b.type}`);
    if (b.type === 'heading') assert.equal(typeof b.text, 'string');
    if (b.type === 'para') assert.ok(Array.isArray(b.segments));
  }
  // The "Other Notes" section heading is part of the content...
  assert.ok(blocks.some((b) => b.type === 'heading' && /other notes/i.test(b.text)), 'has the Other Notes heading');
  // ...but NOT a redundant "About" heading — the panel's <h2>About</h2> is the
  // page title, so a duplicate here would render "About" twice.
  assert.ok(!blocks.some((b) => b.type === 'heading' && /^about$/i.test(b.text.trim())), 'no duplicate About heading');
});

test('aboutContent links point at the right archive.org / GitHub URLs', () => {
  const links = u
    .aboutContent()
    .filter((b) => b.type === 'para')
    .flatMap((b) => b.segments)
    .filter((s) => s && s.url);
  const urls = links.map((l) => l.url);
  assert.ok(urls.some((u2) => /archive\.org\/developers\/internetarchive\/cli/.test(u2)), 'IA CLI docs link');
  assert.ok(urls.some((u2) => /archive\.org\/signup/.test(u2)), 'signup link');
  assert.ok(urls.includes('https://github.com/moss-on-stone/grimmia'), 'the new repo URL');
  // Every link must be an absolute https URL (the renderer opens these externally).
  for (const l of links) assert.match(l.url, /^https:\/\//, `link ${l.text} must be https`);
});

test('aboutContent states the dependency claim accurately (no third-party RUNTIME deps)', () => {
  const text = u
    .aboutContent()
    .filter((b) => b.type === 'para')
    .flatMap((b) => b.segments)
    .map((s) => (typeof s === 'string' ? s : s.text))
    .join(' ');
  // Must qualify "runtime" — not an unqualified "no dependencies" (Electron + 2
  // dev tools exist). Must mention Electron.
  assert.match(text, /runtime/i, 'claim is scoped to runtime dependencies');
  assert.match(text, /Electron/, 'mentions the Electron runtime');
  assert.ok(!/\bno dependencies\b/i.test(text), 'must not overclaim "no dependencies"');
});

test('aboutContent is signed and dated', () => {
  const text = u
    .aboutContent()
    .filter((b) => b.type === 'para')
    .flatMap((b) => b.segments)
    .map((s) => (typeof s === 'string' ? s : s.text))
    .join(' ');
  assert.match(text, /Moss on Stone/);
  assert.match(text, /2026/);
});
