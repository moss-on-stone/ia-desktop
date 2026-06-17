'use strict';

/**
 * facets.js (shared, pure)
 *
 * Faceted filtering of search results (#8), derived from the result docs already
 * in hand (mediatype, year, language, collection). Clicking a facet folds a
 * field clause into the active search and re-runs it.
 *
 * CommonJS (tests/main) and plain <script> (window.facets).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.facets = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const FACET_FIELDS = ['mediatype', 'year', 'subject', 'language', 'collection'];

  /** Collect the value(s) of a facet field from one doc as an array of strings. */
  function valuesFor(doc, field) {
    if (field === 'year') {
      const d = Array.isArray(doc.date) ? doc.date[0] : doc.date;
      const m = /^(\d{4})/.exec(String(d || ''));
      return m ? [m[1]] : [];
    }
    const raw = doc[field];
    if (raw == null) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    // Subjects often arrive as one delimited string ("a; b, c") — split them.
    const flat = field === 'subject' ? list.flatMap((v) => String(v).split(/[;,]/)) : list;
    return flat.map((v) => String(v).trim()).filter(Boolean);
  }

  /**
   * Compute facet buckets for the given fields over a set of docs.
   * @returns {Object<string, Array<{value:string,count:number}>>} buckets sorted
   *   by count desc, then value asc.
   */
  function computeFacets(docs, fields = FACET_FIELDS) {
    const out = {};
    for (const field of fields) {
      const counts = new Map();
      for (const doc of docs || []) {
        for (const v of valuesFor(doc, field)) counts.set(v, (counts.get(v) || 0) + 1);
      }
      out[field] = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return out;
  }

  /**
   * Fold a facet selection into a search descriptor, returning a NEW advanced
   * search. A basic search's query text is preserved as the `text` field.
   */
  function applyFacetToSearch(search, field, value) {
    // Ignore a blank value (M3) — folding '' in would create subject:[''] or a
    // malformed year range like date:[-01-01 TO -12-31]. Return the search
    // unchanged (normalized to advanced if it was basic).
    if (value == null || String(value).trim() === '') {
      if (search && search.type === 'advanced') return { type: 'advanced', fields: { ...(search.fields || {}) } };
      const text = (search && search.q) || '';
      return text ? { type: 'advanced', fields: { text } } : { type: 'advanced', fields: {} };
    }
    const base =
      search && search.type === 'advanced'
        ? { ...(search.fields || {}) }
        : { text: (search && search.q) || '' };

    if (field === 'year') {
      base.dateFrom = `${value}-01-01`;
      base.dateTo = `${value}-12-31`;
    } else if (field === 'subject') {
      // Subjects ACCUMULATE (search for items with ALL the chosen subjects).
      // Other fields replace (one at a time). Dedup so a re-click is a no-op.
      const existing = base.subject == null ? [] : Array.isArray(base.subject) ? base.subject : [base.subject];
      const list = existing.map((s) => String(s));
      if (!list.includes(String(value))) list.push(String(value));
      base.subject = list;
    } else {
      base[field] = value;
    }
    if (!base.text) delete base.text;
    return { type: 'advanced', fields: base };
  }

  return { FACET_FIELDS, computeFacets, applyFacetToSearch };
});
