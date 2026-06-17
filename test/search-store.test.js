'use strict';

/**
 * Red/green TDD for idea #6: saved searches & search history (pure list logic).
 *
 *  - addRecent(list, entry, cap): most-recent-first, de-duplicated, capped.
 *  - addSaved / removeSaved / renameSaved for named queries.
 *  - searchSignature(query) → a stable key for de-duping basic/advanced searches.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  addRecent,
  addSaved,
  removeSaved,
  renameSaved,
  searchSignature,
  searchLabel,
  collectionIdForSearch,
  isEmptySearch,
} = require('../src/shared/search-store');

/* ------------------------------ isEmptySearch ----------------------------- */
// True when a search has no meaningful terms — used to clear the view instead
// of running *:* (which would return the whole 123M-item archive).

test('isEmptySearch: an advanced search with no non-blank fields is empty', () => {
  assert.equal(isEmptySearch({ type: 'advanced', fields: {} }), true);
  assert.equal(isEmptySearch({ type: 'advanced', fields: { title: '', subject: [] } }), true);
  assert.equal(isEmptySearch({ type: 'advanced', fields: { mediatype: '   ' } }), true);
});

test('isEmptySearch: an array of only BLANK strings is empty (H2 — avoids *:* blowout)', () => {
  // subject:[''] used to count as non-empty here but build *:* in the query —
  // the exact gap that returned the whole 123M-item archive.
  assert.equal(isEmptySearch({ type: 'advanced', fields: { subject: [''] } }), true);
  assert.equal(isEmptySearch({ type: 'advanced', fields: { subject: ['', '  '] } }), true);
  assert.equal(isEmptySearch({ type: 'advanced', fields: { subject: ['', 'China'] } }), false, 'one real subject → not empty');
});

test('isEmptySearch: a search with any real term is NOT empty', () => {
  assert.equal(isEmptySearch({ type: 'advanced', fields: { subject: ['China'] } }), false);
  assert.equal(isEmptySearch({ type: 'advanced', fields: { dateFrom: '1940-01-01' } }), false);
  assert.equal(isEmptySearch({ type: 'basic', q: 'cats' }), false);
});

test('isEmptySearch: a blank/absent basic query is empty; null is empty', () => {
  assert.equal(isEmptySearch({ type: 'basic', q: '' }), true);
  assert.equal(isEmptySearch({ type: 'basic', q: '   ' }), true);
  assert.equal(isEmptySearch(null), true);
});

/* ---------------------------- collectionIdForSearch ----------------------- */
// Returns the single collection id a search targets (so the "Download
// collection" button shows), or '' when it isn't a single-collection search.

test('collectionIdForSearch reads a basic "collection:foo" query', () => {
  assert.equal(collectionIdForSearch({ type: 'basic', q: 'collection:xishijie-archive' }), 'xishijie-archive');
  assert.equal(collectionIdForSearch({ type: 'basic', q: '  collection: prelinger ' }), 'prelinger');
  assert.equal(collectionIdForSearch({ type: 'basic', q: 'collection:"my coll"' }), 'my coll');
});

test('collectionIdForSearch reads an advanced search whose only field is collection', () => {
  assert.equal(collectionIdForSearch({ type: 'advanced', fields: { collection: 'prelinger' } }), 'prelinger');
});

test('collectionIdForSearch returns "" when other terms scope the collection down', () => {
  assert.equal(collectionIdForSearch({ type: 'basic', q: 'collection:prelinger cats' }), '', 'extra words');
  assert.equal(collectionIdForSearch({ type: 'advanced', fields: { collection: 'prelinger', mediatype: 'movies' } }), '', 'extra field');
});

test('collectionIdForSearch returns "" for non-collection searches', () => {
  assert.equal(collectionIdForSearch({ type: 'basic', q: 'cats' }), '');
  assert.equal(collectionIdForSearch({ type: 'advanced', fields: { creator: 'x' } }), '');
  assert.equal(collectionIdForSearch(null), '');
});

/* ------------------------------- searchLabel ------------------------------ */

test('searchLabel shows the query text for a basic search', () => {
  assert.equal(searchLabel({ type: 'basic', q: 'grateful dead' }), 'grateful dead');
});

test('searchLabel summarizes advanced fields', () => {
  const label = searchLabel({ type: 'advanced', fields: { title: 'kokoro', creator: 'soseki' } });
  assert.match(label, /title: kokoro/);
  assert.match(label, /creator: soseki/);
});

test('searchLabel ignores blank advanced fields', () => {
  const label = searchLabel({ type: 'advanced', fields: { title: 'x', subject: '', mediatype: [] } });
  assert.equal(label, 'title: x');
});

test('searchLabel handles an empty search gracefully', () => {
  assert.equal(searchLabel({ type: 'advanced', fields: {} }), '(all items)');
  assert.equal(searchLabel({ type: 'basic', q: '' }), '(empty)');
});

/* -------------------------------- addRecent ------------------------------- */

test('addRecent prepends the newest entry', () => {
  const out = addRecent([{ q: 'a' }], { q: 'b' }, 10);
  assert.deepEqual(out.map((e) => e.q), ['b', 'a']);
});

test('addRecent de-duplicates by signature, moving the repeat to the front', () => {
  const start = [{ type: 'basic', q: 'cats' }, { type: 'basic', q: 'dogs' }];
  const out = addRecent(start, { type: 'basic', q: 'dogs' }, 10);
  assert.deepEqual(out.map((e) => e.q), ['dogs', 'cats'], 'dogs moves to front, no dupe');
  assert.equal(out.length, 2);
});

test('addRecent caps the list length, dropping the oldest', () => {
  let list = [];
  for (const q of ['1', '2', '3', '4']) list = addRecent(list, { type: 'basic', q }, 3);
  assert.deepEqual(list.map((e) => e.q), ['4', '3', '2'], 'oldest (1) dropped');
});

test('addRecent does not mutate the input list', () => {
  const start = [{ type: 'basic', q: 'x' }];
  const copy = start.slice();
  addRecent(start, { type: 'basic', q: 'y' }, 10);
  assert.deepEqual(start, copy);
});

/* ------------------------ saved searches (named) -------------------------- */

test('addSaved appends a named query', () => {
  const out = addSaved([], { name: 'Jazz', search: { type: 'basic', q: 'jazz' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Jazz');
});

test('addSaved replaces an existing entry with the same name (no duplicates)', () => {
  let list = addSaved([], { name: 'Jazz', search: { q: 'jazz' } });
  list = addSaved(list, { name: 'Jazz', search: { q: 'jazz 1959' } });
  assert.equal(list.length, 1);
  assert.equal(list[0].search.q, 'jazz 1959');
});

test('removeSaved drops the entry by name', () => {
  const list = [{ name: 'A', search: {} }, { name: 'B', search: {} }];
  assert.deepEqual(removeSaved(list, 'A').map((e) => e.name), ['B']);
});

test('renameSaved changes the name, leaving the search intact', () => {
  const list = [{ name: 'Old', search: { q: 'x' } }];
  const out = renameSaved(list, 'Old', 'New');
  assert.equal(out[0].name, 'New');
  assert.equal(out[0].search.q, 'x');
});

test('renameSaved is a no-op when the old name is missing', () => {
  const list = [{ name: 'A', search: {} }];
  assert.deepEqual(renameSaved(list, 'Z', 'New'), list);
});

/* ----------------------------- searchSignature ---------------------------- */

test('searchSignature is stable for the same basic query', () => {
  assert.equal(searchSignature({ type: 'basic', q: 'cats' }), searchSignature({ type: 'basic', q: 'cats' }));
});

test('searchSignature differs for basic vs advanced with the same text', () => {
  const a = searchSignature({ type: 'basic', q: 'cats' });
  const b = searchSignature({ type: 'advanced', fields: { title: 'cats' } });
  assert.notEqual(a, b);
});

test('searchSignature ignores field key order in advanced searches', () => {
  const a = searchSignature({ type: 'advanced', fields: { title: 't', subject: 's' } });
  const b = searchSignature({ type: 'advanced', fields: { subject: 's', title: 't' } });
  assert.equal(a, b);
});
