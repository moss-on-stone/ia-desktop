'use strict';

/**
 * Red/green TDD for idea #8: faceted filtering.
 *
 * Rather than depend on an undocumented server facet response, we derive facet
 * buckets from the result docs already in hand, then let a click AND a field
 * clause into the active query.
 *
 *  - computeFacets(docs, fields) → { field: [{value, count}], ... } sorted by count
 *  - applyFacetToSearch(activeSearch, field, value) → a NEW advanced search with
 *    the facet folded into its fields.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeFacets, applyFacetToSearch, FACET_FIELDS } = require('../src/shared/facets');

const DOCS = [
  { identifier: '1', mediatype: 'texts', language: 'English', date: '1999-05-05', collection: ['a', 'shared'] },
  { identifier: '2', mediatype: 'texts', language: ['English'], date: '2001-01-01', collection: 'b' },
  { identifier: '3', mediatype: 'audio', language: 'French', date: '2001-09-09', collection: ['shared'] },
];

test('FACET_FIELDS includes the standard facetable fields (incl. subject #5)', () => {
  for (const f of ['mediatype', 'year', 'language', 'collection', 'subject']) {
    assert.ok(FACET_FIELDS.includes(f), `missing facet field ${f}`);
  }
});

test('computeFacets splits delimited subject strings into separate buckets (#5)', () => {
  const docs = [
    { identifier: '1', subject: 'history; politics, war' },
    { identifier: '2', subject: ['history', 'art'] },
  ];
  const facets = computeFacets(docs, ['subject']);
  const map = Object.fromEntries(facets.subject.map((b) => [b.value, b.count]));
  assert.equal(map.history, 2, 'history appears in both docs');
  assert.equal(map.politics, 1);
  assert.equal(map.war, 1);
  assert.equal(map.art, 1);
});

test('computeFacets counts mediatype buckets sorted by count desc', () => {
  const facets = computeFacets(DOCS, ['mediatype']);
  assert.deepEqual(facets.mediatype, [
    { value: 'texts', count: 2 },
    { value: 'audio', count: 1 },
  ]);
});

test('computeFacets derives a "year" facet from the date field', () => {
  const facets = computeFacets(DOCS, ['year']);
  const map = Object.fromEntries(facets.year.map((b) => [b.value, b.count]));
  assert.equal(map['2001'], 2);
  assert.equal(map['1999'], 1);
});

test('computeFacets handles array-valued fields (language, collection)', () => {
  const facets = computeFacets(DOCS, ['language', 'collection']);
  const lang = Object.fromEntries(facets.language.map((b) => [b.value, b.count]));
  assert.equal(lang['English'], 2);
  assert.equal(lang['French'], 1);
  const col = Object.fromEntries(facets.collection.map((b) => [b.value, b.count]));
  assert.equal(col['shared'], 2, 'collection appearing in two docs counts twice');
});

test('computeFacets ignores docs missing the field', () => {
  const facets = computeFacets([{ identifier: 'x' }, { identifier: 'y', mediatype: 'data' }], ['mediatype']);
  assert.deepEqual(facets.mediatype, [{ value: 'data', count: 1 }]);
});

/* --------------------------- applyFacetToSearch --------------------------- */

test('applyFacetToSearch turns a basic search into an advanced one with the facet', () => {
  const out = applyFacetToSearch({ type: 'basic', q: 'jazz' }, 'mediatype', 'audio');
  assert.equal(out.type, 'advanced');
  assert.equal(out.fields.mediatype, 'audio');
  assert.equal(out.fields.text, 'jazz', 'the original query becomes free text');
});

test('applyFacetToSearch adds the facet to an existing advanced search', () => {
  const start = { type: 'advanced', fields: { title: 'kokoro' } };
  const out = applyFacetToSearch(start, 'language', 'jpn');
  assert.equal(out.fields.title, 'kokoro');
  assert.equal(out.fields.language, 'jpn');
});

test('applyFacetToSearch maps a "year" facet to a date range for that year', () => {
  const out = applyFacetToSearch({ type: 'advanced', fields: {} }, 'year', '1977');
  assert.equal(out.fields.dateFrom, '1977-01-01');
  assert.equal(out.fields.dateTo, '1977-12-31');
});

test('applyFacetToSearch does not mutate the input search', () => {
  const start = { type: 'advanced', fields: { title: 'x' } };
  const copy = JSON.parse(JSON.stringify(start));
  applyFacetToSearch(start, 'mediatype', 'texts');
  assert.deepEqual(start, copy);
});

/* ----- subject ACCUMULATES (multiple); other fields REPLACE (one at a time) - */

test('applyFacetToSearch ACCUMULATES subjects — a second subject keeps the first', () => {
  const start = { type: 'advanced', fields: { title: 'news', subject: 'China' } };
  const out = applyFacetToSearch(start, 'subject', 'Newspapers');
  assert.deepEqual(out.fields.subject, ['China', 'Newspapers'], 'both subjects kept');
  assert.equal(out.fields.title, 'news', 'other filters untouched');
});

test('applyFacetToSearch keeps subjects as an array even from a single first pick', () => {
  // The first subject is a scalar; clicking another grows it to an array.
  const out = applyFacetToSearch({ type: 'advanced', fields: { subject: ['China'] } }, 'subject', 'Shanghai');
  assert.deepEqual(out.fields.subject, ['China', 'Shanghai']);
});

test('applyFacetToSearch does NOT duplicate a subject already selected', () => {
  const start = { type: 'advanced', fields: { subject: ['China'] } };
  const out = applyFacetToSearch(start, 'subject', 'China');
  assert.deepEqual(out.fields.subject, ['China'], 'no duplicate');
});

test('applyFacetToSearch REPLACES collection (one at a time)', () => {
  const start = { type: 'advanced', fields: { collection: 'foo' } };
  const out = applyFacetToSearch(start, 'collection', 'bar');
  assert.equal(out.fields.collection, 'bar', 'collection replaced, not accumulated');
});

test('applyFacetToSearch ignores a blank value (no subject:[""] or date:[-01-01...]) (M3)', () => {
  const start = { type: 'advanced', fields: { title: 'x' } };
  // A blank subject must NOT add an empty entry.
  assert.deepEqual(applyFacetToSearch(start, 'subject', '').fields, { title: 'x' });
  // A blank year must NOT produce date:[-01-01 TO -12-31].
  const y = applyFacetToSearch(start, 'year', '');
  assert.ok(!('dateFrom' in y.fields), 'no dateFrom from a blank year');
  assert.deepEqual(applyFacetToSearch(start, 'mediatype', '   ').fields, { title: 'x' });
});

test('applyFacetToSearch REPLACES language / mediatype / year (one at a time)', () => {
  assert.equal(applyFacetToSearch({ type: 'advanced', fields: { language: 'eng' } }, 'language', 'jpn').fields.language, 'jpn');
  assert.equal(applyFacetToSearch({ type: 'advanced', fields: { mediatype: 'texts' } }, 'mediatype', 'audio').fields.mediatype, 'audio');
  const yr = applyFacetToSearch({ type: 'advanced', fields: { dateFrom: '1900-01-01', dateTo: '1900-12-31' } }, 'year', '1977');
  assert.equal(yr.fields.dateFrom, '1977-01-01');
});
