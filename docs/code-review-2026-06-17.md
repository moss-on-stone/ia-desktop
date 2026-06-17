# IA Desktop — Code Review #2 (2026-06-17, v0.1.28)

> **STATUS: ALL findings fixed (v0.1.29), red/green TDD, 593 tests + selftest green.**
> H1 quote field-value specials; H2 all-blank arrays empty; H3+M2+M4 back-stack
> reset on clear + flag-reset at top of runSearch + de-dup vs candidate; H4
> topbar wrap + #who ellipsis; M1 applySearch uses descriptor verbatim; M3 facet
> blank-value guard; M5 generic fallback notice; M6 seg active border-left-color;
> M7 ⤓→↓; M8 captured collection count; L1 date junk/day-pad; L2 density thumb
> flex-basis; L3 download/upload timer+listener cleanup; L6 boot refreshAuth catch;
> L7 CSS dup removed.


Read-only review of the changes since the v0.1.21 review (collection-search fix,
back button, multi-subject facets, filter chips, skip/re-download, two-format
downloads, zoom buttons, empty-search, ad-hoc signing, responsive toolbar).
Four parallel reviewers (feature logic, renderer state, CSS/responsive,
security/IPC). Findings verified against the actual code. Ranked by severity.

**Overall:** the security/robustness posture remains strong — reviewers
confirmed no double-settle in the rewritten `downloadFile`, no auth leak on
redirect, bounded zoom, bounded retry, an injection-safe signing hook, and
containment-checked download paths. The real issues are **correctness bugs in
the new search/facet code** and **back-stack state that isn't reset on clear**.

---

## HIGH

### H1. Unbalanced parens in a field value break the query
`src/main/ia-query.js` — `escapeFieldValue` only quotes values containing
whitespace, so a paren with no space passes through raw and unbalances the
`field:(...)` wrapper. Verified: `buildAdvancedQuery({creator:'name)'})` →
`creator:(name))` (archive.org rejects → search fails). Reachable from the
advanced-search form (user types a stray paren) and from titles/creators.
**Fix:** quote whenever the value contains any Lucene special char
(`/[\s()[\]{}":]/`), not just whitespace.

### H2. `isEmptySearch` false-negative on `subject: ['']` → whole-archive `*:*`
`src/shared/search-store.js` (isEmptySearch) vs `src/main/ia-query.js`. An array
with a blank string counts as "non-empty" in `isEmptySearch` but
`buildAdvancedQuery` strips blanks → `*:*`. Verified:
`isEmptySearch({fields:{subject:['']}})` = false, `buildAdvancedQuery` = `*:*`.
This bypasses the guard that exists specifically to stop the 123M-item fetch.
**Fix:** treat an array as blank when *every* element is blank.

### H3. `clearSearchView()` doesn't reset the back-stack → stale Back button + history across clears
`src/renderer/renderer.js`. After removing all filters, `clearSearchView()`
resets `activeSearch`/`currentSearchSig` but NOT `lastRunSearch`,
`searchHistory`, or the Back button. Result: the Back arrow stays visible on the
empty "get started" view and jumps to pre-clear searches; the next search can
wrongly push a stale entry. **Fix:** in `clearSearchView()` add
`lastRunSearch = null; searchHistory = []; navigatingBack = false; updateBackButton();`.

### H4. Topbar overflows at narrow widths (no wrap, no username ellipsis)
`src/renderer/styles.css` — `.topbar`/`.tabs` have no `flex-wrap` and `#who` has
no `max-width`/ellipsis. Below ~720px the six tabs + zoom + username + Sign-out
can't fit; the right cluster gets pushed off-screen (a long IA username makes it
worse). This is the most likely real-world small-window breakage (matches the
user's screenshot report). **Fix:** allow the topbar to wrap (or make `.tabs`
wrap with `min-width:0`) and give `#who` `max-width` + ellipsis.

---

## MEDIUM

### M1. `applySearch()` drops `mediatype` on Back/restore when the value has no matching `.adv-mt` checkbox
`renderer.js`. `applySearch` re-derives `mediatype` from the checkboxes via
`collectAdvFields()`; a facet-derived mediatype value with no checkbox is lost on
Back/saved/recent restore. **Fix:** preserve whole-array fields (`mediatype`)
from the descriptor when no checkbox matched.

### M2. `navigatingBack` can stick `true` → next search silently not pushed to history
`renderer.js`. `navigatingBack = false` is set mid-`runSearch`, *after* the
`isEmptySearch`/`!activeSearch` early-returns. Restoring an empty search via Back
returns early with the flag still true, so the next new search's history push is
skipped. **Fix:** reset `navigatingBack` at the top of `runSearch` (before the
early returns).

### M3. `applyFacetToSearch` doesn't guard an empty value
`src/shared/facets.js`. `value === ''` produces `subject:['']` (feeds H2) and,
for `year`, `dateFrom:'-01-01'`/`dateTo:'-12-31'` → `date:[-01-01 TO -12-31]`
(verified, invalid range). Current facet callers filter empties, so it's mostly
latent, but the function is pure/exported and unguarded. **Fix:** early-return
the unchanged search when the value is blank.

### M4. Back-stack de-dup compares the wrong signature
`renderer.js` push guard uses `topSig !== currentSearchSig` (the *replaced*
search) instead of `topSig !== searchSignature(lastRunSearch)` (the *candidate*),
so the stack can accumulate longer than necessary. **Fix:** compare against the
candidate being pushed.

### M5. Multi-item fallback notice misreports the format
`src/main/ipc-handlers.js`. When several items fall back to *different* formats,
the notice uses `fallbacks[0].usedFormat` for all ("2 items had no PDF —
downloading searchable text PDF instead") even if item B actually got Largest.
Cosmetic (downloads are correct). **Fix:** generic phrasing when formats vary.

### M6. Segmented control: 1px dark seam when "List" (2nd button) is active
`styles.css`. `.seg-btn + .seg-btn { border-left: 1px solid var(--border) }`
draws a dark hairline on top of the active blue fill when the right button is
active (asymmetric — left-active looks clean). This is the "ugly List" the user
reported. **Fix:** `.seg-btn.active { border-left-color: var(--accent) }` (or
transparent).

### M7. `⤓` (U+2913) "Download collection" glyph risks tofu on Windows
`index.html`. U+2913 isn't in Segoe UI's core coverage. **Fix:** use a covered
glyph (e.g. `↓`). Other glyphs (‹ › − ★ ↑ ↓ ✕ ✓ ⋮⋮ ▾) are Segoe-safe.

### M8. `numFound` confirm-count race for the collection download
`renderer.js`. The >50 confirm reads module-level `numFound`; if Download
Collection is clicked in the narrow window after `activeSearch` became a
`collection:` search but before its `runSearch` resolved, the count is stale.
Narrow race; affects only the confirm threshold/number, not the actual download.

---

## LOW / informational

- **L1.** `normalizeDateBound` passes malformed partial dates (`1940-3-5`,
  `1940-13`) through verbatim → invalid range. Single-digit *months* are padded
  but single-digit *days* aren't; reversed ranges (from>to) aren't validated.
- **L2.** Grid density variants set `.thumb { height }` but not `flex-basis`, so
  with `flex: 0 0 150px` still in effect the compact/comfortable grid thumb
  heights may not actually change. (`styles.css`)
- **L3.** `downloadFile`'s idle `req.setTimeout` isn't cleared on success
  (lingering socket up to 60s; inert because the keep-alive agent is off and a
  late reject is a promise no-op). `uploadFile`'s `once:true` abort listener
  isn't removed on success (inert — fresh controller per job).
- **L4.** `bulk:upload` trusts renderer-supplied absolute `f.path` (re-validates
  identifier but not path). By-design within the user's own account (they chose
  the CSV, upload goes to their own creds) — defense-in-depth only.
- **L5.** `boundedSaveAs` truncation could (rarely, Windows-only) collide two
  long names after `disambiguate` already ran → overwrite. Edge case.
- **L6.** `#sort-key`/`#search-sort` use `min-width: max-content` → non-shrinkable
  in the wrapping search bar (forces earlier wrap; no clip). `.facets`
  `max-height: calc(100vh - 150px)` is a magic number that's slightly off when
  the header wraps. Bare `refreshAuth()` at boot has no `.catch`.
- **L7.** Minor CSS tidiness: duplicate `.card { position: relative }`, duplicate
  `.facets {}` blocks, dead `34px` left-pad shorthand under `.results.compact`,
  no `[data-density='cozy']` selector (falls through — intentional).

---

## Confirmed GOOD (explicitly checked)

- Rewritten `downloadFile`: **single-settle** on every path (success, HTTP error,
  dropped/stalled connection, abort, redirect); idle timeout fires on real
  stalls and resets on steady data; settle is fd-close-gated (Windows lock-safe).
- **No auth leak on redirect** — download sends no Authorization; upload/request
  don't follow cross-host authenticated redirects.
- `view:zoom` is bounded (`nextZoomLevel` clamps; NaN→0); no FS/network.
- verify→force-redownload runs **at most once** (no infinite loop); `done` is not
  double-counted. Inter-item delay fires exactly once between items.
- `adhoc-sign.js`: **injection-safe** (`execFileSync` argv, not shell), skips a
  real CSC identity, fails the build loudly on error.
- Path safety: `sanitizeSegment` (reserved names + trailing dots), `sanitizeRel`
  (every interior segment), `boundedSaveAs` (MAX_PATH), `containWithin`
  (case-fold on win32, drive-root-safe) — every destPath containment-checked.
- No new `innerHTML`-with-untrusted-data; openExternal/openPath allow-lists
  intact; no orphaned IPC handlers (only `settings:defaults` is preload-unbound,
  used menu-side).

---

## Suggested fix order
1. **H1 + H2** — the two user-reachable search bugs (paren breaks search;
   `['']` → whole archive).
2. **H3 + M2 + M4** — back-stack/clear state (one coherent fix to
   `clearSearchView` + `runSearch` flag reset + de-dup comparison).
3. **H4 + M6 + M7** — small-window topbar wrap, seg-control seam, Windows glyph.
4. **M1** (mediatype on restore), **M3** (facet empty-value guard), **M5**
   (fallback notice), then L-items as polish.
