'use strict';

/* global uiUtil viewPrefs pager sortDocsApi searchStore facets itemView favoritesApi uploadTemplates selectionUtil */

/**
 * renderer.js — the UI controller.
 *
 * Talks only to `window.ia` (the preload bridge), `window.uiUtil`, and
 * `window.viewPrefs` (pure helpers). No Node, no direct network access.
 */

const {
  formatBytes,
  percent,
  buildUploadMetadata,
  validIdentifier,
  firstOf,
  escapeHtml,
  toDownloadItems,
  makeJobIdFactory,
  descriptionText,
  downloadDoneSummary,
} = uiUtil;
const { thumbnailUrl, toSubjectList, shouldShowThumbs } = viewPrefs;

const $ = (sel) => document.querySelector(sel);
// Boolean attributes must be set as PROPERTIES, not attributes — setAttribute
// makes the attribute *present* regardless of value (so checked:false would
// still check the box). These get node[k] = Boolean(v) instead.
const BOOL_PROPS = new Set(['checked', 'disabled', 'selected', 'hidden', 'readOnly', 'multiple']);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (BOOL_PROPS.has(k)) node[k] = Boolean(v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

// Per-session jobId generator. The random prefix means a renderer reload (which
// re-runs this file and resets the counter) can't collide with an in-flight
// job's id from before the reload (H5).
const nextJobId = makeJobIdFactory();

/* ------------------------------- toast ----------------------------------- */
let toastTimer;
function toast(message, kind = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ------------------------------- prompt ---------------------------------- */
// Electron disables window.prompt, so we provide a small modal that resolves to
// the entered string (or null on cancel).
function promptText(label, initial = '') {
  return new Promise((resolve) => {
    const modal = $('#prompt-modal');
    const input = $('#prompt-input');
    $('#prompt-label').textContent = label;
    input.value = initial;
    modal.hidden = false;
    input.focus();
    input.select();

    const cleanup = () => {
      modal.hidden = true;
      $('#prompt-ok').onclick = null;
      $('#prompt-cancel').onclick = null;
      input.onkeydown = null;
    };
    const ok = () => {
      const v = input.value.trim();
      cleanup();
      resolve(v || null);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    $('#prompt-ok').onclick = ok;
    $('#prompt-cancel').onclick = cancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok();
      else if (e.key === 'Escape') cancel();
    };
  });
}

// A yes/no confirmation modal (Electron disables window.confirm). Resolves true
// on OK, false on Cancel/Escape.
function confirmDialog(message, okLabel = 'Download') {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-message').textContent = message;
    $('#confirm-ok').textContent = okLabel;
    modal.hidden = false;
    $('#confirm-ok').focus();

    const cleanup = () => {
      modal.hidden = true;
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      modal.onkeydown = null;
    };
    $('#confirm-ok').onclick = () => {
      cleanup();
      resolve(true);
    };
    $('#confirm-cancel').onclick = () => {
      cleanup();
      resolve(false);
    };
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(false);
      }
    };
  });
}

/* ------------------------------- auth ------------------------------------ */
let loggedIn = false;
// The logged-in account ({screenname, email}) — used to gate owner-only item
// actions (Edit metadata / Tasks) against an item's uploader (#12).
let account = null;
async function refreshAuth() {
  const s = await window.ia.auth.status();
  loggedIn = !!s.loggedIn;
  account = s.loggedIn ? { screenname: s.screenname, email: s.email } : null;
  if (s.loggedIn) {
    $('#login-view').hidden = true;
    $('#app').hidden = false;
    // Clicking the username opens the account's archive.org profile page.
    const who = $('#who');
    who.textContent = s.screenname || s.email || '';
    const profileUrl = uiUtil.userProfileUrl(s.screenname);
    who.classList.toggle('who-link', !!profileUrl);
    who.title = profileUrl ? 'Open your archive.org profile' : '';
    who.onclick = profileUrl
      ? () => window.ia.shell.openExternal(profileUrl).catch((e) => toast(e.message, 'err'))
      : null;
    await initSettings();
  } else {
    $('#login-view').hidden = false;
    $('#app').hidden = true;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in…';
  try {
    await window.ia.auth.login($('#login-email').value.trim(), $('#login-password').value);
    $('#login-password').value = '';
    await refreshAuth();
  } catch (ex) {
    err.textContent = ex.message || 'Login failed.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await window.ia.auth.logout();
  await refreshAuth();
});

// Banner zoom buttons — same effect as the View menu's Zoom In/Out.
$('#zoom-in').addEventListener('click', () => window.ia.view.zoom(+1).catch(() => {}));
$('#zoom-out').addEventListener('click', () => window.ia.view.zoom(-1).catch(() => {}));

/* ------------------------------- tabs ------------------------------------ */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/* ------------------------------- search ---------------------------------- */
let currentPage = 1;
let numFound = 0;
// #8: results per page (200 default; 50/100 also selectable). Read at search time.
const PER_PAGE_OPTIONS = viewPrefs.PER_PAGE_OPTIONS;
let ROWS = viewPrefs.DEFAULT_PREFS.perPage;

// The active search: { type:'basic', q } or { type:'advanced', fields }.
let activeSearch = null;

async function basicSearch(page = 1) {
  const q = $('#search-input').value.trim();
  if (!q) return;
  // #13: parse `field:value` keywords (title:, subject:, …). If any are present,
  // run a structured search; otherwise a plain basic search.
  let parsed;
  try {
    parsed = await window.ia.search.parseInput(q);
  } catch {
    parsed = { fields: { text: q } };
  }
  const fields = parsed.fields || {};
  const keys = Object.keys(fields);
  const hasMeta = keys.some((k) => k !== 'text');
  // #12: merge the always-visible date range into the search.
  const dateFields = collectQuickDates();
  if (hasMeta || dateFields.dateFrom || dateFields.dateTo) {
    activeSearch = { type: 'advanced', fields: { ...fields, ...dateFields } };
  } else {
    activeSearch = { type: 'basic', q };
  }
  runSearch(page);
}

/** #12: read the always-visible from/to year inputs into a {dateFrom,dateTo}. */
function collectQuickDates() {
  const from = $('#quick-date-from') ? $('#quick-date-from').value.trim() : '';
  const to = $('#quick-date-to') ? $('#quick-date-to').value.trim() : '';
  const out = {};
  if (from) out.dateFrom = from;
  if (to) out.dateTo = to;
  return out;
}

function advancedSearch(page = 1) {
  activeSearch = { type: 'advanced', fields: collectAdvFields() };
  runSearch(page);
}

let currentSearchSig = null; // signature of the active query (selection scope)

// Back-stack of previous search descriptors. A NEW distinct search pushes the
// one it replaces; the Back button pops and re-runs it.
let searchHistory = [];
let lastRunSearch = null; // the search descriptor most recently run
let navigatingBack = false; // suppress the push while popping

/** Show/hide and enable the Back button from the history depth. */
function updateBackButton() {
  const btn = $('#search-back');
  if (btn) btn.hidden = searchHistory.length === 0;
}

/** Go to the previous search view (#back button). */
function goBackSearch() {
  if (!searchHistory.length) return;
  const prev = searchHistory.pop();
  navigatingBack = true;
  applySearch(prev); // restores form fields + sets activeSearch + runs
  updateBackButton();
}

/** Clear the results view back to the initial empty state (no query running). */
function clearSearchView() {
  activeSearch = null;
  currentSearchSig = null;
  lastDocs = [];
  filteredDocs = [];
  numFound = 0;
  selected.clear();
  // A clear is a true reset point — drop the back-stack so the Back button can't
  // jump to pre-clear searches, and don't let a stale lastRunSearch be pushed (H3).
  searchHistory = [];
  lastRunSearch = null;
  navigatingBack = false;
  $('#results').innerHTML = '';
  $('#results-meta').textContent = '';
  $('#active-facets').innerHTML = '';
  $('#facets').hidden = true;
  $('#pager').hidden = true;
  $('#select-bar').hidden = true;
  $('#search-empty').hidden = false;
  $('#select-count').hidden = true;
  updateBackButton();
}

async function runSearch(page = 1) {
  // M2: clear the "navigating back" flag up front so an early return below can't
  // leave it stuck true (which would drop the next search's history push).
  const wasNavigatingBack = navigatingBack;
  navigatingBack = false;
  if (!activeSearch) return;
  // When every filter has been removed, treat it as a cleared search and show an
  // empty view — never run *:* (which would return the entire 123M-item archive).
  if (searchStore.isEmptySearch(activeSearch)) {
    clearSearchView();
    return;
  }
  // #9: selection persists across PAGES of the same query, but a NEW query
  // (different signature) starts fresh.
  const sig = searchStore.searchSignature(activeSearch);
  if (sig !== currentSearchSig) {
    selected.clear();
    // Back-stack: a new distinct search pushes the one it's replacing — unless we
    // got here by pressing Back, or the candidate already sits on top of the
    // stack (M4: de-dup against the CANDIDATE, not the replaced search).
    if (!wasNavigatingBack && lastRunSearch) {
      const candidateSig = searchStore.searchSignature(lastRunSearch);
      const topSig = searchHistory.length ? searchStore.searchSignature(searchHistory[searchHistory.length - 1]) : null;
      if (candidateSig !== sig && candidateSig !== topSig) {
        searchHistory.push(lastRunSearch);
      }
    }
    currentSearchSig = sig;
    updateBackButton();
  }
  lastRunSearch = activeSearch;
  currentPage = page;
  // #10: the live title filter applies to the current page only — reset on a new fetch.
  filterQuery = '';
  if ($('#results-filter')) $('#results-filter').value = '';
  const sort = $('#search-sort').value;
  $('#search-empty').hidden = true;
  $('#results-meta').innerHTML = '<span class="spinner"></span> Searching…';
  $('#results').innerHTML = '';
  $('#pager').hidden = true;
  $('#select-bar').hidden = true;
  try {
    let res;
    if (activeSearch.type === 'advanced') {
      res = await window.ia.search.advanced(activeSearch.fields, { page, rows: ROWS, sort });
    } else {
      res = await window.ia.search.query(activeSearch.q, { page, rows: ROWS, sort });
    }
    numFound = res.numFound;
    renderResults(res.docs);
    renderActiveFacets(); // #8
    updateCollectionDownloadButton(); // #15
    // #6: record a successful new search (not pagination) into history.
    if (page === 1) recordSearch(activeSearch);
    const from = (page - 1) * ROWS + 1;
    const to = Math.min(page * ROWS, numFound);
    $('#results-meta').textContent = numFound
      ? `${numFound.toLocaleString()} results — showing ${from}–${to}`
      : 'No results.';
    // M6: cap the pager at advancedsearch.php's ~10k deep-paging window so we
    // never offer a page that the API will reject with an error/empty result.
    const info = pager.pagerInfo(numFound, ROWS, page);
    if (info.totalPages > 1) {
      $('#pager').hidden = false;
      const label = `Page ${page} of ${info.totalPages.toLocaleString()}`;
      $('#page-label').textContent = info.capped ? `${label} — refine your search to see more` : label;
      $('#prev-page').disabled = !info.hasPrev;
      $('#next-page').disabled = !info.hasNext;
    }
  } catch (ex) {
    $('#results-meta').textContent = '';
    // eslint-disable-next-line no-console
    toast(ex.message || 'Search failed.', 'err');
  }
}

// Map of identifier -> { identifier, title } for selected results. Persists
// ACROSS pages (#9) — never cleared on re-render; only on a new search.
const selected = new Map();
let lastDocs = []; // cached results so view toggles re-render without re-fetching
let filteredDocs = []; // docs actually rendered (after the live title filter)
let lastClickedIndex = -1; // anchor for shift-click range selection (#3)
let filterQuery = ''; // #10: live title filter for the current page
// Compact-list client-side sort state. Empty key = original page order.
let sortState = { key: '', dir: 'asc' };

function renderResults(docs) {
  lastDocs = docs || [];
  const grid = $('#results');
  grid.innerHTML = '';
  grid.classList.toggle('compact', prefs.viewMode === 'compact');
  // Show the sort control only in compact view; apply the active sort.
  $('#list-sort').hidden = prefs.viewMode !== 'compact';
  let docsToRender =
    prefs.viewMode === 'compact' && sortState.key
      ? sortDocsApi.sortDocs(lastDocs, sortState.key, sortState.dir)
      : lastDocs.slice();
  // #10: live title filter of the current page.
  if (filterQuery.trim()) docsToRender = docsToRender.filter((d) => selectionUtil.titleMatches(d, filterQuery));
  filteredDocs = docsToRender;
  lastClickedIndex = -1;
  updateSelectionUI();
  syncSelectAll();
  $('#select-bar').hidden = lastDocs.length === 0;

  const showThumbs = shouldShowThumbs(prefs.viewMode);

  docsToRender.forEach((d, index) => {
    const id = d.identifier;
    const title = firstOf(d.title) || id;
    const creator = firstOf(d.creator);
    const date = (firstOf(d.date) || '').slice(0, 10);
    const mt = firstOf(d.mediatype);
    const subjects = prefs.showSubjects ? toSubjectList(d.subject, 8) : [];

    const checkbox = el('input', {
      type: 'checkbox',
      class: 'pick-box',
      title: 'Select (shift-click for a range)',
      checked: selected.has(id), // #9: restore prior-page selection state
      // Use 'click' so we can read shiftKey for range selection (#3).
      onclick: (e) => onPickClick(e, index, id, title, card),
    });

    // Thumbnail only in grid view, and using <img> so failures can be hidden.
    let thumb = null;
    if (showThumbs) {
      thumb = el('div', { class: 'thumb' });
      const img = el('img', {
        src: thumbnailUrl(id),
        alt: '',
        class: 'thumb-img',
        loading: 'lazy',
        // If the image fails (item has no usable thumbnail), remove it so we
        // don't show a broken-image box — leaving the plain placeholder.
        onerror: () => thumb.remove(),
      });
      thumb.appendChild(img);
    }

    // #18: a clickable creator runs a creator search in-app. The date stays plain.
    const subChildren = [];
    if (creator && prefs.showCreator) {
      subChildren.push(
        el('span', {
          class: 'sub-creator',
          text: creator,
          title: `Search for more by ${creator}`,
          onclick: (e) => {
            e.stopPropagation();
            runRelatedSearch({ type: 'advanced', fields: { creator } });
          },
        })
      );
    }
    if (date) {
      if (subChildren.length) subChildren.push(document.createTextNode(' · '));
      subChildren.push(el('span', { class: 'sub-date', text: date }));
    }

    const bodyChildren = [
      mt && prefs.showType ? el('span', { class: 'mt', text: mt }) : null, // #10
      el('div', { class: 'title', text: title, title: title }), // #9: full-title tooltip
      subChildren.length ? el('div', { class: 'sub' }, subChildren) : null,
    ];
    if (subjects.length) {
      // #17: clickable subject tags run a subject search in-app.
      bodyChildren.push(
        el('div', { class: 'subjects' }, subjects.map((s) =>
          el('span', {
            class: 'tag tag-link',
            text: s,
            title: `Search subject: ${s}`,
            onclick: (e) => {
              e.stopPropagation();
              runRelatedSearch({ type: 'advanced', fields: { subject: s } });
            },
          })
        ))
      );
    }

    const card = el('div', { class: 'card' }, [
      checkbox,
      thumb,
      el('div', { class: 'body' }, bodyChildren),
      el('div', { class: 'actions' }, [
        favStar({ identifier: id, title, mediatype: mt }), // #13 — inline, no overlap
        el('button', { class: 'ghost', text: 'Details', onclick: () => openItem(id) }),
        el('button', { text: 'Download', onclick: () => quickDownload(id, title, mt) }),
      ]),
    ]);
    // #19: right-click offers Copy Title / Copy Creator.
    card.addEventListener('contextmenu', (e) => showHitContextMenu(e, { title, creator }));
    if (selected.has(id)) card.classList.add('selected'); // #9: reflect restored selection
    grid.appendChild(card);
  });
  renderFacets(); // #8
}

/* ------------------------------ facets (#8) ------------------------------ */
function renderFacets() {
  const aside = $('#facets');
  aside.innerHTML = '';
  if (!lastDocs.length) {
    aside.hidden = true;
    return;
  }
  const computed = facets.computeFacets(lastDocs, facets.FACET_FIELDS);
  const labels = { mediatype: 'Media type', year: 'Year', subject: 'Subject', language: 'Language', collection: 'Collection' };
  // #5: subjects get a 30-deep list with a More button; other facets cap at 8.
  const initialCap = { subject: 30 };
  let any = false;
  for (const field of facets.FACET_FIELDS) {
    const all = computed[field] || [];
    if (all.length < 2) continue; // a single value isn't a useful facet
    any = true;
    aside.appendChild(el('h4', { class: 'facet-h', text: labels[field] || field }));
    const cap = facetExpanded.has(field) ? all.length : (initialCap[field] || 8);
    const shown = all.slice(0, cap);
    for (const b of shown) {
      aside.appendChild(
        el('button', {
          class: 'facet-item',
          title: `Filter by ${field}: ${b.value}`,
          onclick: () => applyFacet(field, b.value),
        }, [el('span', { class: 'facet-val', text: b.value }), el('span', { class: 'facet-count', text: String(b.count) })])
      );
    }
    if (all.length > shown.length || facetExpanded.has(field)) {
      const expanded = facetExpanded.has(field);
      aside.appendChild(
        el('button', {
          class: 'facet-more',
          text: expanded ? 'Show fewer' : `More (${all.length - shown.length})…`,
          onclick: () => {
            if (expanded) facetExpanded.delete(field);
            else facetExpanded.add(field);
            renderFacets();
          },
        })
      );
    }
  }
  aside.hidden = !any;
}
// Which facet sections are expanded to their full list (#5).
const facetExpanded = new Set();

function applyFacet(field, value) {
  if (!activeSearch) return;
  activeSearch = facets.applyFacetToSearch(activeSearch, field, value);
  runSearch(1);
}

/** Programmatically activate a top-level tab by its data-tab name. */
function activateTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

/**
 * Run an in-app search from a descriptor ({type:'advanced', fields} or
 * {type:'basic', q}). Used by the detail view's "More by…/Collection:" buttons
 * (#13) and the clickable subject/creator chips on result cards (#17/#18). It
 * closes any open item modal, switches to the Search tab, sets it as the active
 * search, and runs it from page 1.
 */
function runRelatedSearch(search) {
  if (!search) return;
  $('#item-modal').hidden = true;
  activateTab('search');
  activeSearch = search;
  if (search.type === 'basic') $('#search-input').value = search.q || '';
  runSearch(1);
}

/**
 * #19: a small right-click menu on a search hit offering Copy Title / Copy
 * Creator. Built as a lightweight DOM popup (Electron disables native context
 * menus from the renderer) that dismisses on the next click/scroll/Escape.
 */
let hitMenuEl = null;
function dismissHitMenu() {
  if (hitMenuEl) {
    hitMenuEl.remove();
    hitMenuEl = null;
  }
}
function showHitContextMenu(e, { title, creator }) {
  e.preventDefault();
  dismissHitMenu();
  const copy = (text, what) => {
    dismissHitMenu();
    if (!text) return toast(`No ${what} to copy.`, 'err');
    navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied.`, 'ok'),
      () => toast(`Couldn't copy ${what}.`, 'err')
    );
  };
  const items = [
    el('button', { class: 'ctx-item', text: 'Copy Title', onclick: () => copy(title, 'Title') }),
    el('button', {
      class: 'ctx-item',
      text: 'Copy Creator',
      disabled: !creator,
      onclick: () => copy(creator, 'Creator'),
    }),
  ];
  hitMenuEl = el('div', { class: 'ctx-menu' }, items);
  hitMenuEl.style.left = `${e.clientX}px`;
  hitMenuEl.style.top = `${e.clientY}px`;
  document.body.appendChild(hitMenuEl);
  // Dismiss on the next interaction anywhere.
  setTimeout(() => {
    window.addEventListener('click', dismissHitMenu, { once: true });
    window.addEventListener('scroll', dismissHitMenu, { once: true, capture: true });
  }, 0);
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissHitMenu();
});

/** Show the active advanced-search fields as removable chips (#8). */
function renderActiveFacets() {
  const wrap = $('#active-facets');
  wrap.innerHTML = '';
  if (!activeSearch || activeSearch.type !== 'advanced') return;
  const fields = activeSearch.fields || {};

  // Build the chip list. Each chip carries the field + its specific value so the
  // body click can search by JUST that term and the × can remove JUST it (a
  // multi-subject filter renders one removable chip per subject).
  const chips = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'dateFrom' || k === 'dateTo') continue; // shown together as one date chip below
    if (Array.isArray(v)) {
      for (const item of v) if (String(item).trim()) chips.push({ field: k, value: item, label: `${k}: ${item}` });
    } else if (String(v || '').trim()) {
      chips.push({ field: k, value: v, label: `${k}: ${v}` });
    }
  }
  // A date range is one chip (searches just the date range when its body clicked).
  if (String(fields.dateFrom || '').trim() || String(fields.dateTo || '').trim()) {
    const from = fields.dateFrom || '*';
    const to = fields.dateTo || '*';
    chips.push({ field: 'date', value: null, label: `date: ${from} → ${to}` });
  }

  for (const chip of chips) {
    // The chip BODY runs a search with only this one term (#).
    const body = el('span', {
      class: 'chip-body',
      text: chip.label,
      title: `Search for only “${chip.label}”`,
      onclick: () => runSingleTermSearch(chip.field, chip.value),
    });
    // The × removes only this term, keeping the rest of the search.
    const close = el('button', {
      class: 'chip-x',
      text: '✕',
      title: `Remove ${chip.field} filter`,
      onclick: (e) => {
        e.stopPropagation();
        removeActiveValue(chip.field, chip.value);
      },
    });
    wrap.appendChild(el('span', { class: 'chip' }, [body, close]));
  }
}

/** Run a search containing ONLY the given field/value (chip-body click). */
function runSingleTermSearch(field, value) {
  if (field === 'date') {
    const f = activeSearch && activeSearch.fields ? activeSearch.fields : {};
    activeSearch = { type: 'advanced', fields: { dateFrom: f.dateFrom, dateTo: f.dateTo } };
  } else {
    activeSearch = { type: 'advanced', fields: { [field]: value } };
  }
  runSearch(1);
}

/** Remove a single value of a filter (× click); other terms stay. */
function removeActiveValue(field, value) {
  if (!activeSearch || activeSearch.type !== 'advanced') return;
  const fields = { ...activeSearch.fields };
  if (field === 'date') {
    delete fields.dateFrom;
    delete fields.dateTo;
  } else if (Array.isArray(fields[field])) {
    const next = fields[field].filter((x) => String(x) !== String(value));
    if (next.length) fields[field] = next;
    else delete fields[field];
  } else {
    delete fields[field];
  }
  activeSearch = { type: 'advanced', fields };
  runSearch(1);
}

/** Re-render the cached results (used when the view mode / subjects toggle). */
function rerenderResults() {
  if (lastDocs.length) renderResults(lastDocs);
}

/** Apply the current viewMode to the toolbar segmented control. */
function syncViewButtons() {
  $('#view-grid').classList.toggle('active', prefs.viewMode === 'grid');
  $('#view-compact').classList.toggle('active', prefs.viewMode === 'compact');
  $('#toggle-subjects').checked = prefs.showSubjects;
}

async function setViewMode(mode) {
  prefs.viewMode = mode;
  await window.ia.settings.update({ viewMode: mode });
  syncViewButtons();
  if ($('#pref-view')) $('#pref-view').value = mode;
  rerenderResults();
}

async function setShowSubjects(on) {
  prefs.showSubjects = on;
  await window.ia.settings.update({ showSubjects: on });
  syncViewButtons();
  if ($('#pref-subjects')) $('#pref-subjects').checked = on;
  rerenderResults();
}

/** #4: apply the list/grid density to the results container via a data attr. */
function applyDensity(density) {
  const d = viewPrefs.DENSITIES.includes(density) ? density : 'cozy';
  prefs.density = d;
  $('#results').dataset.density = d;
}

async function setDensity(density) {
  applyDensity(density);
  await window.ia.settings.update({ density: prefs.density });
}

$('#view-grid').addEventListener('click', () => setViewMode('grid'));
$('#view-compact').addEventListener('click', () => setViewMode('compact'));
$('#toggle-subjects').addEventListener('change', (e) => setShowSubjects(e.target.checked));

// Compact-list sort (#10): re-render the cached page in the chosen order.
$('#sort-key').addEventListener('change', (e) => {
  sortState.key = e.target.value;
  rerenderResults();
});
$('#sort-dir').addEventListener('click', () => {
  const btn = $('#sort-dir');
  sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  btn.dataset.dir = sortState.dir;
  btn.textContent = sortState.dir === 'asc' ? '↑' : '↓';
  if (sortState.key) rerenderResults();
});

function setSelected(id, title, on, card) {
  if (on) selected.set(id, { identifier: id, title });
  else selected.delete(id);
  if (card) card.classList.toggle('selected', on);
}

/**
 * Handle a click on a result checkbox. Plain click toggles one item; SHIFT-click
 * selects (or clears) the contiguous range from the last-clicked checkbox (#3).
 */
function onPickClick(e, index, id, title, card) {
  const on = e.target.checked;
  if (e.shiftKey && lastClickedIndex >= 0 && lastClickedIndex !== index) {
    const cards = [...document.querySelectorAll('#results .card')];
    for (const i of selectionUtil.rangeIndices(lastClickedIndex, index)) {
      const d = filteredDocs[i];
      const c = cards[i];
      if (!d || !c) continue;
      const box = c.querySelector('.pick-box');
      if (box) box.checked = on;
      setSelected(d.identifier, firstOf(d.title) || d.identifier, on, c);
    }
  } else {
    setSelected(id, title, on, card);
  }
  lastClickedIndex = index;
  updateSelectionUI();
  syncSelectAll();
}

function updateSelectionUI() {
  const summary = selectionUtil.selectionSummary(selected.size, filteredDocs.length);
  const countEl = $('#select-count');
  countEl.textContent = summary.label; // "N selected"
  countEl.hidden = selected.size === 0; // shown under the results count only when active
  $('#download-selected').disabled = !summary.canDeselect;
  $('#deselect-all').disabled = !summary.canDeselect;
}

/** Clear the entire selection (across all pages) and reflect it in the UI. */
function deselectAll() {
  selected.clear();
  document.querySelectorAll('#results .pick-box').forEach((b) => (b.checked = false));
  document.querySelectorAll('#results .card.selected').forEach((c) => c.classList.remove('selected'));
  lastClickedIndex = -1;
  updateSelectionUI();
  syncSelectAll();
}
$('#deselect-all').addEventListener('click', deselectAll);

/** Reflect whether every rendered card is selected onto the select-all box. */
function syncSelectAll() {
  const boxes = [...document.querySelectorAll('#results .pick-box')];
  const allOn = boxes.length > 0 && boxes.every((b) => b.checked);
  $('#select-all').checked = allOn;
}

$('#select-all').addEventListener('change', (e) => {
  const on = e.target.checked;
  const cards = [...document.querySelectorAll('#results .card')];
  cards.forEach((card, i) => {
    const box = card.querySelector('.pick-box');
    const d = filteredDocs[i];
    if (!box || !d) return;
    box.checked = on;
    setSelected(d.identifier, firstOf(d.title) || d.identifier, on, card);
  });
  updateSelectionUI();
});

$('#download-selected').addEventListener('click', () => {
  const items = [...selected.values()];
  if (!items.length) return;
  startDownload(items, `${items.length} selected item(s)`);
});

$('#search-btn').addEventListener('click', () => basicSearch(1));
$('#search-back').addEventListener('click', goBackSearch);
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') basicSearch(1);
});
// #12: the always-visible year range also triggers a search on Enter.
['#quick-date-from', '#quick-date-to'].forEach((sel) => {
  const input = $(sel);
  // Keep the field to four digits, numbers only (#: no spinner, no letters).
  input.addEventListener('input', () => {
    const clean = selectionUtil.sanitizeYearInput(input.value);
    if (clean !== input.value) input.value = clean;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') basicSearch(1);
  });
});
$('#search-sort').addEventListener('change', () => activeSearch && runSearch(1));
$('#prev-page').addEventListener('click', () => runSearch(currentPage - 1));
$('#next-page').addEventListener('click', () => runSearch(currentPage + 1));

// #7: jump to an arbitrary page (clamped to the deep-paging window).
function doJumpPage() {
  const totalPages = pager.pagerInfo(numFound, ROWS, currentPage).totalPages;
  const target = selectionUtil.clampJumpPage($('#jump-page').value, totalPages);
  if (target == null) return toast('Enter a page number.', 'err');
  runSearch(target);
}
$('#jump-go').addEventListener('click', doJumpPage);
$('#jump-page').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJumpPage();
});

// #8: results per page — re-run the current query from page 1.
$('#per-page').addEventListener('change', async (e) => {
  ROWS = Number(e.target.value) || viewPrefs.DEFAULT_PREFS.perPage;
  await window.ia.settings.update({ perPage: ROWS });
  if (activeSearch) runSearch(1);
});

// #10: live filter the current page by title (no refetch).
$('#results-filter').addEventListener('input', (e) => {
  filterQuery = e.target.value;
  rerenderResults();
});

/* --------------------------- advanced search ----------------------------- */
function collectAdvFields() {
  const mediatype = [...document.querySelectorAll('.adv-mt:checked')].map((c) => c.value);
  return {
    title: $('#adv-title').value,
    subject: $('#adv-subject').value,
    creator: $('#adv-creator').value,
    language: $('#adv-language').value,
    dateFrom: $('#adv-date-from').value,
    dateTo: $('#adv-date-to').value,
    mediatype,
  };
}

async function refreshQueryPreview() {
  try {
    const q = await window.ia.search.buildQuery(collectAdvFields());
    $('#adv-query-preview').textContent = q;
  } catch {
    /* ignore preview errors */
  }
}

$('#adv-toggle').addEventListener('click', () => {
  const panel = $('#adv-panel');
  panel.hidden = !panel.hidden;
  $('#adv-toggle').textContent = panel.hidden ? 'Advanced ▾' : 'Advanced ▴';
  if (!panel.hidden) refreshQueryPreview();
});

$('#adv-panel').addEventListener('input', refreshQueryPreview);
$('#adv-panel').addEventListener('change', refreshQueryPreview);
$('#adv-search').addEventListener('click', () => advancedSearch(1));
$('#adv-clear').addEventListener('click', () => {
  $('#adv-panel')
    .querySelectorAll('input')
    .forEach((i) => (i.type === 'checkbox' ? (i.checked = false) : (i.value = '')));
  refreshQueryPreview();
});

/* ------------------------------ favorites (#13) -------------------------- */
let favorites = [];

function initFavorites(settings) {
  favorites = Array.isArray(settings.favorites) ? settings.favorites : [];
  renderFavoritesTab();
}

async function persistFavorites() {
  await window.ia.settings.update({ favorites });
}

function isFav(id) {
  return favoritesApi.hasFavorite(favorites, id);
}

async function toggleFav(item, starEl) {
  favorites = favoritesApi.toggleFavorite(favorites, item);
  await persistFavorites();
  const on = isFav(item.identifier);
  if (starEl) {
    starEl.classList.toggle('on', on);
    starEl.textContent = on ? '★' : '☆';
    starEl.title = on ? 'Remove from favorites' : 'Add to favorites';
  }
  renderFavoritesTab();
  toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok');
}

/** Build a small star button for a result card / modal. */
function favStar(item) {
  const on = isFav(item.identifier);
  const star = el('button', {
    class: `fav-star${on ? ' on' : ''}`,
    text: on ? '★' : '☆',
    title: on ? 'Remove from favorites' : 'Add to favorites',
    onclick: (e) => {
      e.stopPropagation();
      toggleFav(item, e.currentTarget);
    },
  });
  return star;
}

function renderFavoritesTab() {
  const list = $('#favorites-list');
  if (!list) return;
  list.innerHTML = '';
  $('#favorites-empty').hidden = favorites.length > 0;
  $('#fav-count').textContent = favorites.length ? `${favorites.length} saved` : '';
  for (const f of favorites) {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'body' }, [
        f.mediatype ? el('span', { class: 'mt', text: f.mediatype }) : null,
        el('div', { class: 'title', text: f.title || f.identifier }),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Details', onclick: () => openItem(f.identifier) }),
        el('button', { text: 'Download', onclick: () => quickDownload(f.identifier, f.title) }),
        el('button', {
          class: 'ghost',
          text: 'Remove',
          onclick: async () => {
            favorites = favoritesApi.removeFavorite(favorites, f.identifier);
            await persistFavorites();
            renderFavoritesTab();
            if (lastDocs.length) renderResults(lastDocs); // refresh card stars
          },
        }),
      ]),
    ]);
    list.appendChild(card);
  }
}

/* -------------------- saved searches & history (#6) ---------------------- */
let recentSearches = [];
let savedSearches = [];
const RECENT_CAP = 15;

/** Restore an `activeSearch` descriptor into the form and run it. */
function applySearch(search) {
  if (!search) return;
  if (search.type === 'advanced') {
    const f = search.fields || {};
    // Populate the visible advanced form for display. A multi-subject array is
    // shown comma-joined in the (single-line) subject input.
    $('#adv-title').value = f.title || '';
    $('#adv-subject').value = Array.isArray(f.subject) ? f.subject.join(', ') : f.subject || '';
    $('#adv-creator').value = f.creator || '';
    $('#adv-language').value = f.language || '';
    $('#adv-date-from').value = f.dateFrom || '';
    $('#adv-date-to').value = f.dateTo || '';
    const mt = new Set(Array.isArray(f.mediatype) ? f.mediatype : f.mediatype ? [f.mediatype] : []);
    document.querySelectorAll('.adv-mt').forEach((c) => (c.checked = mt.has(c.value)));
    // The descriptor IS the source of truth on restore — use its fields verbatim
    // (M1) rather than re-deriving from the form, so fields with no/incomplete
    // form mapping (mediatype values outside the checkbox set, multi-subject
    // arrays, collection, identifier, text) are preserved exactly.
    activeSearch = { type: 'advanced', fields: { ...f } };
    runSearch(1);
  } else {
    $('#search-input').value = search.q || '';
    activeSearch = { type: 'basic', q: search.q };
    runSearch(1);
  }
}

function recordSearch(search) {
  recentSearches = searchStore.addRecent(recentSearches, search, RECENT_CAP);
  window.ia.settings.update({ recentSearches }).catch(() => {});
  renderRecentDropdown();
}

function renderRecentDropdown() {
  const sel = $('#recent-select');
  sel.innerHTML = '<option value="">Recent searches…</option>';
  recentSearches.forEach((s, i) => {
    sel.appendChild(el('option', { value: String(i), text: searchStore.searchLabel(s) }));
  });
}

function renderSavedDropdown() {
  const sel = $('#saved-select');
  sel.innerHTML = '<option value="">Saved searches…</option>';
  savedSearches.forEach((s, i) => sel.appendChild(el('option', { value: String(i), text: s.name })));
}

function initSearchStore(settings) {
  recentSearches = Array.isArray(settings.recentSearches) ? settings.recentSearches : [];
  savedSearches = Array.isArray(settings.savedSearches) ? settings.savedSearches : [];
  renderRecentDropdown();
  renderSavedDropdown();
}

/** #4: empty the recent-search history (persistence handled by the caller). */
function clearRecentSearches() {
  recentSearches = [];
  renderRecentDropdown();
}
/** #4: empty the named saved searches (persistence handled by the caller). */
function clearSavedSearches() {
  savedSearches = [];
  renderSavedDropdown();
  $('#delete-saved').hidden = true;
}

$('#recent-select').addEventListener('change', (e) => {
  const i = Number(e.target.value);
  if (e.target.value !== '' && recentSearches[i]) applySearch(recentSearches[i]);
  e.target.value = '';
});

$('#saved-select').addEventListener('change', (e) => {
  const i = Number(e.target.value);
  $('#delete-saved').hidden = e.target.value === '';
  if (e.target.value !== '' && savedSearches[i]) applySearch(savedSearches[i].search);
});

$('#save-search').addEventListener('click', async () => {
  if (!activeSearch) return toast('Run a search first, then save it.', 'err');
  const name = await promptText('Name this saved search:', searchStore.searchLabel(activeSearch));
  if (!name) return;
  savedSearches = searchStore.addSaved(savedSearches, { name, search: activeSearch });
  await window.ia.settings.update({ savedSearches });
  renderSavedDropdown();
  toast(`Saved “${name}”.`, 'ok');
});

$('#delete-saved').addEventListener('click', async () => {
  const sel = $('#saved-select');
  const i = Number(sel.value);
  if (sel.value === '' || !savedSearches[i]) return;
  const name = savedSearches[i].name;
  savedSearches = searchStore.removeSaved(savedSearches, name);
  await window.ia.settings.update({ savedSearches });
  renderSavedDropdown();
  $('#delete-saved').hidden = true;
  toast(`Deleted “${name}”.`, 'ok');
});

/* ----------------------------- item modal -------------------------------- */
async function openItem(identifier) {
  const modal = $('#item-modal');
  const body = $('#item-body');
  body.innerHTML = '<p><span class="spinner"></span> Loading item…</p>';
  modal.hidden = false;
  try {
    const data = await window.ia.item.metadata(identifier);
    renderItem(identifier, data);
  } catch (ex) {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'error', text: ex.message || 'Failed to load item.' }));
  }
}

function renderItem(identifier, data) {
  const md = data.metadata || {};
  const files = (data.files || []).filter((f) => f.name && f.source !== 'metadata');
  const collection = itemView.isCollection(md); // #6
  const body = $('#item-body');
  body.innerHTML = '';

  const itemTitle = firstOf(md.title) || identifier;
  body.appendChild(el('h2', { text: itemTitle }));
  const subParts = [firstOf(md.creator), (firstOf(md.date) || '').slice(0, 10), firstOf(md.mediatype)]
    .filter(Boolean)
    .join(' · ');
  body.appendChild(el('div', { class: 'meta-line', text: subParts }));

  // #12: curated header — cover thumbnail + curated fields side by side.
  const cover = el('div', { class: 'item-cover' });
  const coverImg = el('img', {
    src: viewPrefs.thumbnailUrl(identifier),
    alt: '',
    loading: 'lazy',
    onerror: () => cover.remove(),
  });
  cover.appendChild(coverImg);

  const fieldDefs = itemView.curatedFields(md);
  const dl = el('dl', { class: 'curated' });
  for (const f of fieldDefs) {
    dl.appendChild(el('dt', { text: f.label }));
    dl.appendChild(el('dd', { text: f.value }));
  }
  body.appendChild(el('div', { class: 'item-head' }, [cover, dl]));

  if (md.description) {
    // Descriptions are attacker-controlled; render as PLAIN TEXT (textContent),
    // never as HTML (H2). The CSS `white-space: pre-wrap` preserves paragraphs.
    body.appendChild(el('div', { class: 'desc', text: descriptionText(md.description) }));
  }

  // #14: the file-type bubble chips were removed — they merely repeated the file
  // table below, so the detail view now goes straight to the related searches.

  // #13: "more from…" related searches that run IN-APP (not on the website).
  const related = itemView.relatedSearches(md);
  if (related.length) {
    body.appendChild(
      el('div', { class: 'related-links' }, related.map((r) =>
        el('button', {
          class: 'link-btn',
          text: r.label,
          onclick: () => runRelatedSearch(r.search),
        })
      ))
    );
  }

  // Toolbar — collections get a "download every member" action; regular items
  // get the per-file download buttons (#6).
  const downloadButtons = collection
    ? [
        el('button', {
          text: 'Download entire collection',
          onclick: () => downloadCollection(identifier),
        }),
      ]
    : [
        el('button', {
          text: 'Download all',
          onclick: () => startDownload(toDownloadItems(identifier, itemTitle, files, firstOf(md.mediatype)), itemTitle),
        }),
        el('button', {
          class: 'ghost',
          text: 'Download selected',
          onclick: () => {
            const picked = files.filter((_, i) => body.querySelector(`#pick-${i}`)?.checked);
            if (!picked.length) return toast('No files selected.', 'err');
            startDownload(toDownloadItems(identifier, itemTitle, picked, firstOf(md.mediatype)), itemTitle);
          },
        }),
      ];
  body.appendChild(
    el('div', { class: 'item-toolbar' }, [
      ...downloadButtons,
      el('button', {
        class: 'ghost',
        text: 'Open on archive.org',
        onclick: () => window.open(`https://archive.org/details/${encodeURIComponent(identifier)}`),
      }),
      (() => {
        const on = isFav(identifier);
        return el('button', {
          class: `ghost fav-toggle${on ? ' on' : ''}`,
          text: on ? '★ Favorited' : '☆ Favorite',
          onclick: (e) => {
            toggleFav({ identifier, title: itemTitle, mediatype: firstOf(md.mediatype) });
            const nowOn = isFav(identifier);
            e.currentTarget.textContent = nowOn ? '★ Favorited' : '☆ Favorite';
            e.currentTarget.classList.toggle('on', nowOn);
          },
        });
      })(),
      // #12: manage-your-item actions only when the logged-in account OWNS this
      // item (its uploader matches the account), not merely for any logged-in user.
      itemView.canEditItem(md, account)
        ? el('button', { class: 'ghost', text: 'Edit metadata', onclick: () => openEditMetadata(identifier, md) })
        : null,
      itemView.canEditItem(md, account)
        ? el('button', { class: 'ghost', text: 'Tasks', onclick: () => showTasks(identifier) })
        : null,
    ])
  );

  if (collection) {
    // #6: a collection's own "files" are just its logo — list its MEMBERS.
    renderCollectionMembers(identifier, body);
  } else {
    // File table
    const tbl = el('table', { class: 'file-table' });
    tbl.appendChild(
      el('thead', {}, el('tr', {}, [
        el('th', { class: 'pick' }),
        el('th', { text: 'File' }),
        el('th', { text: 'Format' }),
        el('th', { text: 'Size' }),
        el('th', {}),
      ]))
    );
    const tbody = el('tbody');
    files.forEach((f, i) => {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { class: 'pick' }, el('input', { type: 'checkbox', id: `pick-${i}` })),
          el('td', { text: f.name }),
          el('td', { text: f.format || '' }),
          el('td', { class: 'size', text: f.size ? formatBytes(f.size) : '' }),
          el('td', {}, el('button', {
            class: 'ghost dl-one',
            text: 'Get',
            onclick: () => startDownload(toDownloadItems(identifier, itemTitle, [f], firstOf(md.mediatype)), `${itemTitle} — ${f.name}`),
          })),
        ])
      );
    });
    tbl.appendChild(tbody);
    body.appendChild(tbl);
  }

  // Full metadata
  const grid = el('dl', { class: 'meta-grid' });
  for (const [k, v] of Object.entries(md)) {
    grid.appendChild(el('dt', { text: k }));
    grid.appendChild(el('dd', { text: Array.isArray(v) ? v.join('; ') : String(v) }));
  }
  body.appendChild(el('h3', { class: 'meta-grid-h', text: 'All metadata' }));
  body.appendChild(grid);
}

/**
 * #6: render the members of a collection inside the item modal. Searches
 * `collection:<id>` (members carry titles) and lists them with Details/Download,
 * instead of showing the collection's own logo files.
 */
async function renderCollectionMembers(identifier, body) {
  const section = el('div', { class: 'members' });
  const heading = el('h3', { class: 'meta-grid-h', text: 'Items in this collection' });
  const status = el('p', { class: 'muted', text: 'Loading members…' });
  body.appendChild(heading);
  body.appendChild(status);
  body.appendChild(section);
  try {
    const res = await window.ia.search.query(`collection:${identifier}`, { rows: 100, page: 1, sort: 'downloads desc' });
    const docs = res.docs || [];
    status.textContent = res.numFound
      ? `${res.numFound.toLocaleString()} item(s)${res.numFound > docs.length ? ` — showing first ${docs.length}` : ''}`
      : 'This collection has no public items.';
    for (const d of docs) {
      const id = d.identifier;
      const title = firstOf(d.title) || id;
      const sub = [firstOf(d.creator), (firstOf(d.date) || '').slice(0, 10), firstOf(d.mediatype)].filter(Boolean).join(' · ');
      section.appendChild(
        el('div', { class: 'member-row' }, [
          el('div', { class: 'member-info' }, [
            el('div', { class: 'member-title', text: title }),
            sub ? el('div', { class: 'member-sub', text: sub }) : null,
          ]),
          el('div', { class: 'member-actions' }, [
            el('button', { class: 'ghost', text: 'Details', onclick: () => openItem(id) }),
            el('button', { text: 'Download', onclick: () => quickDownload(id, title, firstOf(d.mediatype)) }),
          ]),
        ])
      );
    }
  } catch (ex) {
    status.textContent = ex.message || 'Could not load collection members.';
    status.className = 'error';
  }
}

$('#item-close').addEventListener('click', () => ($('#item-modal').hidden = true));
$('#item-modal').addEventListener('click', (e) => {
  if (e.target.id === 'item-modal') $('#item-modal').hidden = true;
});

/* --------------------- manage your items (#16) --------------------------- */
// Metadata fields the editor exposes (simple scalar fields).
const EDITABLE_FIELDS = ['title', 'creator', 'date', 'description', 'publisher', 'language', 'subject'];

function openEditMetadata(identifier, md) {
  const body = $('#item-body');
  body.innerHTML = '';
  body.appendChild(el('h2', { text: `Edit metadata — ${identifier}` }));
  body.appendChild(
    el('p', { class: 'muted small', text: 'Only changed fields are written, as a JSON Patch. Subjects are comma-separated.' })
  );

  const original = {};
  const inputs = {};
  const form = el('div', { class: 'edit-form' });
  for (const key of EDITABLE_FIELDS) {
    const raw = md[key];
    const value = Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw);
    original[key] = value;
    const input = key === 'description'
      ? el('textarea', { rows: '3', value })
      : el('input', { type: 'text', value });
    inputs[key] = input;
    form.appendChild(el('label', {}, [el('span', { text: key }), input]));
  }
  body.appendChild(form);

  const status = el('p', { class: 'status', hidden: true });
  body.appendChild(
    el('div', { class: 'item-toolbar' }, [
      el('button', {
        text: 'Save changes',
        onclick: async () => {
          const edited = {};
          for (const key of EDITABLE_FIELDS) {
            const v = inputs[key].value.trim();
            edited[key] = key === 'subject' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
          }
          // Normalize subject in `original` for a like-for-like diff.
          const orig = { ...original, subject: parseSubjectsFor(original.subject) };
          status.hidden = false;
          status.textContent = 'Saving…';
          const res = await window.ia.metadata.edit(identifier, orig, edited);
          if (res && res.ok && res.noChange) status.textContent = 'No changes to save.';
          else if (res && res.ok) {
            status.textContent = 'Saved ✓';
            toast('Metadata updated.', 'ok');
          } else {
            status.textContent = (res && res.error) || 'Save failed.';
          }
        },
      }),
      el('button', { class: 'ghost', text: 'Back', onclick: () => openItem(identifier) }),
    ])
  );
  body.appendChild(status);
}

function parseSubjectsFor(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function showTasks(identifier) {
  const body = $('#item-body');
  body.innerHTML = '';
  body.appendChild(el('h2', { text: `Tasks — ${identifier}` }));
  const note = el('p', { class: 'muted', text: 'Loading task status…' });
  body.appendChild(note);
  body.appendChild(el('div', { class: 'item-toolbar' }, [el('button', { class: 'ghost', text: 'Back', onclick: () => openItem(identifier) })]));
  try {
    const tasks = await window.ia.item.tasks(identifier);
    note.remove();
    if (!tasks.length) {
      body.insertBefore(el('p', { class: 'muted', text: 'No recent tasks for this item.' }), body.querySelector('.item-toolbar'));
      return;
    }
    const tbl = el('table', { class: 'file-table' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Task' }), el('th', { text: 'Operation' }), el('th', { text: 'Status' }),
    ])));
    const tbody = el('tbody');
    for (const t of tasks) {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: String(t.taskId) }),
        el('td', { text: t.op }),
        el('td', { text: t.status }),
      ]));
    }
    tbl.appendChild(tbody);
    body.insertBefore(tbl, body.querySelector('.item-toolbar'));
  } catch (ex) {
    note.textContent = ex.message || 'Could not load tasks.';
    note.className = 'error';
  }
}

/* ------------------------------ downloads -------------------------------- */
let destRoot = '';
let prefs = { ...viewPrefs.DEFAULT_PREFS };
// jobId -> count of files that failed checksum verification (#4).
const jobMismatches = new Map();

async function ensureDest() {
  if (destRoot) return true;
  const chosen = await window.ia.dialog.chooseFolder();
  if (!chosen) return false;
  destRoot = chosen;
  await window.ia.settings.update({ destRoot });
  renderDest();
  return true;
}

/**
 * Download one or more items. Each entry: { identifier, title?, files? }.
 * Files (if omitted) are fetched in the main process; format filter + rename
 * from prefs are applied there via planDownload.
 */
async function startDownload(items, label) {
  if (!items || !items.length) return toast('Nothing to download.', 'err');
  if (!(await ensureDest())) return;

  // Don't yank the user to the Downloads tab — just add the job and badge it.
  const jobId = nextJobId();
  const title = label || (items.length === 1 ? items[0].identifier : `${items.length} items`);
  const card = createJobCard(jobId, title, 0, 'download');
  $('#downloads-empty').hidden = true;
  $('#downloads-list').prepend(card);
  $('#downloads-empty').hidden = true;
  trackJobStart('download');
  notifyTransferAdded('download', title);

  // L1: the handler returns {ok:false} rather than rejecting, but guard against
  // the invoke itself rejecting so a failure surfaces instead of going silent.
  window.ia.download.start({ jobId, items, prefs, destRoot, label: title }).catch((e) => toast(e.message, 'err'));
}

// Download a single item (its files resolved + filtered in main). Passing the
// known mediatype lets main pick the Text vs Other format without re-fetching.
function quickDownload(identifier, title, mediatype) {
  const item = { identifier, title };
  if (mediatype) item.mediatype = mediatype;
  startDownload([item], title || identifier);
}

// #2: download every member of a collection.
async function downloadCollection(collection) {
  if (!validIdentifier(collection)) {
    return toast('Enter a valid collection identifier (letters, numbers, . _ - ; no spaces).', 'err');
  }
  if (!(await ensureDest())) return;
  const jobId = nextJobId();
  const card = createJobCard(jobId, `Collection: ${collection}`, 0, 'download');
  $('#downloads-empty').hidden = true;
  $('#downloads-list').prepend(card);
  trackJobStart('download');
  notifyTransferAdded('download', `Collection: ${collection}`);
  window.ia.download
    .collection({ jobId, collection, prefs, destRoot })
    .catch((e) => toast(e.message, 'err'));
}

// #15: the collection-download button is only shown when the CURRENT search is
// a `collection:<id>` search; it downloads that very collection.
$('#download-collection').addEventListener('click', async () => {
  const id = activeCollectionId();
  if (!id) return;
  // Confirm before pulling a large collection — use the count captured when the
  // button was shown for this collection (M8), not a possibly-stale live count.
  const warning = uiUtil.largeCollectionWarning(collectionDownloadCount, id);
  if (warning && !(await confirmDialog(warning))) return;
  downloadCollection(id);
});

/**
 * #15: the collection id the active search targets, or '' if the current search
 * isn't a single-collection search. Delegates to the shared (tested) helper so
 * a typed `collection:foo` query shows the Download-collection button too.
 */
function activeCollectionId() {
  return searchStore.collectionIdForSearch(activeSearch);
}

/** Show/hide the collection-download button based on the active search (#15). */
// The collection size captured at the moment the Download-collection button was
// last shown — so the >50 confirm uses a count that matches the visible button,
// not a live numFound that a later in-flight search might have changed (M8).
let collectionDownloadCount = 0;
function updateCollectionDownloadButton() {
  const id = activeCollectionId();
  const btn = $('#download-collection');
  if (btn) {
    btn.hidden = !id;
    btn.title = id ? `Download every item in “${id}”` : '';
  }
  collectionDownloadCount = id ? numFound : 0;
}

/* ----------------------- transfers badge (one-at-a-time) ------------------ */
// Active+queued counts per transfer type. Drives the single badge on the
// Transfers tab so the user sees work happening without being yanked there.
// The main process broadcasts the authoritative counts ({downloads, uploads});
// we take the larger of local-pending and main's count per type to avoid
// flicker between the renderer adding a job and main registering it.
let pendingDownloads = 0;
let pendingUploads = 0;
let gateDownloads = 0;
let gateUploads = 0;

function downloadCount() {
  return Math.max(pendingDownloads, gateDownloads);
}
function uploadCount() {
  return Math.max(pendingUploads, gateUploads);
}

function renderTransferBadge() {
  const badge = $('#downloads-badge');
  const state = uiUtil.transferBadge(downloadCount(), uploadCount());
  badge.textContent = state.text;
  badge.hidden = !state.visible;
  // Recolor by active type (upload color wins when an upload is in flight).
  badge.classList.toggle('badge-upload', state.kind === 'upload');
}

/** A new transfer job was added in the UI. kind: 'download' | 'upload'. */
function trackJobStart(kind) {
  if (kind === 'upload') pendingUploads++;
  else pendingDownloads++;
  renderTransferBadge();
}

/** A transfer job reached a terminal state (complete / error). */
function trackJobEnd(kind) {
  if (kind === 'upload') pendingUploads = Math.max(0, pendingUploads - 1);
  else pendingDownloads = Math.max(0, pendingDownloads - 1);
  renderTransferBadge();
}

/** Toast that a transfer was queued, without switching tabs. */
function notifyTransferAdded(kind, title) {
  const onTransfers = $('.tab[data-tab="downloads"]').classList.contains('active');
  if (onTransfers) return; // already looking at it
  const verb = kind === 'upload' ? 'Uploading' : 'Downloading';
  const total = downloadCount() + uploadCount();
  const msg = total > 1
    ? `Queued — ${total} transfer(s) pending. See the Transfers tab.`
    : `${verb} “${title}” — see the Transfers tab.`;
  toast(msg, 'ok');
}

// Latest queue snapshot from main: { active, waiting: [{jobId, kind, label}] }.
// Drives card ordering and the drag-to-reorder target computation.
let transferSnapshot = { active: null, waiting: [] };

// Authoritative queue state from main (active + ordered waiting + counts).
if (window.ia.transfer && window.ia.transfer.onQueue) {
  window.ia.transfer.onQueue((p) => {
    gateDownloads = Number(p && p.downloads) || 0;
    gateUploads = Number(p && p.uploads) || 0;
    transferSnapshot = { active: (p && p.active) || null, waiting: (p && p.waiting) || [] };
    renderTransferBadge();
    reorderTransferCards();
  });
}

/** Ordered list of WAITING jobIds for a given kind (from the latest snapshot). */
function waitingIdsForKind(kind) {
  return transferSnapshot.waiting.filter((w) => w.kind === kind).map((w) => w.jobId);
}

/**
 * Reorder the cards in each Transfers section to match the queue: the ACTIVE
 * job pinned at the top, then the WAITING jobs in queue order. Also marks which
 * cards are draggable (only waiting ones) and which is active.
 */
function reorderTransferCards() {
  const active = transferSnapshot.active && transferSnapshot.active.jobId;
  for (const kind of ['download', 'upload']) {
    const list = $(kind === 'upload' ? '#uploads-list' : '#downloads-list');
    if (!list) continue;
    const order = [];
    if (active && transferSnapshot.active.kind === kind) order.push(active);
    order.push(...waitingIdsForKind(kind));
    // Move known cards to the front in queue order; unknown/finished cards keep
    // their relative position after them.
    for (let i = order.length - 1; i >= 0; i--) {
      const card = document.getElementById(order[i]);
      if (card) list.prepend(card);
    }
    // Mark active vs draggable (waiting) state on each card.
    for (const card of list.querySelectorAll('.job')) {
      const id = card.id;
      const isActive = id === active;
      const isWaiting = waitingIdsForKind(kind).includes(id);
      card.classList.toggle('job-active', isActive);
      card.classList.toggle('job-waiting', isWaiting);
      card.draggable = isWaiting; // only queued jobs can be dragged
    }
  }
}

/* ------------------- drag-to-reorder queued transfers -------------------- */
let dragJobId = null;

/** The waiting card the pointer is currently over (drop target anchor). */
function cardUnderEvent(list, e) {
  const cards = [...list.querySelectorAll('.job.job-waiting')];
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return card; // drop BEFORE this card
  }
  return null; // past the last waiting card → drop at the end
}

function setupTransferDrag() {
  for (const kind of ['download', 'upload']) {
    const list = $(kind === 'upload' ? '#uploads-list' : '#downloads-list');
    if (!list) continue;
    list.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.job.job-waiting');
      if (!card) return;
      dragJobId = card.id;
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    list.addEventListener('dragend', (e) => {
      const card = e.target.closest('.job');
      if (card) card.classList.remove('dragging');
      list.querySelectorAll('.drop-before').forEach((c) => c.classList.remove('drop-before'));
      dragJobId = null;
    });
    list.addEventListener('dragover', (e) => {
      if (!dragJobId) return;
      e.preventDefault(); // allow drop
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.drop-before').forEach((c) => c.classList.remove('drop-before'));
      const anchor = cardUnderEvent(list, e);
      if (anchor) anchor.classList.add('drop-before');
    });
    list.addEventListener('drop', async (e) => {
      if (!dragJobId) return;
      e.preventDefault();
      const anchor = cardUnderEvent(list, e);
      const beforeId = anchor ? anchor.id : null;
      const waitingIds = waitingIdsForKind(kind);
      const toIndex = selectionUtil.queueDropTarget(dragJobId, beforeId, waitingIds);
      const moved = dragJobId;
      dragJobId = null;
      list.querySelectorAll('.drop-before').forEach((c) => c.classList.remove('drop-before'));
      if (toIndex == null) return; // no-op drop
      await window.ia.transfer.reorder(moved, toIndex).catch((err) => toast(err.message, 'err'));
    });
  }
}
setupTransferDrag();

/**
 * #7: remove finished (completed or failed) transfer cards from both sections.
 * A card is finished when its progress bar has the `done` or `error` class
 * (set in updateJob); active/queued cards are left untouched. Restores the
 * "no transfers yet" placeholder when a section empties out.
 */
function clearFinishedTransfers() {
  for (const kind of ['download', 'upload']) {
    const list = $(kind === 'upload' ? '#uploads-list' : '#downloads-list');
    if (!list) continue;
    for (const card of [...list.querySelectorAll('.job')]) {
      const prog = card.querySelector('.progress');
      if (prog && (prog.classList.contains('done') || prog.classList.contains('error'))) {
        card.remove();
      }
    }
    const empty = $(kind === 'upload' ? '#uploads-empty' : '#downloads-empty');
    if (empty) empty.hidden = list.querySelector('.job') != null;
  }
}
$('#clear-transfers').addEventListener('click', clearFinishedTransfers);

function createJobCard(jobId, identifier, count, kind) {
  // L2: the true file count for a download isn't known until main resolves
  // metadata + filters, so don't show a misleading "0 / 0 files" — say
  // "Preparing…" until the first phase update (or an error) replaces it.
  const sub = el('div', {
    class: 'job-sub',
    id: `${jobId}-sub`,
    text: count > 0 ? `0 / ${count} files` : 'Preparing…',
  });
  const bar = el('div', { class: 'progress' }, el('span', { id: `${jobId}-bar` }));
  const cancelBtn = el('button', {
    class: 'ghost',
    text: 'Cancel',
    onclick: () =>
      (kind === 'download' ? window.ia.download.cancel(jobId) : window.ia.upload.cancel(jobId)).catch(() => {}),
  });
  const openBtn = el('button', {
    class: 'ghost',
    text: 'Open folder',
    id: `${jobId}-open`,
    hidden: true,
  });
  // #4: direction marker — ↑ for uploads, ↓ for downloads — plus a kind class
  // so the card can be colored by transfer type.
  const arrow = el('span', {
    class: `dir-mark ${kind === 'upload' ? 'up' : 'down'}`,
    text: kind === 'upload' ? '↑' : '↓',
    title: kind === 'upload' ? 'Upload' : 'Download',
  });
  return el('div', { class: `job job-${kind}`, id: jobId }, [
    el('div', { class: 'job-top' }, [
      el('div', { class: 'job-head' }, [arrow, el('div', {}, [el('div', { class: 'job-title', text: identifier }), sub])]),
      el('div', { class: 'job-actions' }, [cancelBtn, openBtn]),
    ]),
    bar,
  ]);
}

/** Prepend a job card to the right section (downloads vs uploads) and reveal it. */
function addJobCard(card, kind) {
  if (kind === 'upload') {
    $('#uploads-empty').hidden = true;
    $('#uploads-list').prepend(card);
  } else {
    $('#downloads-empty').hidden = true;
    $('#downloads-list').prepend(card);
  }
}

window.ia.download.onProgress((p) => updateJob(p, 'download'));
window.ia.upload.onProgress((p) => updateJob(p, 'upload'));

function updateJob(p, kind) {
  const bar = $(`#${p.jobId}-bar`);
  const sub = $(`#${p.jobId}-sub`);
  const card = $(`#${p.jobId}`);
  if (!card) return;
  const got = kind === 'download' ? p.received : p.sent;

  // #1: downloads now run concurrently, so the bar tracks OVERALL completion
  // (files done / total) rather than a single file's bytes; the label shows the
  // most recent file. Uploads remain sequential and keep their per-file bar.
  if (p.phase === 'file-progress') {
    if (kind === 'upload') bar.style.width = percent(got, p.totalBytes) + '%';
    sub.textContent = `${p.index + 1} / ${p.total} — ${escapeHtml(p.name)} (${formatBytes(got)} / ${formatBytes(p.totalBytes)})`;
  } else if (p.phase === 'file-start') {
    sub.textContent = `${p.index + 1} / ${p.total} — ${escapeHtml(p.name)}`;
  } else if (p.phase === 'queued') {
    // Serialized behind an in-progress download — show the user it's waiting.
    sub.textContent = p.position > 1 ? `Queued (#${p.position}) — waiting for the current download…` : 'Queued — waiting…';
  } else if (p.phase === 'listing') {
    sub.textContent = p.message || 'Listing…';
  } else if (p.phase === 'notice') {
    // Soft, non-fatal notice (e.g. a format fallback). Warn but keep going.
    if (p.message) {
      toast(p.message, p.level === 'warn' ? 'err' : 'ok');
      let note = card.querySelector('.job-note');
      if (!note) {
        note = el('div', { class: 'job-note' });
        sub.insertAdjacentElement('afterend', note);
      }
      note.textContent = `⚠ ${p.message}`;
    }
  } else if (p.phase === 'item-start') {
    bar.style.width = percent(p.index - 1, p.total) + '%';
    sub.textContent = `Item ${p.index} / ${p.total} — ${escapeHtml(p.identifier)}`;
  } else if (p.phase === 'item-done' || p.phase === 'item-skip') {
    // progress advances on the next item-start / complete
  } else if (p.phase === 'file-retry') {
    sub.textContent = `Retrying (${p.attempt}) — ${escapeHtml(p.name)}…`;
  } else if (p.phase === 'file-done') {
    if (kind === 'download' && p.completed != null) {
      bar.style.width = percent(p.completed, p.total) + '%';
      sub.textContent = `${p.completed} / ${p.total} done`;
    } else {
      bar.style.width = '100%';
    }
    // #4: track checksum mismatches per job so we can warn at completion.
    if (kind === 'download' && p.verified === 'mismatch') {
      jobMismatches.set(p.jobId, (jobMismatches.get(p.jobId) || 0) + 1);
    }
  } else if (p.phase === 'complete') {
    bar.parentElement.classList.add('done');
    bar.style.width = '100%';
    const mismatches = jobMismatches.get(p.jobId) || 0;
    jobMismatches.delete(p.jobId);
    sub.textContent =
      kind === 'download' ? downloadDoneSummary(p.count, mismatches) : 'Upload complete';
    if (mismatches > 0) card.querySelector('.progress').classList.add('warn');
    const cancelBtn = card.querySelector('.job-actions button');
    if (cancelBtn) cancelBtn.remove(); // remove cancel
    if (kind === 'download' && p.dir) {
      const open = $(`#${p.jobId}-open`);
      open.hidden = false;
      open.onclick = () => window.ia.shell.openPath(p.dir).catch((e) => toast(e.message, 'err'));
    }
    // On a successful single upload, offer a link to the new item page.
    if (kind === 'upload' && p.identifier) {
      const url = uiUtil.itemPageUrl(p.identifier);
      if (url) {
        const link = el('button', {
          class: 'ghost view-item-btn',
          text: 'View item page',
          title: url,
          onclick: () => window.ia.shell.openExternal(url).catch((e) => toast(e.message, 'err')),
        });
        card.querySelector('.job-actions').appendChild(link);
      }
    }
    if (kind === 'download' && mismatches > 0) {
      toast(`Download complete, but ${mismatches} file(s) failed checksum verification.`, 'err');
    } else {
      toast(kind === 'download' ? 'Download complete' : 'Upload complete', 'ok');
    }
    trackJobEnd(kind);
  } else if (p.phase === 'error') {
    bar.parentElement.classList.add('error');
    sub.textContent = `Error: ${p.message}`;
    toast(p.message, 'err');
    trackJobEnd(kind);
  }
}

/* --------------------------- settings & prefs ---------------------------- */
async function initSettings() {
  const s = await window.ia.settings.get();
  destRoot = s.destRoot || '';
  prefs = viewPrefs.normalizePrefs(s);
  initSearchStore(s); // #6: load recent/saved searches
  initFavorites(s); // #13: load favorites
  initUploadTemplates(s); // #15: load metadata templates
  populateUploadLanguages(); // upload language dropdown (top 15 IA codes)
  $('#pref-format-text').value = prefs.formatText;
  $('#pref-format-other').value = prefs.formatOther;
  $('#pref-rename').value = prefs.rename;
  $('#pref-include').value = prefs.includeGlobs || '';
  $('#pref-exclude').value = prefs.excludeGlobs || '';
  $('#pref-view').value = prefs.viewMode;
  $('#pref-subjects').checked = prefs.showSubjects;
  $('#pref-creator').checked = prefs.showCreator; // #10
  $('#pref-type').checked = prefs.showType; // #10
  $('#pref-preserve-upload-meta').checked = prefs.preserveUploadMeta;
  $('#pref-logging').checked = prefs.logging; // #1
  $('#pref-subfolders').checked = prefs.downloadSubfolders; // #5
  $('#pref-download-delay').value = String(prefs.downloadDelaySec); // #16
  $('#pref-redownload').checked = prefs.reDownload; // skip vs re-download existing files
  $('#pref-theme').value = prefs.theme;
  // #8: results-per-page (50/100/200) — normalized default is 200.
  ROWS = prefs.perPage;
  $('#per-page').value = String(ROWS);
  // #4: list density
  applyDensity(prefs.density);
  if ($('#pref-density')) $('#pref-density').value = prefs.density;
  applyTheme(prefs.theme);
  syncViewButtons();
  renderDest();
  updatePrefExample();
}

/* ------------------------------- theme (#17) ----------------------------- */
const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Apply a theme setting ('system'|'light'|'dark') to the document. */
function applyTheme(setting) {
  const resolved = viewPrefs.resolveTheme(setting, darkMedia ? darkMedia.matches : true);
  document.documentElement.dataset.theme = resolved;
}

// When following the OS theme, react live to OS appearance changes.
if (darkMedia) {
  darkMedia.addEventListener('change', () => {
    if (prefs.theme === 'system') applyTheme('system');
  });
}

function renderDest() {
  const txt = destRoot || 'Not set (you will be asked)';
  $('#dest-path').textContent = txt;
  $('#pref-dest-path').textContent = txt;
}

function updatePrefExample() {
  const ex =
    prefs.rename === 'replace'
      ? 'book_text.pdf  →  Kokoro.pdf'
      : prefs.rename === 'append'
        ? 'book_text.pdf  →  book_text - Kokoro.pdf'
        : 'book_text.pdf  →  book_text.pdf (unchanged)';
  $('#pref-example').textContent = ex;
}

function flashSaved() {
  const s = $('#prefs-saved');
  s.hidden = false;
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => (s.hidden = true), 1500);
}

async function chooseDest() {
  const chosen = await window.ia.dialog.chooseFolder();
  if (chosen) {
    destRoot = chosen;
    await window.ia.settings.update({ destRoot });
    renderDest();
  }
}
$('#choose-dest').addEventListener('click', chooseDest);
$('#pref-choose-dest').addEventListener('click', chooseDest);

// Two-dropdown download format: Text items vs everything else.
$('#pref-format-text').addEventListener('change', async (e) => {
  prefs.formatText = e.target.value;
  await window.ia.settings.update({ formatText: prefs.formatText });
  flashSaved();
});
$('#pref-format-other').addEventListener('change', async (e) => {
  prefs.formatOther = e.target.value;
  await window.ia.settings.update({ formatOther: prefs.formatOther });
  flashSaved();
});
$('#pref-rename').addEventListener('change', async (e) => {
  prefs.rename = e.target.value;
  await window.ia.settings.update({ rename: prefs.rename });
  updatePrefExample();
  flashSaved();
});
$('#pref-theme').addEventListener('change', async (e) => {
  prefs.theme = e.target.value;
  applyTheme(prefs.theme);
  await window.ia.settings.update({ theme: prefs.theme });
  flashSaved();
});
$('#pref-include').addEventListener('change', async (e) => {
  prefs.includeGlobs = e.target.value;
  await window.ia.settings.update({ includeGlobs: prefs.includeGlobs });
  flashSaved();
});
$('#open-logs').addEventListener('click', () => window.ia.logs.open().catch((e) => toast(e.message, 'err')));
$('#pref-exclude').addEventListener('change', async (e) => {
  prefs.excludeGlobs = e.target.value;
  await window.ia.settings.update({ excludeGlobs: prefs.excludeGlobs });
  flashSaved();
});
$('#pref-view').addEventListener('change', async (e) => {
  await setViewMode(e.target.value);
  flashSaved();
});
$('#pref-subjects').addEventListener('change', async (e) => {
  await setShowSubjects(e.target.checked);
  flashSaved();
});
// #10: card-level creator / type toggles. Re-render the current page to reflect.
$('#pref-creator').addEventListener('change', async (e) => {
  prefs.showCreator = e.target.checked;
  await window.ia.settings.update({ showCreator: prefs.showCreator });
  renderResults(lastDocs);
  flashSaved();
});
$('#pref-type').addEventListener('change', async (e) => {
  prefs.showType = e.target.checked;
  await window.ia.settings.update({ showType: prefs.showType });
  renderResults(lastDocs);
  flashSaved();
});
// #1: diagnostics/logging toggle.
$('#pref-logging').addEventListener('change', async (e) => {
  prefs.logging = e.target.checked;
  await window.ia.settings.update({ logging: prefs.logging });
  flashSaved();
});
// #5: per-download subfolder toggle.
$('#pref-subfolders').addEventListener('change', async (e) => {
  prefs.downloadSubfolders = e.target.checked;
  await window.ia.settings.update({ downloadSubfolders: prefs.downloadSubfolders });
  flashSaved();
});
// Re-download vs skip existing files.
$('#pref-redownload').addEventListener('change', async (e) => {
  prefs.reDownload = e.target.checked;
  await window.ia.settings.update({ reDownload: prefs.reDownload });
  flashSaved();
});
// #16: inter-download delay (0–99 seconds). Clamp on commit.
$('#pref-download-delay').addEventListener('change', async (e) => {
  const clamped = viewPrefs.normalizePrefs({ downloadDelaySec: e.target.value }).downloadDelaySec;
  prefs.downloadDelaySec = clamped;
  e.target.value = String(clamped);
  await window.ia.settings.update({ downloadDelaySec: clamped });
  flashSaved();
});
// #4: clear recent-search history / saved searches.
$('#clear-recent-searches').addEventListener('click', async () => {
  await window.ia.settings.update({ recentSearches: [] });
  clearRecentSearches();
  toast('Search cache cleared.', 'ok');
});
$('#clear-saved-searches').addEventListener('click', async () => {
  await window.ia.settings.update({ savedSearches: [] });
  clearSavedSearches();
  toast('Saved searches cleared.', 'ok');
});
$('#pref-density').addEventListener('change', async (e) => {
  await setDensity(e.target.value);
  flashSaved();
});
$('#pref-preserve-upload-meta').addEventListener('change', async (e) => {
  prefs.preserveUploadMeta = e.target.checked;
  await window.ia.settings.update({ preserveUploadMeta: prefs.preserveUploadMeta });
  flashSaved();
});

/* ------------------------------- upload ---------------------------------- */
let uploadFiles = [];

$('#up-choose-files').addEventListener('click', async () => {
  const picked = await window.ia.upload.chooseFiles();
  if (picked && picked.length) {
    uploadFiles = picked;
    autofillFromFirstFile({ overwrite: false }); // #1/#2: default title + id
    renderUploadFiles();
  }
});

/**
 * Default the title and identifier from the first upload file's name (#1/#2).
 * `overwrite` forces a refresh (used on drag-drop); otherwise only blank fields
 * are filled so a manual edit isn't clobbered.
 */
function autofillFromFirstFile({ overwrite }) {
  const first = uploadFiles[0];
  if (!first) return;
  const titleEl = $('#up-title');
  const idEl = $('#up-identifier');
  if (overwrite || !titleEl.value.trim()) {
    titleEl.value = uploadTemplates.deriveTitleFromFilename(first.name);
  }
  if (overwrite || !idEl.value.trim()) {
    idEl.value = uploadTemplates.deriveIdentifierFromFilename(first.name);
  }
}

function renderUploadFiles() {
  const list = $('#up-file-list');
  list.innerHTML = '';
  uploadFiles.forEach((f) => {
    list.appendChild(
      el('div', { class: 'f' }, [el('span', { text: f.name }), el('span', { class: 'muted', text: formatBytes(f.size) })])
    );
  });
  $('#up-submit').disabled = uploadFiles.length === 0;
}

/* ----------------------- drag & drop upload (#15) ------------------------ */
const dropZone = $('#up-drop-zone');
['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove('drag-over');
  })
);
dropZone.addEventListener('drop', (e) => {
  // Electron exposes the real filesystem path on dropped File objects.
  const dropped = uploadTemplates.extractDroppedFiles([...(e.dataTransfer.files || [])]);
  if (!dropped.length) return toast('No files in that drop.', 'err');
  const hadNone = uploadFiles.length === 0;
  const existing = new Set(uploadFiles.map((f) => f.path));
  for (const f of dropped) if (!existing.has(f.path)) uploadFiles.push(f);
  // A drop updates the title/identifier from the dropped file (req #1/#2). If
  // files were already staged, base it on the FIRST newly dropped file.
  if (hadNone) {
    autofillFromFirstFile({ overwrite: true });
  } else {
    // Use the first dropped file as the naming source on a subsequent drop.
    const src = dropped[0];
    $('#up-title').value = uploadTemplates.deriveTitleFromFilename(src.name);
    $('#up-identifier').value = uploadTemplates.deriveIdentifierFromFilename(src.name);
  }
  renderUploadFiles();
});

/* ---------------------- upload metadata templates (#15) ------------------ */
let uploadTemplateList = [];

function currentUploadForm() {
  return {
    creator: $('#up-creator').value,
    date: $('#up-date').value,
    mediatype: $('#up-mediatype').value,
    language: $('#up-language').value,
    description: $('#up-description').value,
    subjects: $('#up-subjects').value,
  };
}

function setUploadForm(form) {
  if (form.creator != null) $('#up-creator').value = form.creator;
  if (form.date != null) $('#up-date').value = form.date;
  if (form.mediatype) $('#up-mediatype').value = form.mediatype;
  if (form.language != null) $('#up-language').value = form.language;
  if (form.description != null) $('#up-description').value = form.description;
  if (form.subjects != null) $('#up-subjects').value = form.subjects;
}

/** Populate the upload language dropdown from the shared MARC-code list. */
function populateUploadLanguages() {
  const sel = $('#up-language');
  if (!sel) return;
  // Idempotent: keep only the leading "— none —" option, then (re)add languages.
  sel.innerHTML = '<option value="">— none —</option>';
  for (const { code, label } of uiUtil.UPLOAD_LANGUAGES) {
    sel.appendChild(el('option', { value: code, text: `${label} (${code})` }));
  }
}

function renderTemplateDropdown() {
  const sel = $('#tmpl-select');
  sel.innerHTML = '<option value="">Metadata template…</option>';
  uploadTemplateList.forEach((t, i) => sel.appendChild(el('option', { value: String(i), text: t.name })));
}

function initUploadTemplates(settings) {
  uploadTemplateList = Array.isArray(settings.uploadTemplates) ? settings.uploadTemplates : [];
  renderTemplateDropdown();
}

$('#tmpl-select').addEventListener('change', (e) => {
  $('#tmpl-delete').hidden = e.target.value === '';
  const i = Number(e.target.value);
  if (e.target.value !== '' && uploadTemplateList[i]) {
    setUploadForm(uploadTemplates.applyTemplate(uploadTemplateList[i], currentUploadForm()));
    toast(`Applied template “${uploadTemplateList[i].name}”.`, 'ok');
  }
});

$('#tmpl-save').addEventListener('click', async () => {
  const name = await promptText('Name this metadata template:', '');
  if (!name) return;
  uploadTemplateList = uploadTemplates.addTemplate(uploadTemplateList, { name, fields: currentUploadForm() });
  await window.ia.settings.update({ uploadTemplates: uploadTemplateList });
  renderTemplateDropdown();
  toast(`Saved template “${name}”.`, 'ok');
});

$('#tmpl-delete').addEventListener('click', async () => {
  const sel = $('#tmpl-select');
  const i = Number(sel.value);
  if (sel.value === '' || !uploadTemplateList[i]) return;
  const name = uploadTemplateList[i].name;
  uploadTemplateList = uploadTemplates.removeTemplate(uploadTemplateList, name);
  await window.ia.settings.update({ uploadTemplates: uploadTemplateList });
  renderTemplateDropdown();
  $('#tmpl-delete').hidden = true;
  toast(`Deleted template “${name}”.`, 'ok');
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = $('#up-identifier').value.trim();
  if (!validIdentifier(identifier)) {
    return toast('Identifier may use letters, numbers, . _ - (no spaces).', 'err');
  }
  if (!uploadFiles.length) return toast('Choose at least one file.', 'err');

  const metadata = buildUploadMetadata({
    title: $('#up-title').value,
    creator: $('#up-creator').value,
    date: $('#up-date').value,
    mediatype: $('#up-mediatype').value,
    description: $('#up-description').value,
    subjects: $('#up-subjects').value,
    language: $('#up-language').value,
    pageProgressionRl: $('#up-rtl').checked,
    oneUp: $('#up-1up').checked,
  });
  const derive = true; // derive always runs (generates viewers/thumbnails)
  const files = uploadFiles;

  // Add the job card to the Uploads section (no tab switch) and badge it.
  const jobId = nextJobId();
  const card = createJobCard(jobId, identifier, files.length, 'upload');
  addJobCard(card, 'upload');
  trackJobStart('upload');
  notifyTransferAdded('upload', metadata.title || identifier);

  // Fire the upload but DON'T await it here — clear the form immediately so the
  // user can set up the next upload while this one runs/queues (req #5). The
  // job card + progress events report status; a failure surfaces via toast.
  window.ia.upload
    .start({ jobId, identifier, files, metadata, derive })
    .then((res) => {
      if (res && !res.ok) toast(res.error || 'Upload failed.', 'err');
    })
    .catch((ex) => toast(ex.message || 'Upload failed.', 'err'));

  // Reset the form for the next upload (keeps metadata when the pref is on).
  resetUploadForm({ preserve: prefs.preserveUploadMeta });
  $('#upload-status').hidden = true;
});

/**
 * Reset the Upload form after a submit (req #5). Always clears the staged files,
 * identifier, and title; keeps creator/date/mediatype/description/subjects when
 * `preserve` is true. Also used by the "Clear All" button (preserve=false).
 */
function resetUploadForm({ preserve }) {
  uploadFiles = [];
  renderUploadFiles();
  const next = uploadTemplates.nextUploadForm(currentUploadForm(), preserve);
  $('#up-identifier').value = next.identifier;
  $('#up-title').value = next.title;
  $('#up-creator').value = next.creator;
  $('#up-date').value = next.date;
  $('#up-mediatype').value = next.mediatype;
  $('#up-language').value = next.language;
  $('#up-description').value = next.description;
  $('#up-subjects').value = next.subjects;
  // BookReader hints are per-item — always reset them.
  $('#up-rtl').checked = false;
  $('#up-1up').checked = false;
  $('#up-submit').disabled = true;
}

// "Clear All" wipes every field regardless of the preserve preference.
$('#up-clear').addEventListener('click', () => {
  resetUploadForm({ preserve: false });
  $('#upload-status').hidden = true;
  toast('Upload form cleared.', 'ok');
});

/* ---------------------- bulk / spreadsheet upload (#14) ------------------ */
let bulkPlan = null;

$('#bulk-choose').addEventListener('click', async () => {
  const res = await window.ia.bulk.choose();
  if (!res) return; // cancelled
  bulkPlan = res.plan || [];
  $('#bulk-path').textContent = res.csvPath || '';
  renderBulkSummary(res);
});

function renderBulkSummary(res) {
  const box = $('#bulk-summary');
  box.hidden = false;
  box.innerHTML = '';
  const totalFiles = (res.plan || []).reduce((n, it) => n + it.files.length, 0);
  const missing = (res.plan || []).reduce((n, it) => n + it.files.filter((f) => !f.exists).length, 0);
  box.appendChild(
    el('div', { text: `${res.plan.length} item(s), ${totalFiles} file(s)${missing ? `, ⚠ ${missing} missing on disk` : ''}.` })
  );
  for (const e of res.errors || []) box.appendChild(el('div', { class: 'error', text: e }));
  for (const it of (res.plan || []).slice(0, 30)) {
    const present = it.files.filter((f) => f.exists).length;
    box.appendChild(
      el('div', { class: 'bulk-item' }, `${it.identifier} — ${present}/${it.files.length} file(s)`)
    );
  }
  const hasUploadable = (res.plan || []).some((it) => it.files.some((f) => f.exists));
  $('#bulk-start').hidden = !hasUploadable;
}

$('#bulk-start').addEventListener('click', async () => {
  if (!bulkPlan || !bulkPlan.length) return;
  const derive = true; // derive always runs (generates viewers/thumbnails)
  const jobId = nextJobId();
  const card = createJobCard(jobId, `Bulk upload (${bulkPlan.length} items)`, bulkPlan.length, 'upload');
  addJobCard(card, 'upload');
  trackJobStart('upload');
  notifyTransferAdded('upload', `Bulk upload (${bulkPlan.length} items)`);
  window.ia.bulk
    .upload({ jobId, plan: bulkPlan, derive })
    .then((res) => {
      if (res && !res.ok) toast(res.error || 'Bulk upload failed.', 'err');
    })
    .catch((ex) => toast(ex.message || 'Bulk upload failed.', 'err'));
});

/* -------------------------------- boot ----------------------------------- */
// Apply the saved theme as early as possible so the login screen matches it,
// before the rest of settings load (#17).
(async () => {
  try {
    const s = await window.ia.settings.get();
    applyTheme(viewPrefs.normalizePrefs(s).theme);
  } catch {
    /* fall back to the default theme */
  }
})();

// Dev-only: build a fake transfer queue (one active + several queued per kind)
// so a screenshot can show the ordering, the "active" pin, drag handles, and the
// reorder affordance. Triggered by `&queue` in the demo hash.
function demoQueue() {
  const mk = (id, label, kind) => {
    const card = createJobCard(id, label, 2, kind);
    addJobCard(card, kind);
  };
  mk('job-d-1', 'Grateful Dead 1977-05-08', 'download');
  mk('job-d-2', 'cia-rdp80 (queued)', 'download');
  mk('job-d-3', 'prelinger-reel-42 (queued)', 'download');
  mk('job-u-1', 'my-photo-album', 'upload');
  mk('job-u-2', 'field-notes-1990 (queued)', 'upload');
  mk('job-u-3', 'u65e5u8a18 (queued)', 'upload');
  // Active = first of each kind; the rest wait in order.
  gateDownloads = 3;
  gateUploads = 3;
  transferSnapshot = {
    active: { jobId: 'job-d-1', kind: 'download', label: 'Grateful Dead 1977-05-08' },
    waiting: [
      { jobId: 'job-d-2', kind: 'download', label: 'cia-rdp80' },
      { jobId: 'job-d-3', kind: 'download', label: 'prelinger-reel-42' },
      { jobId: 'job-u-1', kind: 'upload', label: 'my-photo-album' },
      { jobId: 'job-u-2', kind: 'upload', label: 'field-notes-1990' },
      { jobId: 'job-u-3', kind: 'upload', label: 'u65e5u8a18' },
    ],
  };
  renderTransferBadge();
  reorderTransferCards();
}

// Dev-only: `--demo=<query>` (passed via the URL hash) auto-runs a search and
// switches to compact view so a screenshot can capture a populated UI.
(function maybeDemo() {
  const m = /[#&]demo=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  const query = decodeURIComponent(m[1]);
  const wantList = /[#&]view=compact/.test(location.hash || '');
  const wantSelect = /[#&]select/.test(location.hash || '');
  const wantSubjects = /[#&]subjects/.test(location.hash || '');
  const tabMatch = /[#&]tab=([a-z]+)/.exec(location.hash || '');
  const start = async () => {
    await refreshAuth();
    if ($('#app').hidden) return; // not logged in — nothing to demo
    if (tabMatch) {
      const t = document.querySelector(`.tab[data-tab="${tabMatch[1]}"]`);
      if (t) t.click(); // demo: jump straight to a tab (e.g. Help)
    }
    const badgeMatch = /[#&]badge=(\d+)/.exec(location.hash || '');
    const badgeUpMatch = /[#&]badgeup=(\d+)/.exec(location.hash || '');
    if (badgeMatch || badgeUpMatch) {
      gateDownloads = badgeMatch ? Number(badgeMatch[1]) : 0; // demo: transfers badge
      gateUploads = badgeUpMatch ? Number(badgeUpMatch[1]) : 0;
      renderTransferBadge();
    }
    if (/[#&]queue/.test(location.hash || '')) demoQueue(); // dev: populate a fake queue
    if (wantSubjects) setShowSubjects(true); // demo: show subject tags
    $('#search-input').value = query;
    basicSearch(1);
    setTimeout(() => {
      const btn = wantList ? $('#view-compact') : $('#view-grid');
      if (btn) btn.click();
      if (wantSelect) {
        // Real selection via the actual checkbox event path: select rows 0–2 on
        // page 1, then page to 2 and select one more — to prove #3/#9 live.
        const boxes = () => [...document.querySelectorAll('#results .pick-box')];
        setTimeout(() => {
          boxes()[0].click(); // select row 0 (anchor)
          const b2 = boxes()[2];
          b2.checked = true;
          b2.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // shift-range 0..2
          // eslint-disable-next-line no-console
          console.log('DEMO_SELECT page1 selected=' + selected.size);
          $('#next-page').click();
          setTimeout(() => {
            boxes()[0].click();
            // eslint-disable-next-line no-console
            console.log('DEMO_SELECT page2 selected=' + selected.size);
          }, 1500);
        }, 1500);
      }
    }, 2500);
  };
  start();
})();

if (!/[#&]demo=/.test(location.hash || '')) {
  // Surface a boot-time auth failure instead of silently swallowing it (L6).
  refreshAuth().catch((e) => toast(e.message || 'Could not check sign-in status.', 'err'));
}
