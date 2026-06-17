'use strict';

/**
 * ia-query.js
 *
 * Pure builder for archive.org (Lucene-style) advanced query strings from
 * structured UI inputs. No network — fully unit-testable.
 *
 * archive.org search uses Lucene syntax:
 *   field:(value)            field match
 *   field:("two words")      quoted phrase
 *   date:[A TO B]            range (A or B may be * for open-ended)
 *   clause AND clause        conjunction
 */

/**
 * Quote a field value if it contains whitespace OR any Lucene special character,
 * and escape embedded quotes (H1). A bare paren/bracket/colon in a value would
 * otherwise unbalance the surrounding `field:(...)` clause and make archive.org
 * reject the query. Inside quotes these are literals, so quoting is sufficient.
 */
function escapeFieldValue(value) {
  const s = String(value).trim();
  const escaped = s.replace(/"/g, '\\"');
  // Whitespace, parens, brackets, braces, colon, or a quote → must be quoted.
  return /[\s()[\]{}":]/.test(s) ? `"${escaped}"` : escaped;
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/**
 * Make free-text safe to wrap in an outer `(...)` clause. Lucene rejects a query
 * with unbalanced parentheses, and we wrap the raw text in parens — so if the
 * user's text has its own unbalanced parens, strip ALL of them (their grouping
 * intent is ambiguous anyway). Balanced parens are left intact (L6).
 */
function sanitizeFreeText(text) {
  const s = String(text).trim();
  let depth = 0;
  let balanced = true;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) {
        balanced = false;
        break;
      }
    }
  }
  if (depth !== 0) balanced = false;
  return balanced ? s : s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Last day of a month (1-based), accounting for leap years. */
function lastDayOfMonth(year, month) {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalize a year-range bound to a full ISO date (#11). Accepts:
 *   YYYY         → 'from' = YYYY-01-01, 'to' = YYYY-12-31
 *   YYYY-M[M]    → first/last day of that month (single-digit month padded)
 *   YYYY-M[M]-D[D] → zero-padded to YYYY-MM-DD (single-digit day padded too, L1)
 *   *            → the wildcard, passed through
 * Anything else (junk, bogus month/day) returns `null` so the caller DROPS the
 * bound to a wildcard instead of emitting an invalid Lucene range (L1).
 *
 * @param {string} raw the user/UI value
 * @param {'from'|'to'} which which end of the range this is
 * @returns {string|null} a full ISO date / '*' , or null when unparseable
 */
function normalizeDateBound(raw, which) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '*') return '*';
  let m;
  if ((m = /^(\d{4})$/.exec(s))) {
    return which === 'to' ? `${m[1]}-12-31` : `${m[1]}-01-01`;
  }
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null; // bogus month → drop the bound
    const mm = String(month).padStart(2, '0');
    const day = which === 'to' ? lastDayOfMonth(year, month) : 1;
    return `${m[1]}-${mm}-${String(day).padStart(2, '0')}`;
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth(year, month)) return null;
    return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null; // unparseable junk → drop the bound
}

/** Build a `field:(...)` clause, OR-joining array values. */
function fieldClause(field, value) {
  if (Array.isArray(value)) {
    const parts = value.filter((v) => !isBlank(v)).map(escapeFieldValue);
    if (!parts.length) return null;
    return `${field}:(${parts.join(' OR ')})`;
  }
  if (isBlank(value)) return null;
  return `${field}:(${escapeFieldValue(value)})`;
}

/**
 * Compose an archive.org query from structured inputs.
 *
 * @param {object} f
 *  - text        free-text (bare clause)
 *  - title, subject, creator, language   field clauses
 *  - mediatype   string or array (OR-joined)
 *  - dateFrom, dateTo   ISO dates for a date:[from TO to] range
 * @returns {string} a query string (or "*:*" when empty)
 */
function buildAdvancedQuery(f = {}) {
  const clauses = [];

  if (!isBlank(f.text)) {
    const safe = sanitizeFreeText(f.text);
    if (safe) clauses.push(`(${safe})`);
  }

  // NOTE: `collection` and `identifier` MUST be here — omitting collection made a
  // "Collection:" search collapse to *:* and return the entire archive (~123M).
  for (const field of ['title', 'subject', 'creator', 'language', 'collection', 'identifier']) {
    if (field === 'subject') {
      // Subjects ACCUMULATE with AND — each chosen subject is its own clause so
      // items must match ALL of them (faceted narrowing), NOT a single OR clause.
      const subjects = f.subject == null ? [] : Array.isArray(f.subject) ? f.subject : [f.subject];
      for (const s of subjects) {
        const c = fieldClause('subject', s);
        if (c) clauses.push(c);
      }
      continue;
    }
    const c = fieldClause(field, f[field]);
    if (c) clauses.push(c);
  }

  const mt = fieldClause('mediatype', f.mediatype);
  if (mt) clauses.push(mt);

  if (!isBlank(f.dateFrom) || !isBlank(f.dateTo)) {
    // Expand bare years / YYYY-MM months to full ISO bounds (#11). A bound that
    // doesn't parse (junk / bogus month) drops to the '*' wildcard (L1).
    const from = isBlank(f.dateFrom) ? '*' : normalizeDateBound(f.dateFrom, 'from') || '*';
    const to = isBlank(f.dateTo) ? '*' : normalizeDateBound(f.dateTo, 'to') || '*';
    // Only emit a date clause if at least one bound is real (not '* TO *').
    if (!(from === '*' && to === '*')) clauses.push(`date:[${from} TO ${to}]`);
  }

  return clauses.length ? clauses.join(' AND ') : '*:*';
}

// Field keywords recognized in the basic search box (#13).
const SEARCH_FIELDS = ['title', 'subject', 'creator', 'language', 'mediatype', 'date', 'collection', 'identifier'];

/**
 * Parse a basic-search string with optional `field:value` keywords into a
 * structured `{ fields }` object (#13). Known `field:` tokens become fields;
 * everything else becomes the free-text `text` field. Quoted values keep their
 * spaces. Unknown `foo:` tokens are left in the free text.
 *
 * @returns {{fields: Object}}
 */
function parseSearchInput(input) {
  const s = String(input || '').trim();
  const fields = {};
  if (!s) return { fields };

  const freeText = [];
  // Match `field:"quoted value"` or `field:bareword`, else a bare token.
  const re = /(\w+):("([^"]*)"|\S+)|("[^"]*"|\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) {
      const name = m[1].toLowerCase();
      const value = (m[3] != null ? m[3] : m[2]).replace(/^"|"$/g, '');
      if (SEARCH_FIELDS.includes(name)) {
        fields[name] = value;
        continue;
      }
      // Unknown field — keep the original token as free text.
      freeText.push(m[0]);
    } else if (m[4]) {
      freeText.push(m[4].replace(/^"|"$/g, ''));
    }
  }
  const text = freeText.join(' ').trim();
  if (text) fields.text = text;
  return { fields };
}

module.exports = { buildAdvancedQuery, escapeFieldValue, parseSearchInput, normalizeDateBound, SEARCH_FIELDS };
