'use strict';

/**
 * search-store.js (shared, pure)
 *
 * List operations for saved searches & recent-search history (#6). No storage,
 * no DOM — the renderer persists the resulting arrays via settings, and uses
 * these helpers to keep them tidy (de-duped, capped, most-recent-first).
 *
 * Loaded as CommonJS (tests/main) and as a plain <script> (window.searchStore).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.searchStore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  /**
   * A stable signature for a search descriptor, used to de-dupe history.
   * Basic: type + query text. Advanced: type + sorted field entries.
   */
  function searchSignature(search) {
    if (!search || typeof search !== 'object') return '';
    if (search.type === 'advanced') {
      const fields = search.fields || {};
      const parts = Object.keys(fields)
        .sort()
        .map((k) => `${k}=${JSON.stringify(fields[k])}`);
      return `advanced|${parts.join('&')}`;
    }
    return `basic|${search.q == null ? '' : String(search.q)}`;
  }

  function isBlankValue(v) {
    if (v == null) return true;
    // An array is blank when EVERY element is blank — `['']` must count as empty
    // (H2), since buildAdvancedQuery strips blank entries and would yield *:*.
    if (Array.isArray(v)) return v.every(isBlankValue);
    return String(v).trim() === '';
  }

  /** Human-readable one-line label for a search descriptor (for dropdowns). */
  function searchLabel(search) {
    if (!search || typeof search !== 'object') return '';
    if (search.type === 'advanced') {
      const fields = search.fields || {};
      const parts = Object.keys(fields)
        .filter((k) => !isBlankValue(fields[k]))
        .map((k) => `${k}: ${Array.isArray(fields[k]) ? fields[k].join(', ') : fields[k]}`);
      return parts.length ? parts.join(', ') : '(all items)';
    }
    const q = search.q == null ? '' : String(search.q).trim();
    return q || '(empty)';
  }

  /**
   * Prepend `entry` to the recent list, removing any prior entry with the same
   * signature, and cap the result to `cap` items. Non-mutating.
   */
  function addRecent(list, entry, cap = 20) {
    const sig = searchSignature(entry);
    const filtered = (list || []).filter((e) => searchSignature(e) !== sig);
    return [entry, ...filtered].slice(0, Math.max(0, cap));
  }

  /** Add or replace a named saved search (unique by name). Non-mutating. */
  function addSaved(list, entry) {
    const without = (list || []).filter((e) => e.name !== entry.name);
    return [...without, entry];
  }

  /** Remove a saved search by name. Non-mutating. */
  function removeSaved(list, name) {
    return (list || []).filter((e) => e.name !== name);
  }

  /** Rename a saved search; no-op if `oldName` is absent. Non-mutating. */
  function renameSaved(list, oldName, newName) {
    return (list || []).map((e) => (e.name === oldName ? { ...e, name: newName } : e));
  }

  /**
   * The single collection id a search targets, or '' when it isn't a
   * single-collection search. Used to show the "Download collection" button
   * (which makes sense only when EXACTLY one whole collection is the search).
   * Handles a basic `collection:foo` query and an advanced search whose only
   * field is `collection`.
   */
  function collectionIdForSearch(search) {
    if (!search || typeof search !== 'object') return '';
    if (search.type === 'basic') {
      const m = /^\s*collection:\s*("([^"]+)"|(\S+))\s*$/i.exec(search.q || '');
      return m ? (m[2] || m[3] || '').trim() : '';
    }
    const f = search.fields || {};
    const raw = Array.isArray(f.collection) ? (f.collection.length === 1 ? f.collection[0] : '') : f.collection;
    const col = String(raw == null ? '' : raw).trim();
    if (!col) return '';
    // Collection must be the SOLE filter — any other non-blank field scopes it.
    const others = Object.keys(f).filter((k) => k !== 'collection' && !isBlankValue(f[k]));
    return others.length ? '' : col;
  }

  /**
   * Whether a search has no meaningful terms. An empty advanced search builds
   * `*:*` (the entire archive), so the UI uses this to clear the results instead
   * of running it.
   */
  function isEmptySearch(search) {
    if (!search || typeof search !== 'object') return true;
    if (search.type === 'advanced') {
      const f = search.fields || {};
      return !Object.values(f).some((v) => !isBlankValue(v));
    }
    return isBlankValue(search.q);
  }

  return { searchSignature, searchLabel, addRecent, addSaved, removeSaved, renameSaved, collectionIdForSearch, isEmptySearch };
});
