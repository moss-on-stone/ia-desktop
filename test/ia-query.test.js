'use strict';

/**
 * Red/green TDD for the advanced query builder. Composes an archive.org
 * (Lucene-style) query string from structured UI inputs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAdvancedQuery, escapeFieldValue } = require('../src/main/ia-query');

/* ----------------------------- escaping ----------------------------------- */

test('escapeFieldValue quotes multi-word values', () => {
  assert.equal(escapeFieldValue('market street'), '"market street"');
});

test('escapeFieldValue leaves single tokens unquoted', () => {
  assert.equal(escapeFieldValue('cats'), 'cats');
});

test('escapeFieldValue escapes embedded double quotes', () => {
  assert.equal(escapeFieldValue('say "hi"'), '"say \\"hi\\""');
});

test('escapeFieldValue QUOTES values with parens so they cannot unbalance field:() (H1)', () => {
  // A bare paren used to pass through raw, breaking field:(...) into an
  // unbalanced query that archive.org rejects.
  assert.equal(escapeFieldValue('name)'), '"name)"');
  assert.equal(escapeFieldValue('x(y'), '"x(y"');
  assert.equal(escapeFieldValue('a)b(c'), '"a)b(c"');
});

test('escapeFieldValue quotes values with other Lucene specials (brackets, colon) (H1)', () => {
  assert.equal(escapeFieldValue('a:b'), '"a:b"');
  assert.equal(escapeFieldValue('a[b]'), '"a[b]"');
});

test('buildAdvancedQuery with a paren in a field value stays balanced (H1)', () => {
  assert.equal(buildAdvancedQuery({ creator: 'name)' }), 'creator:("name)")');
  assert.equal(buildAdvancedQuery({ identifier: 'x(y' }), 'identifier:("x(y")');
});

/* --------------------------- field combinations --------------------------- */

test('combines title and subject with AND', () => {
  const q = buildAdvancedQuery({ title: 'kokoro', subject: 'literature' });
  assert.equal(q, 'title:(kokoro) AND subject:(literature)');
});

test('quotes multi-word field values', () => {
  const q = buildAdvancedQuery({ title: 'market street' });
  assert.equal(q, 'title:("market street")');
});

test('mediatype filter is added as its own clause', () => {
  const q = buildAdvancedQuery({ subject: 'jazz', mediatype: 'audio' });
  assert.equal(q, 'subject:(jazz) AND mediatype:(audio)');
});

test('language filter is added', () => {
  const q = buildAdvancedQuery({ title: 'genji', language: 'jpn' });
  assert.equal(q, 'title:(genji) AND language:(jpn)');
});

test('creator filter is added', () => {
  const q = buildAdvancedQuery({ creator: 'natsume soseki' });
  assert.equal(q, 'creator:("natsume soseki")');
});

test('collection filter builds a collection: clause (not dropped → no *:* blowout)', () => {
  // Regression: collection used to be omitted from the clause loop, so a
  // "Collection:" search collapsed to *:* and returned the whole archive.
  const q = buildAdvancedQuery({ collection: 'xishijie-archive' });
  assert.equal(q, 'collection:(xishijie-archive)');
});

test('identifier filter builds an identifier: clause', () => {
  const q = buildAdvancedQuery({ identifier: 'NPTCM19400622' });
  assert.equal(q, 'identifier:(NPTCM19400622)');
});

test('collection combines with other fields', () => {
  const q = buildAdvancedQuery({ collection: 'prelinger', mediatype: 'movies' });
  assert.equal(q, 'collection:(prelinger) AND mediatype:(movies)');
});

test('multiple subjects are AND-joined (items must have ALL of them)', () => {
  // Subject facets accumulate to narrow results — each subject is its own clause
  // joined with AND, NOT a single OR clause.
  const q = buildAdvancedQuery({ subject: ['China', 'Newspapers'] });
  assert.equal(q, 'subject:(China) AND subject:(Newspapers)');
});

test('a multi-word subject in a multi-subject AND is still quoted', () => {
  const q = buildAdvancedQuery({ subject: ['world war', 'aviation'] });
  assert.equal(q, 'subject:("world war") AND subject:(aviation)');
});

test('a single subject (array of one) is a plain clause', () => {
  assert.equal(buildAdvancedQuery({ subject: ['China'] }), 'subject:(China)');
});

test('mediatype array stays OR-joined (a media type is an EITHER choice)', () => {
  // Only subject ANDs; mediatype keeps its OR semantics.
  const q = buildAdvancedQuery({ mediatype: ['texts', 'audio'] });
  assert.equal(q, 'mediatype:(texts OR audio)');
});

/* ------------------------------ date range -------------------------------- */

test('date range builds a Lucene range clause', () => {
  const q = buildAdvancedQuery({ subject: 'war', dateFrom: '1939-01-01', dateTo: '1945-12-31' });
  assert.equal(q, 'subject:(war) AND date:[1939-01-01 TO 1945-12-31]');
});

test('open-ended date-from uses wildcard upper bound', () => {
  const q = buildAdvancedQuery({ dateFrom: '2000-01-01' });
  assert.equal(q, 'date:[2000-01-01 TO *]');
});

test('open-ended date-to uses wildcard lower bound', () => {
  const q = buildAdvancedQuery({ dateTo: '2000-12-31' });
  assert.equal(q, 'date:[* TO 2000-12-31]');
});

/* --------------- month-precision year inputs (#11) ------------------------ */
// A bare YYYY expands to the whole year; YYYY-MM / YYYY-M expand to that whole
// month. `from` snaps to the start of the period, `to` to the end.

test('a bare YYYY expands to the whole year on each bound (#11)', () => {
  const q = buildAdvancedQuery({ dateFrom: '1940', dateTo: '1945' });
  assert.equal(q, 'date:[1940-01-01 TO 1945-12-31]');
});

test('YYYY-MM month input expands to the whole month (#11)', () => {
  const q = buildAdvancedQuery({ dateFrom: '1940-09', dateTo: '1941-02' });
  // Sept has 30 days; Feb 1941 (non-leap) has 28.
  assert.equal(q, 'date:[1940-09-01 TO 1941-02-28]');
});

test('single-digit month YYYY-M is accepted and zero-padded (#11)', () => {
  const q = buildAdvancedQuery({ dateFrom: '1940-9', dateTo: '1940-9' });
  assert.equal(q, 'date:[1940-09-01 TO 1940-09-30]');
});

test('February in a leap year expands to the 29th (#11)', () => {
  const q = buildAdvancedQuery({ dateTo: '1944-02' });
  assert.equal(q, 'date:[* TO 1944-02-29]');
});

test('a full ISO date passes through unchanged (#11 idempotent)', () => {
  const q = buildAdvancedQuery({ dateFrom: '1939-03-15', dateTo: '1945-08-06' });
  assert.equal(q, 'date:[1939-03-15 TO 1945-08-06]');
});

test('single-digit YYYY-M-D day is zero-padded too (L1)', () => {
  // Previously only single-digit MONTHS were padded; a single-digit day passed
  // through as 1940-03-5, producing an invalid Lucene range.
  const q = buildAdvancedQuery({ dateFrom: '1940-3-5' });
  assert.equal(q, 'date:[1940-03-05 TO *]');
});

test('a non-date junk bound is dropped rather than producing an invalid range (L1)', () => {
  // "abc" isn't a year/month/date → it must not leak into date:[abc TO ...].
  const q = buildAdvancedQuery({ dateFrom: 'abc', dateTo: '1945' });
  assert.equal(q, 'date:[* TO 1945-12-31]', 'junk from-bound dropped to wildcard');
});

test('a bogus month (13) is dropped; with no valid bound there is no date clause (L1)', () => {
  // 1940-13 is invalid → dropped. With both bounds blank/dropped, no date clause
  // is emitted (so it doesn't collapse to date:[* TO *]).
  assert.equal(buildAdvancedQuery({ dateFrom: '1940-13' }), '*:*');
  // A valid other bound still works alongside a dropped junk bound.
  assert.equal(buildAdvancedQuery({ dateFrom: '1940-13', dateTo: '1945' }), 'date:[* TO 1945-12-31]');
});

/* ----------------------------- free text ---------------------------------- */

test('free text is included as a bare clause', () => {
  const q = buildAdvancedQuery({ text: 'grateful dead', mediatype: 'audio' });
  assert.equal(q, '(grateful dead) AND mediatype:(audio)');
});

test('empty input yields a match-all query', () => {
  assert.equal(buildAdvancedQuery({}), '*:*');
});

test('whitespace-only fields are ignored', () => {
  const q = buildAdvancedQuery({ title: '  ', subject: 'poetry' });
  assert.equal(q, 'subject:(poetry)');
});

test('supports OR across multiple mediatypes', () => {
  const q = buildAdvancedQuery({ subject: 'history', mediatype: ['texts', 'audio'] });
  assert.equal(q, 'subject:(history) AND mediatype:(texts OR audio)');
});

/* --------------- free-text unbalanced parens (L6 robustness) --------------- */

test('free text with an unbalanced opening paren does not break the query', () => {
  // "foo (bar" wrapped as "(foo (bar)" would have unbalanced parens — invalid.
  const q = buildAdvancedQuery({ text: 'foo (bar' });
  const opens = (q.match(/\(/g) || []).length;
  const closes = (q.match(/\)/g) || []).length;
  assert.equal(opens, closes, `parens must be balanced, got: ${q}`);
});

test('free text with an unbalanced closing paren does not break the query', () => {
  const q = buildAdvancedQuery({ text: 'foo) bar' });
  const opens = (q.match(/\(/g) || []).length;
  const closes = (q.match(/\)/g) || []).length;
  assert.equal(opens, closes, `parens must be balanced, got: ${q}`);
});

test('balanced free-text parens are preserved', () => {
  const q = buildAdvancedQuery({ text: '(a OR b) c' });
  const opens = (q.match(/\(/g) || []).length;
  const closes = (q.match(/\)/g) || []).length;
  assert.equal(opens, closes);
  assert.match(q, /a OR b/);
});
