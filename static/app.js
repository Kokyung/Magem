const $ = (id) => document.getElementById(id);
document.documentElement.classList.add(`platform-${window.mmf?.platform || "web"}`);
const PAGE = 60;          // image-relevance list page
const NAME_PAGE = 12;     // first page of the file & folder names list above the results (two rows)
const NAME_MORE = 24;
const VIA_KEY = { image: "via.scene", frame: "via.scene", audio: "via.audio", name: "via.name" };

// ---------- language ----------
// UI text comes from i18n.js; error messages from the engine and the toasts below stay in English.
let lang = "en";
function t(key, vars = {}) {
  const s = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return typeof s === "string" ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}
const num = (n) => Number(n).toLocaleString(lang);

// UI settings live in the engine: this page's address (a random port) changes every launch, so the
// browser's own storage would come back empty. Loaded once at startup (see the end of this file).
const prefs = {};
let prefsLoaded = false;
const store = {
  get: (key, fallback) => (key in prefs ? prefs[key] : fallback),
  set(key, value) {
    prefs[key] = value;
    post("/api/prefs", { key, value }).catch(() => {});
  },
};

const newList = () => ({ results: [], total: 0, offset: 0 });
const state = {
  type: "all", audio: true, query: "", imageBlob: null, similarVid: null, similarExclude: null,
  lists: {},            // "main"; a text search also has "name" (file & folder names, shown above it)
  expanded: false,      // user paged a list: don't auto-refresh under them
  seq: 0, hasIndex: false, hasFolders: false, progress: null,
  viewer: { list: null, index: -1 },
  searching: 0,         // seq of an image search still waiting for its first page (shows placeholders)
  after: null, before: null, // capture-date range (ms), from the date filter
  loadedInput: -1,      // the search input the results on screen belong to
};

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

function toast(msg, ms = 2600) { showToast($("toast"), msg, ms); }
const TOAST_FADE_MS = 250; // the transition in CSS
/**
 * Fades a toast element in; after `ms` it fades out (both moving up, in CSS). A different message over a
 * showing one waits for that one to fade out, so every message fades in; the same one just stays longer.
 */
function showToast(el, msg, ms) {
  clearTimeout(el._t);
  if (el.classList.contains("show") && el.textContent !== msg) hideToast(el);
  if (el.classList.contains("leaving")) {
    el._t = setTimeout(() => { settleToast(el); showToast(el, msg, ms); }, TOAST_FADE_MS);
    return;
  }
  el.textContent = msg;
  el.classList.add("show");
  el._t = setTimeout(() => hideToast(el), ms);
}
function hideToast(el) {
  clearTimeout(el._t);
  if (!el.classList.contains("show")) return;
  el.classList.replace("show", "leaving");
  el._t = setTimeout(() => settleToast(el), TOAST_FADE_MS);
}
/** Back below at once, unseen, so the next message rises from there too. */
function settleToast(el) {
  el.style.transition = "none";
  el.classList.remove("leaving");
  void el.offsetWidth;
  el.style.transition = "";
}

const fmtTime = (s) => {
  if (s == null) return "";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
/** A moment in the UI language: just the time if it was today, otherwise date and time. */
function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(lang, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(d);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Escape text and mark the query's words in it. */
function highlight(text, query) {
  const words = [...new Set(query.split(/\s+/).filter((w) => w.length >= 2))]
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
}

// ---------- search ----------
const isTextQuery = () => !!state.query && !state.imageBlob && state.similarVid == null;
const hasDates = () => state.after != null || state.before != null;
// a date range alone also shows results: the files taken in it, newest first
const isActive = () => !!(state.query || state.imageBlob || state.similarVid != null || hasDates());

function baseParams(limit, offset) {
  const p = new URLSearchParams({ type: state.type, audio: state.audio ? "1" : "0", limit, offset });
  if (state.after != null) p.set("after", state.after);
  if (state.before != null) p.set("before", state.before);
  return p;
}

/** Re-run the whole search (append=false) or fetch the next page of one list. */
async function runSearch(append = null) {
  const seq = ++state.seq;
  const input = inputSeq;
  if (!append) state.expanded = false;
  // a new image search waits on the image model: placeholders instead of the previous results
  // (not for the automatic refreshes while indexing, which keep the same input)
  if (!append && (state.imageBlob || state.similarVid != null) && state.loadedInput !== input) {
    state.lists = {};
    state.searching = seq;
    render();
  }
  try {
    if (state.imageBlob) {
      await loadMain(seq, append, (p) => {
        withRefinement(p);
        return api(`/api/search_image?${p}`, { method: "POST", body: state.imageBlob });
      });
    } else if (state.similarVid != null) {
      await loadMain(seq, append, (p) => {
        withRefinement(p);
        p.set("vid", state.similarVid);
        if (state.similarExclude != null) p.set("exclude", state.similarExclude);
        return api(`/api/similar?${p}`);
      });
    } else if (state.query) {
      await loadText(seq, append);
    } else if (hasDates()) {
      await loadMain(seq, append, (p) => api(`/api/by_date?${p}`));
    } else {
      state.lists = {};
      render();
    }
    if (seq === state.seq) state.loadedInput = input;
  } catch (e) {
    if (seq === state.seq) toast(`Search failed: ${e.message}`);
  } finally {
    if (state.searching === seq) {
      state.searching = 0;
      if (!state.lists.main) render(); // failed: drop the placeholders
    }
  }
}

/** Text typed during an image search narrows it ("this photo + night"). */
function withRefinement(p) {
  if (state.query) p.set("q", state.query);
}

async function loadMain(seq, append, fetchPage) {
  const list = append ? state.lists.main : newList();
  const data = await fetchPage(baseParams(PAGE, append ? list.offset : 0));
  if (seq !== state.seq) return; // a newer search superseded this one
  if (!append) state.lists = { main: list };
  list.results = list.results.concat(data.results);
  list.total = data.total;
  list.offset = list.results.length;
  render();
}

/** A text search: files whose name matches, then everything else (in one request); appendKey pages one of them. */
async function loadText(seq, appendKey) {
  const p = baseParams(appendKey === "name" ? NAME_MORE : PAGE, appendKey ? state.lists[appendKey].offset : 0);
  p.set("q", state.query);
  if (appendKey) p.set("section", appendKey);
  else p.set("nameLimit", NAME_PAGE);
  const lists = await api(`/api/search?${p}`);
  if (seq !== state.seq) return;
  if (!appendKey) state.lists = {};
  for (const [key, data] of Object.entries(lists)) {
    const list = appendKey ? state.lists[key] : newList();
    list.results = list.results.concat(data.results);
    list.total = data.total;
    list.offset = list.results.length;
    state.lists[key] = list;
  }
  render();
}

function render() {
  const active = isActive();
  updateSelectAll();
  updateHome();
  const box = $("results");
  box.innerHTML = "";
  if (!active) { $("summary").textContent = ""; return; }
  hideBoot();
  syncSelection(`results ${inputSeq} ${state.type} ${state.audio} ${state.after} ${state.before}`); // the filters change what is shown
  keepSelected(Object.values(state.lists).flatMap((l) => l.results));
  if (state.searching === state.seq && !state.lists.main) { // only the latest search: a superseded one doesn't count
    $("summary").innerHTML = `<span class="sk sk-line"></span>`;
    box.appendChild(skeletonGrid(12));
    return;
  }

  const { name, main } = state.lists;
  if (isTextQuery()) {
    // files whose name or folder matches first, then everything else, each under its heading
    const label = withRange(t("summary.query", { q: state.query }));
    const total = (name?.total || 0) + (main?.total || 0);
    $("summary").textContent = total ? t("summary.count", { label, n: num(total) }) : t("summary.none", { label });
    if (name?.total) box.appendChild(resultSection("name", name, "name"));
    if (main?.total) box.appendChild(resultSection("main", main, "scene"));
    return;
  }
  if (main) {
    const byImage = state.imageBlob || state.similarVid != null;
    const label = state.imageBlob ? t("summary.byImage") : t("summary.similar");
    const shown = !byImage ? rangeLabel() : withRange(state.query ? t("summary.imagePlus", { q: state.query }) : label);
    $("summary").textContent = main.total ? t("summary.count", { label: shown, n: num(main.total) }) : t("summary.none", { label: shown });
    box.appendChild(listBlock("main", main));
  }
}

/** The chosen capture-date range, as shown in the summary ("Jul 1, 2025 ~ Aug 31, 2025", "~ Aug 31, 2025"). */
function rangeLabel() {
  const day = (ms) => new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(ms));
  return `${state.after != null ? day(state.after) : ""} ~ ${state.before != null ? day(state.before - 1) : ""}`.trim();
}
const withRange = (label) => (hasDates() ? `${label} / ${rangeLabel()}` : label);

/** A headed block of results (heading key: sec.<name>.title). */
function resultSection(key, list, heading) {
  const sec = document.createElement("section");
  sec.className = "result-section";
  sec.innerHTML = `<header><h2>${esc(t(`sec.${heading}.title`))}<span class="count">${num(list.total)}</span></h2></header>`;
  sec.appendChild(listBlock(key, list));
  return sec;
}

/** Grid of tiles plus its "show more" button. */
function listBlock(key, list) {
  const wrap = document.createDocumentFragment();
  const grid = document.createElement("div");
  grid.className = "grid";
  list.results.forEach((r, i) => grid.appendChild(tile(r, list, i)));
  wrap.appendChild(grid);
  const more = document.createElement("div");
  more.className = "more";
  if (list.offset < list.total) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = t("more", { n: num(list.total - list.offset) });
    b.onclick = () => { state.expanded = true; runSearch(key); };
    more.appendChild(b);
  }
  if (more.childElementCount) wrap.appendChild(more);
  return wrap;
}

function tile(r, list, i) {
  const b = document.createElement("button");
  b.className = "tile";
  b.title = r.path;
  let badges = "";
  if (r.kind === "video") {
    const icon = r.via === "audio" ? "🔊" : "▶";
    if (r.t != null) badges += `<span class="badge tl">${icon} ${fmtTime(r.t)}</span>`;
    if (r.duration) badges += `<span class="badge tr">${fmtTime(r.duration)}</span>`;
  }
  // name hits show the matched text on the tile; others show the file name on hover
  const caption = r.text
    ? `<span class="caption"><span>${highlight(r.text.replace(/\s*\n\s*/g, " · "), state.query)}</span></span>`
    : `<span class="name">${esc(r.name)}</span>`;
  b.dataset.id = r.id;
  b.innerHTML = `<img loading="lazy" src="/thumb/${esc(r.thumb)}" alt="">${badges}${caption}`
    + `<span class="check" role="checkbox" aria-label="${esc(t("select"))}"></span>`;
  b.classList.toggle("selected", selection.ids.has(r.id));
  b.querySelector(".check").setAttribute("aria-checked", selection.ids.has(r.id));
  const check = b.querySelector(".check");
  check.onmousedown = (e) => beginDragSelect(e, b); // toggles this tile; dragging extends to the tiles passed over
  check.onclick = (e) => e.stopPropagation();
  b.onclick = () => {
    if (suppressTileClick) return; // the end of a checkbox sweep, not a click on the picture
    commitRecent();
    openViewer(list, i);
  };
  // dragged onto the search box: search with this file's vector instead of downloading its thumbnail
  // dragged out: the main process starts a native drag carrying the files themselves (to Finder, File Explorer,
  // mail, a web page…); a selected tile takes the whole selection along
  b.ondragstart = (e) => {
    e.preventDefault();
    const ids = selection.ids.has(r.id) && selection.ids.size > 1 ? [...selection.ids] : [r.id];
    if (ids.length > MAX_COPY) return toast(t("toast.tooMany", { max: num(MAX_COPY), n: num(ids.length) }), 4000);
    outgoingDrag = { r };
    window.mmf.startFileDrag(ids, r.thumb);
  };
  b.oncontextmenu = (e) => { e.preventDefault(); fileMenu(e, r); };
  return b;
}

/** Grey tiles that stand in for results that are still loading. */
function skeletonGrid(n) {
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.setAttribute("aria-hidden", "true");
  for (let i = 0; i < n; i++) {
    const el = document.createElement("div");
    el.className = "tile sk";
    grid.appendChild(el);
  }
  return grid;
}

// the results bar (count, select-all) sticks under the header, whose height changes when it wraps
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--top-height", `${entry.target.offsetHeight}px`);
}).observe(document.querySelector(".top"));

// the start screen's placeholders, until the first status and folder listing arrive
$("bootGrid").appendChild(skeletonGrid(14));
let booting = true;
function hideBoot() {
  if (!booting) return;
  booting = false;
  $("bootSkeleton").remove();
}

// ---------- selection & context menus ----------
// Selection belongs to what is on screen (one search, or one folder): it is cleared when that changes.
const selection = { ids: new Set(), key: "" };
function syncSelection(key) {
  if (selection.key === key) return;
  selection.key = key;
  clearSelection();
}
/** Drop selected files that are no longer listed (e.g. deleted outside the app), so they can't be copied blind. */
function keepSelected(items) {
  if (!selection.ids.size) return;
  const listed = new Set(items.map((r) => r.id));
  let changed = false;
  for (const id of selection.ids) if (!listed.has(id)) { selection.ids.delete(id); changed = true; }
  if (changed) updateSelection();
}
function toggleSelected(id) {
  if (!selection.ids.delete(id)) selection.ids.add(id);
  updateSelection();
}
function clearSelection() {
  if (!selection.ids.size) return;
  selection.ids.clear();
  updateSelection();
}

/** Files the select-all toggle covers: what is loaded on screen, up to each "show more" button. */
function selectableOnScreen() {
  if (isActive()) return Object.values(state.lists).flatMap((l) => l.results);
  return browse.data ? browse.data.files.slice(0, browse.shown).filter((f) => f.indexed) : [];
}
function updateSelectAll() {
  const items = selectableOnScreen();
  // anything selected → clicking clears it; nothing selected → it selects everything on screen
  const all = items.length > 0 && items.every((r) => selection.ids.has(r.id));
  const checked = all ? "true" : selection.ids.size ? "mixed" : "false";
  const active = isActive();
  for (const [id, shown] of [["resultsSelectAll", active], ["browseSelectAll", !active]]) {
    $(id).setAttribute("aria-checked", checked);
    $(id).classList.toggle("hidden", !shown || !items.length);
  }
}
function toggleSelectAll() {
  if (selection.ids.size) selection.ids.clear();
  else for (const r of selectableOnScreen()) selection.ids.add(r.id);
  updateSelection();
}
$("resultsSelectAll").onclick = toggleSelectAll;
$("browseSelectAll").onclick = toggleSelectAll;

function updateSelection() {
  updateSelectAll();
  document.body.classList.toggle("selecting", selection.ids.size > 0);
  for (const el of document.querySelectorAll(".tile[data-id]")) {
    const on = selection.ids.has(+el.dataset.id);
    el.classList.toggle("selected", on);
    el.querySelector(".check")?.setAttribute("aria-checked", on);
  }
}

// ---------- drag-select: press a tile's checkbox and sweep over other tiles ----------
// Like photo apps, the sweep covers every tile between the first and the current one in reading order
// (within that grid). It adds when the first tile was unselected, and removes when it was selected.
let dragSel = null;
let suppressTileClick = false;
function beginDragSelect(e, tileEl) {
  if (e.button !== 0) return;
  e.preventDefault(); // no native image drag or text selection
  e.stopPropagation();
  // ids, not elements: indexing refreshes may redraw the grid in the middle of a sweep
  const ids = [...tileEl.parentElement.querySelectorAll(".tile[data-id]")].map((el) => +el.dataset.id);
  const anchor = ids.indexOf(+tileEl.dataset.id);
  dragSel = {
    ids, anchor, current: anchor, moved: false, x: e.clientX, y: e.clientY,
    adding: !selection.ids.has(+tileEl.dataset.id), before: new Set(selection.ids), raf: 0,
  };
  document.body.classList.add("drag-selecting");
  applyDragSelect();
  window.addEventListener("mousemove", moveDragSelect);
  window.addEventListener("mouseup", endDragSelect, { once: true });
  window.addEventListener("blur", endDragSelect, { once: true });
  dragSel.raf = requestAnimationFrame(autoScrollDragSelect);
}
function applyDragSelect() {
  const { ids, anchor, current, adding, before } = dragSel;
  selection.ids.clear();
  for (const id of before) selection.ids.add(id);
  for (let i = Math.min(anchor, current); i <= Math.max(anchor, current); i++) {
    if (adding) selection.ids.add(ids[i]); else selection.ids.delete(ids[i]);
  }
  updateSelection();
}
function pickDragTile() {
  const el = document.elementFromPoint(dragSel.x, dragSel.y)?.closest(".tile[data-id]");
  const i = el ? dragSel.ids.indexOf(+el.dataset.id) : -1;
  if (i >= 0 && i !== dragSel.current) {
    dragSel.current = i;
    dragSel.moved = true;
    applyDragSelect();
  }
}
function moveDragSelect(e) {
  dragSel.x = e.clientX;
  dragSel.y = e.clientY;
  pickDragTile();
}
/** Near the top (below the sticky header) or bottom edge, scroll so the sweep can continue. */
function autoScrollDragSelect() {
  if (!dragSel) return;
  const top = document.querySelector(".top").getBoundingClientRect().bottom + 40;
  const bottom = innerHeight - 40;
  const dy = dragSel.y < top ? -(top - dragSel.y) / 3 : dragSel.y > bottom ? (dragSel.y - bottom) / 3 : 0;
  if (dy) { window.scrollBy(0, Math.max(-30, Math.min(30, dy))); pickDragTile(); }
  dragSel.raf = requestAnimationFrame(autoScrollDragSelect);
}
function endDragSelect() {
  if (!dragSel) return;
  window.removeEventListener("mousemove", moveDragSelect);
  window.removeEventListener("mouseup", endDragSelect);
  window.removeEventListener("blur", endDragSelect);
  cancelAnimationFrame(dragSel.raf);
  document.body.classList.remove("drag-selecting");
  if (dragSel.moved) { suppressTileClick = true; setTimeout(() => { suppressTileClick = false; }); }
  dragSel = null;
}

const menu = $("contextMenu");
function openMenu(e, items) {
  menu.innerHTML = "";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = item.label;
    b.onclick = () => { closeMenu(); item.run(); };
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  // keep the whole menu on screen
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - height - 4))}px`;
}
function closeMenu() { menu.classList.add("hidden"); }
const menuOpen = () => !menu.classList.contains("hidden");
document.addEventListener("mousedown", (e) => { if (!menu.contains(e.target)) closeMenu(); });
document.addEventListener("scroll", closeMenu, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

/** "Error invoking remote method 'x': Error: msg" → "msg" */
const ipcMessage = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
const copyAction = (fn) => async () => {
  try { await fn(); toast(t("toast.copied")); } catch (e) { toast(`Couldn't copy: ${ipcMessage(e)}`, 4000); }
};

const MAX_COPY = 10000; // same limit as the main process and the engine

/** Right-click on a file. With other files selected, it joins the selection and the menu acts on all of them. */
function fileMenu(e, r) {
  if (selection.ids.size && !selection.ids.has(r.id)) { selection.ids.add(r.id); updateSelection(); }
  if (selection.ids.size > 1) {
    const ids = [...selection.ids];
    const copy = copyAction(async () => { await window.mmf.copyFiles(ids); clearSelection(); });
    return openMenu(e, [{
      label: t("menu.copyFile"),
      // over the limit: say so in the UI language and keep the selection (the main process rejects it anyway)
      run: () => (ids.length > MAX_COPY ? toast(t("toast.tooMany", { max: num(MAX_COPY), n: num(ids.length) }), 4000) : copy()),
    }]);
  }
  singleFileMenu(e, r);
}
function singleFileMenu(e, r) {
  openMenu(e, [
    { label: t("menu.revealFile"), run: () => window.mmf.reveal(r.id).catch((err) => toast(`Can't open: ${ipcMessage(err)}`)) },
    r.kind === "image" && { label: t("menu.copyImage"), run: copyAction(() => window.mmf.copyImage(r.id)) },
    { label: t("menu.copyFile"), run: copyAction(async () => {
      await window.mmf.copyFiles([r.id]);
      if (selection.ids.has(r.id)) clearSelection(); // copied the (single) selection
    }) },
    { label: t("menu.copyPath"), run: copyAction(() => window.mmf.copyPaths([r.id])) },
  ].filter(Boolean));
}

// ---------- viewer ----------
function openViewer(list, i) {
  const r = list.results[i];
  if (!r) return;
  state.viewer = { list, index: i };
  if ($("viewer").classList.contains("hidden")) wakeViewerControls(); // shown on opening, then they fade
  $("viewer").classList.remove("hidden");
  $("viewer").classList.toggle("is-video", r.kind === "video");
  $("vName").textContent = r.name;
  $("vPath").textContent = r.path;
  $("vScore").innerHTML = r.indexed === false ? `<span class="muted">${esc(t(r.failed ? "browser.failed" : "browser.pending"))}</span>`
    : r.percent == null ? ""
    : `<span class="muted">${esc(t("viewer.relevance"))}</span> ${r.percent}% · <span class="muted">${esc(t("viewer.foundBy", { via: t(VIA_KEY[r.via] || "via.scene") }))}</span>`;
  $("vSimilar").disabled = r.vid == null;
  $("vReveal").disabled = $("vOpen").disabled = r.id == null; // not indexed yet: the main process opens files by id
  $("vText").classList.toggle("hidden", !r.text);
  $("vText").innerHTML = r.text ? `<p class="small muted">${esc(t("viewer.location"))}</p><div class="matched">${highlight(r.text, state.query)}</div>` : "";

  const media = $("viewerMedia");
  clearViewerMedia();
  hideViewerToast();
  // The picture or video stays hidden behind a loading sign until it can show whole (decoded, or the
  // video's first frame), so it never draws in. A file the engine can't read at all says so instead.
  const loader = document.createElement("div");
  loader.className = "viewer-loader";
  const shown = (el) => { el.classList.remove("loading"); loader.remove(); };
  const unreadable = (el) => {
    if (el.isConnected) media.innerHTML = `<p class="viewer-unreadable">${esc(t("viewer.unreadable"))}</p>`;
  };
  if (r.kind === "image") {
    const img = new Image();
    img.draggable = false; // a left-button drag pans the picture
    img.className = "loading";
    img.onload = () => img.decode().catch(() => {}).then(() => shown(img));
    let fellBack = false;
    // readable but not by the browser (e.g. HEIC): its thumbnail, or a preview before it is indexed
    const fallback = r.thumb ? `/thumb/${r.thumb}` : r.id == null && !r.failed ? previewUrl(r) : null;
    img.onerror = async () => {
      if (fellBack || !fallback || !(await fileReadable(r))) return unreadable(img);
      if (!img.isConnected) return; // moved on meanwhile: no request for a picture nobody sees
      fellBack = true;
      img.src = fallback;
    };
    img.src = mediaUrl(r);
    media.append(img, loader);
    resetZoom(img);
  } else {
    resetZoom(null);
    const v = document.createElement("video");
    v.src = `${mediaUrl(r)}#t=${Math.max(0, (r.t || 0) - 0.5)}`;
    // The player's controls come on with the first frame: on while loading, its own spinner starts, and
    // (autoplay off) stays up to ~1.3 s past it, finishing its animation, over the shown video.
    v.controls = false;
    v.controlsList.add("nofullscreen"); // the viewer's own full screen button covers videos too
    // no ⋮ menu: with nothing left in it (download, speed, picture-in-picture) the player drops the button
    v.controlsList.add("nodownload", "noplaybackrate");
    v.disablePictureInPicture = true;
    // a click on the picture plays / pauses (clicks on the player's own controls don't arrive here)
    v.addEventListener("click", () => {
      const play = v.paused;
      if (play) v.play().catch(() => {}); else v.pause();
      flashPlayState(play);
    });
    v.autoplay = store.get("mmf.videoAutoplay", true) !== false;
    // Chromium's player with the default preload ("metadata") and no autoplay can leave its own loading
    // spinner stuck on over the paused video; buffering fully (a local file) never does.
    v.preload = "auto";
    v.className = "loading";
    v.addEventListener("loadeddata", () => { v.controls = true; shown(v); }, { once: true });
    // stalling mid-play or seeking: our sign again, over the player's own spinner
    const loading = () => { if (v.isConnected) media.append(loader); };
    v.addEventListener("waiting", loading);
    v.addEventListener("seeking", loading);
    // (not while the video is still hidden: opening at a moment seeks before its first frame shows)
    const loaded = () => { if (!v.classList.contains("loading")) loader.remove(); };
    for (const ev of ["playing", "canplay", "seeked"]) v.addEventListener(ev, loaded);
    v.onerror = async () => {
      if (!r.thumb || !(await fileReadable(r))) return unreadable(v);
      if (v.isConnected) media.innerHTML = `<div class="fallback"><img src="/thumb/${esc(r.thumb)}" alt=""><p>This format can't be played here.<br>Use “${esc(t("viewer.open"))}”.</p></div>`;
    };
    media.append(v, loader);
  }

  $("vFlash").classList.remove("show");
  const mom = $("vMoments");
  mom.innerHTML = "";
  if (r.kind === "video" && r.moments?.length) {
    mom.innerHTML = `<p class="small muted" style="margin:4px 0 8px">${esc(t("viewer.moments"))}</p>`;
    const g = document.createElement("div");
    g.className = "moments";
    r.moments.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "moment" + (m.t === r.t ? " on" : "");
      const icon = m.modality === "audio" ? "🔊 " : "";
      btn.innerHTML = `<img src="/thumb/${esc(m.thumb)}" alt=""><span>${icon}${fmtTime(m.t)}</span>`;
      if (m.text) btn.title = m.text;
      btn.onclick = () => {
        const v = media.querySelector("video");
        if (v) { v.currentTime = m.t; v.play(); }
        g.querySelectorAll(".moment").forEach((x) => x.classList.toggle("on", x === btn));
      };
      g.appendChild(btn);
    });
    mom.appendChild(g);
  }
}

/** Empty the picture area; a picture still loading (e.g. a preview being made) lets go of its request. */
function clearViewerMedia() {
  for (const img of $("viewerMedia").querySelectorAll("img")) img.removeAttribute("src");
  $("viewerMedia").innerHTML = "";
}

/** The file itself; one in the folder browser that isn't indexed yet has no id, only its path. */
const mediaUrl = (r) => (r.id == null ? `/media_path?path=${encodeURIComponent(r.path)}` : `/media/${r.id}`);

/** Whether the engine can read the file at all: missing or unreadable, or only a format the browser can't show. */
async function fileReadable(r) {
  try {
    const res = await fetch(mediaUrl(r), { headers: { Range: "bytes=0-0" } });
    await res.arrayBuffer(); // a read error mid-way drops the connection
    return res.ok;
  } catch { return false; }
}

/** The play or pause sign fades in and out over the middle of the picture. */
function flashPlayState(playing) {
  const el = $("vFlash");
  el.classList.toggle("paused", !playing);
  el.classList.remove("show");
  void el.offsetWidth; // restart the animation on a quick second click
  el.classList.add("show");
}

function closeViewer() {
  if (isViewerFullscreen()) document.exitFullscreen().catch(() => {});
  $("viewer").classList.add("hidden");
  clearViewerMedia();
  resetZoom(null);
  hideViewerToast();
  clearTimeout(wakeViewerControls._t);
  state.viewer = { list: null, index: -1 };
  if (browse.stale && !isActive()) loadBrowse(); // indexing moved on while it was open
}
const viewerResult = () => state.viewer.list?.results[state.viewer.index];

$("closeViewer").onclick = closeViewer;
const fileAction = (fn) => async () => {
  try { await fn(viewerResult().id); } catch (e) { toast(`Can't open: ${e.message}`); }
};
$("vReveal").onclick = fileAction(window.mmf.reveal);
$("vOpen").onclick = fileAction(window.mmf.openFile);
$("vSimilar").onclick = () => {
  const r = viewerResult();
  closeViewer();
  searchSimilar(r);
};

/** Search with an indexed file's own vector (the viewer's "Find similar", or a tile dropped on the search). */
function searchSimilar(r) {
  inputSeq++;
  hideRecent();
  state.imageBlob = null;
  state.similarVid = r.vid;
  state.similarExclude = r.id;
  state.query = "";
  $("q").value = "";
  history.replaceState(null, "", location.pathname);
  showQueryImage(`/thumb/${r.thumb}`); // the chosen picture becomes the search, like "search by image"
  runSearch();
  window.scrollTo({ top: 0 });
}

/** A short note over the bottom of the picture, e.g. "This is the first image." */
function viewerToast(msg) { showToast($("vToast"), msg, 1600); }
function hideViewerToast() { hideToast($("vToast")); }

// ---------- viewer zoom & pan (pictures only: a video's own controls take the clicks) ----------
// 100% is the picture fitted to the window, as it first shows.
const ZOOM_MIN = 10, ZOOM_MAX = 1000;
const zoom = { img: null, pct: 100, x: 0, y: 0, drag: null };
function applyZoom() {
  if (zoom.img) zoom.img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.pct / 100})`;
  $("vZoomReset").textContent = `${Math.round(zoom.pct)}%`;
}
function resetZoom(img) {
  Object.assign(zoom, { img, pct: 100, x: 0, y: 0, drag: null });
  $("vZoom").classList.toggle("hidden", !img); // full screen hides it in CSS
  applyZoom();
}
/** Zoom to `pct`, keeping what's at the centre of the picture area where it is (wherever the picture was moved). */
function setZoom(pct) {
  if (!zoom.img) return;
  pct = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct));
  const box = $("viewerMedia").getBoundingClientRect();
  const r = zoom.img.getBoundingClientRect();
  const k = pct / zoom.pct;
  zoom.x -= (box.left + box.width / 2 - (r.left + r.width / 2)) * (k - 1);
  zoom.y -= (box.top + box.height / 2 - (r.top + r.height / 2)) * (k - 1);
  zoom.pct = pct;
  applyZoom();
  wakeViewerControls(); // the zoom buttons show the new level
}
// Steps multiply rather than add, so each one feels the same at any size (+5 points at 800% is barely visible).
const zoomBy = (factor) => setZoom(zoom.pct * factor);
$("vZoomIn").onclick = () => zoomBy(1.05);
$("vZoomOut").onclick = () => zoomBy(1 / 1.05);
$("vZoomReset").onclick = () => { resetZoom(zoom.img); wakeViewerControls(); };

// A Mac trackpad's two-finger drag also arrives as wheel events: those pan, a mouse wheel zooms.
// Chromium gives no "device" field; a precise (trackpad) scroll has wheelDeltaY = -3 × deltaY, a wheel notch doesn't.
const isTrackpadScroll = (e) => window.mmf?.platform === "darwin"
  && (e.deltaX !== 0 || (e.wheelDeltaY !== 0 && Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 1));
// A wheel notch: ×1.1. A trackpad pinch (ctrlKey) sends many small events, so ×1.01 each.
$("viewerMedia").addEventListener("wheel", (e) => {
  if (!zoom.img || isViewerFullscreen()) return;
  e.preventDefault();
  if (!e.ctrlKey && isTrackpadScroll(e)) { // ctrlKey: a trackpad pinch, which zooms
    zoom.x -= e.deltaX;
    zoom.y -= e.deltaY;
    applyZoom();
  } else if (e.deltaY) {
    const factor = e.ctrlKey ? 1.01 : 1.1;
    zoomBy(e.deltaY < 0 ? factor : 1 / factor);
  }
}, { passive: false });

$("viewerMedia").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !zoom.img || e.target !== zoom.img || isViewerFullscreen()) return;
  zoom.drag = { id: e.pointerId, x: e.clientX - zoom.x, y: e.clientY - zoom.y };
  zoom.img.setPointerCapture(e.pointerId);
  zoom.img.classList.add("dragging");
});
$("viewerMedia").addEventListener("pointermove", (e) => {
  if (zoom.drag?.id !== e.pointerId) return;
  zoom.x = e.clientX - zoom.drag.x;
  zoom.y = e.clientY - zoom.drag.y;
  applyZoom();
});
const endDrag = (e) => {
  if (zoom.drag?.id !== e.pointerId) return;
  zoom.drag = null;
  zoom.img?.classList.remove("dragging");
};
$("viewerMedia").addEventListener("pointerup", endDrag);
$("viewerMedia").addEventListener("pointercancel", endDrag);

// ---------- viewer full screen ----------
const isViewerFullscreen = () => document.fullscreenElement === $("viewer");
$("vFullscreen").onclick = () => {
  if (isViewerFullscreen()) document.exitFullscreen().catch(() => {});
  else $("viewer").requestFullscreen().catch((e) => toast(`Can't go full screen: ${e.message}`));
};
// The ‹ ›, full-screen and zoom buttons fade out while the mouse rests (or is over the side panel), and come
// back when it moves over the picture or the picture zooms.
const IDLE_MS = 2000;
function wakeViewerControls() {
  clearTimeout(wakeViewerControls._t);
  $("viewer").classList.remove("idle");
  wakeViewerControls._t = setTimeout(() => {
    // not while the mouse is on them or the keyboard is on one (:focus-visible: a mouse click focuses them too)
    const inUse = ".viewer-fs:hover, .viewer-step:hover, .viewer-zoom:hover, .viewer-stage :focus-visible";
    if (!$("viewer").querySelector(inUse)) $("viewer").classList.add("idle");
  }, IDLE_MS);
}
document.querySelector(".viewer-stage").addEventListener("mousemove", wakeViewerControls);
// A click leaves focus on what it hit, and an arrow key then draws the keyboard focus ring on it. Our
// buttons give focus back (Space shouldn't press them again); the video keeps it for its own keys (Space,
// volume), with the ring hidden in CSS until Tab is used. The player's timeline keeps its pointer events
// to itself; letting go of it ends its pointer capture instead.
const stage = document.querySelector(".viewer-stage");
const afterPointer = () => {
  stage.classList.add("pointer-input");
  setTimeout(() => {
    const a = document.activeElement;
    if (stage.contains(a) && a.tagName !== "VIDEO") a.blur();
  });
};
for (const type of ["pointerup", "lostpointercapture"]) stage.addEventListener(type, afterPointer, true);
document.addEventListener("keydown", (e) => { if (e.key === "Tab") stage.classList.remove("pointer-input"); });
document.querySelector(".viewer-stage").addEventListener("focusin", (e) => { if (e.target.matches(":focus-visible")) wakeViewerControls(); });

// Entering or leaving (button, Esc, the OS): the picture back at its fitted size, the button's label to match.
document.addEventListener("fullscreenchange", () => {
  wakeViewerControls();
  if (zoom.img) resetZoom(zoom.img);
  $("vFullscreen").title = t(isViewerFullscreen() ? "viewer.exitFullscreen" : "viewer.fullscreen");
  // full screen shows only #viewer: the right-click menu and toasts move into it meanwhile
  (isViewerFullscreen() ? $("viewer") : document.body).append($("contextMenu"), $("toast"));
});

/** The previous (-1) or next (+1) item, from the arrow keys or the ‹ › buttons. */
function stepViewer(dir) {
  const { list, index } = state.viewer;
  if (!list) return;
  const next = index + dir;
  // past either end, stay put: reopening the same item would restart its video
  if (next < 0) viewerToast(t("viewer.first"));
  else if (next >= list.results.length) viewerToast(t("viewer.last"));
  else openViewer(list, next);
}
$("vPrev").onclick = () => stepViewer(-1);
$("vNext").onclick = () => stepViewer(1);

$("viewerMedia").oncontextmenu = (e) => {
  const r = viewerResult();
  if (!r || r.id == null) return; // its actions all need an indexed file
  e.preventDefault();
  singleFileMenu(e, r);
};

document.addEventListener("keydown", (e) => {
  // a confirm dialog owns the keyboard: Esc answers no, Enter presses the focused button
  if (!$("confirmModal").classList.contains("hidden")) {
    if (e.key === "Escape") closeConfirm(false);
    return;
  }
  // the backup modal owns the keyboard while it is open: Esc closes it once the job is over
  if (!$("jobModal").classList.contains("hidden")) {
    if (e.key === "Escape") closeIndexJob();
    return;
  }
  // any key dismisses an open menu (it acts on the file it was opened for, which arrows would change)
  if (menuOpen()) { closeMenu(); if (e.key === "Escape") return; }
  const { list } = state.viewer;
  if (!list) {
    if (e.key === "Escape") {
      if (selection.ids.size) clearSelection();
      else closeDrawers();
    }
    return;
  }
  if (e.key === "Escape") {
    // Esc in full screen only leaves full screen
    if (isViewerFullscreen()) document.exitFullscreen().catch(() => {});
    else closeViewer();
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault(); // not the focused video's own seek
    stepViewer(e.key === "ArrowRight" ? 1 : -1);
  }
});

// ---------- page scroll lock ----------
// While the viewer, a drawer or the backup modal is open, the page behind it doesn't scroll. The page's
// scrollbar width is measured before it goes away (the observer runs before the next paint).
const overlays = [$("viewer"), $("jobModal"), $("confirmModal"), ...document.querySelectorAll(".drawer")];
const overlayOpen = (el) => (el.classList.contains("drawer") ? el.classList.contains("open") : !el.classList.contains("hidden"));
function lockPageScroll() {
  const root = document.documentElement;
  const lock = overlays.some(overlayOpen);
  if (lock === root.classList.contains("scroll-lock")) return;
  if (lock) root.style.setProperty("--scrollbar-w", `${window.innerWidth - root.clientWidth}px`);
  root.classList.toggle("scroll-lock", lock);
}
const overlayObserver = new MutationObserver(lockPageScroll);
for (const el of overlays) overlayObserver.observe(el, { attributes: true, attributeFilter: ["class"] });

// ---------- results deleted outside the app ----------
// Coming back to the window, list again: the engine drops files deleted meanwhile from what it returns.
// Not while the user is paging or viewing (as with the refreshes during indexing); the next search covers that.
window.addEventListener("focus", () => {
  if (!isActive()) loadBrowse();
  else if (!state.expanded && !state.viewer.list) runSearch();
  autoIndex();
});

// Coming back to the window also picks up new and changed files, like a launch does: only when there are
// indexed folders, nothing is running, and not more than every 30 s (switching apps back and forth).
let lastAutoIndex = Date.now(); // the launch has just started a run
function autoIndex() {
  const s = lastStatus;
  if (!s?.folders.length || s.paused || s.progress.running || Date.now() - lastAutoIndex < 30000) return;
  lastAutoIndex = Date.now();
  post("/api/reindex").then(refreshStatus, () => {});
}

// ---------- folder browser (start screen) ----------
const BROWSE_PAGE = 200;
const browse = { path: store.get("mmf.browse", null), want: undefined, data: null, shown: BROWSE_PAGE, seq: 0, stale: false };
const SORT_KEY = "mmf.browseSort";
let browseSort = { key: "name", dir: "asc" };
function readBrowseSort() {
  const s = store.get(SORT_KEY, {});
  browseSort = { key: s?.key === "mtime" ? "mtime" : "name", dir: s?.dir === "desc" ? "desc" : "asc" };
  $("sortKey").value = browseSort.key;
  updateSortDir();
}

/** Folders and files are ordered here, so changing the order doesn't need a round trip to the engine. */
function sortBrowse(d) {
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
  const sign = browseSort.dir === "desc" ? -1 : 1;
  const byName = (a, b) => collator.compare(a.name.normalize("NFC"), b.name.normalize("NFC"));
  const cmp = browseSort.key === "mtime"
    ? (a, b) => sign * ((a.mtime || 0) - (b.mtime || 0)) || byName(a, b)
    : (a, b) => sign * byName(a, b);
  d.dirs.sort(cmp);
  d.files.sort(cmp);
}
function changeBrowseSort() {
  browseSort = { key: $("sortKey").value, dir: browseSort.dir };
  updateSortDir();
  store.set(SORT_KEY, browseSort);
  if (!browse.data) return;
  sortBrowse(browse.data);
  renderBrowse();
}
$("sortKey").onchange = changeBrowseSort;
$("sortDir").onclick = () => { browseSort.dir = browseSort.dir === "asc" ? "desc" : "asc"; changeBrowseSort(); };
/** The icon shows the current order; screen readers get its name (no hover tooltip). */
function updateSortDir() {
  const b = $("sortDir");
  b.classList.toggle("desc", browseSort.dir === "desc");
  b.setAttribute("aria-label", `${t("browser.sortBy")}: ${t(browseSort.dir === "desc" ? "sort.desc" : "sort.asc")}`);
}

function updateHome() {
  const home = !isActive();
  $("hint").classList.toggle("hidden", !home || !state.hasIndex);
  const show = home && state.hasFolders; // before anything is indexed too: the files can be looked at meanwhile
  const wasHidden = $("browser").classList.contains("hidden");
  $("browser").classList.toggle("hidden", !show);
  if (show && wasHidden) loadBrowse();
}

// p left out: the folder asked for last, not the one on screen (a refresh while another folder is still
// loading would otherwise ask for the old one again, and its answer would replace the new one)
async function loadBrowse(p = browse.want !== undefined ? browse.want : browse.path) {
  if (!prefsLoaded) return; // the saved folder isn't known yet; startup loads it afterwards
  browse.stale = false;
  browse.want = p;
  const seq = ++browse.seq;
  let d;
  try {
    d = await api(`/api/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`);
  } catch {
    if (p && seq === browse.seq) loadBrowse(null); // folder gone, removed or excluded: back to the top
    else hideBoot();
    return;
  }
  if (seq !== browse.seq) return;
  if (d.path !== browse.path) browse.shown = BROWSE_PAGE;
  browse.path = d.path;
  sortBrowse(d);
  browse.data = d;
  store.set("mmf.browse", d.path);
  renderBrowse();
}

function renderBrowse() {
  const d = browse.data;
  hideBoot();
  updateSelectAll();
  // the browser also re-renders while hidden behind search results (a late listing, a language change):
  // the selection then belongs to the results, so leave it alone
  if (!isActive()) {
    syncSelection(`folder ${d.path}`);
    keepSelected(d.files.slice(0, browse.shown).filter((f) => f.indexed)); // only what is on screen (e.g. after re-sorting)
  }
  const crumbs = $("crumbs");
  crumbs.innerHTML = "";
  const crumb = (label, p, current) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (current) b.setAttribute("aria-current", "page");
    b.onclick = () => loadBrowse(p);
    crumbs.appendChild(b);
  };
  crumb(t("browser.root"), null, !d.path);
  if (d.path) {
    const parts = d.path.slice(d.root.length).split(/[\\/]/).filter(Boolean);
    crumbs.append("›");
    crumb(d.root.split(/[\\/]/).filter(Boolean).pop() || d.root, d.root, !parts.length);
    let acc = d.root;
    parts.forEach((part, i) => {
      acc = acc.replace(/[\\/]$/, "") + (d.root.includes("\\") ? "\\" : "/") + part;
      crumbs.append("›");
      crumb(part.normalize("NFC"), acc, i === parts.length - 1);
    });
  }

  const dirs = $("dirList");
  dirs.innerHTML = "";
  for (const dir of d.dirs) {
    const b = document.createElement("button");
    b.title = dir.path;
    b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><span class="dn">${esc(dir.name)}</span><span class="dc">${num(dir.count)}</span>`;
    b.onclick = () => loadBrowse(dir.path);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e, [{ label: t("menu.revealFolder"), run: () => window.mmf.revealFolder(dir.path).catch((err) => toast(`Can't open: ${ipcMessage(err)}`)) }]);
    };
    dirs.appendChild(b);
  }

  const indexed = d.files.filter((f) => f.indexed);
  // the viewer goes through every file here, those not indexed yet too (shown from the file itself)
  const list = { results: d.files };
  const grid = $("browseGrid");
  grid.innerHTML = "";
  previewObserver.disconnect(); // the tiles it watched are gone
  d.files.slice(0, browse.shown).forEach((f, i) => {
    if (f.indexed) {
      grid.appendChild(tile(f, list, i));
    } else {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "tile pending";
      el.title = f.path;
      el.innerHTML = `<div><b>${esc(f.name)}</b>${esc(t(f.failed ? "browser.failed" : "browser.pending"))}</div>`;
      el.onclick = () => openViewer(list, i);
      if (!f.failed) { el._file = f; previewObserver.observe(el); } // the engine couldn't read it: no picture either
      grid.appendChild(el);
    }
  });
  const more = $("browseMore");
  more.innerHTML = "";
  if (d.files.length > browse.shown) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = t("more", { n: num(d.files.length - browse.shown) });
    b.onclick = () => { browse.shown += BROWSE_PAGE; renderBrowse(); };
    more.appendChild(b);
  }
  pumpPreviews(); // lets go of the previews the old tiles were waiting for
  const imgs = indexed.filter((f) => f.kind === "image").length;
  const pending = d.files.filter((f) => !f.indexed && !f.failed).length;
  const failed = d.files.filter((f) => f.failed).length;
  $("browseNote").textContent = !d.path ? ""
    : !d.files.length && !d.dirs.length ? t("browser.empty")
    : d.files.length ? [t("count.photos", { n: num(imgs) }), t("count.videos", { n: num(indexed.length - imgs) }),
      pending && t("count.pending", { n: num(pending) }), failed && t("count.failed", { n: num(failed) })].filter(Boolean).join(" / ") : "";
}

// ---------- previews of files not indexed yet ----------
// The engine makes these on request, so only tiles on (or near) the screen ask, a few at a time: the page
// has six connections to the engine, and searches and the status line need theirs meanwhile. A tile that
// leaves the page (another folder, or drawn again) lets go of its request, and the engine then skips it.
const PREVIEW_PARALLEL = 3;
const previewUrl = (f) => `/preview?path=${encodeURIComponent(f.path)}&m=${f.mtime}`; // a changed file: a new address
const previewQueue = [];
const previewLoading = new Set();
const previewObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    e.target._near = e.isIntersecting;
    if (e.isIntersecting && !e.target._queued) { e.target._queued = true; previewQueue.push(e.target); }
  }
  pumpPreviews();
}, { rootMargin: "200px" });
function pumpPreviews() {
  for (const job of previewLoading) if (!job.el.isConnected) job.ctl.abort();
  while (previewLoading.size < PREVIEW_PARALLEL && previewQueue.length) {
    const el = previewQueue.shift();
    el._queued = false;
    // scrolled past before its turn: it is queued again if it comes back into view
    if (el.isConnected && el._near) loadPreview(el);
  }
}
async function loadPreview(el) {
  const job = { el, ctl: new AbortController() };
  previewLoading.add(job);
  try {
    const url = previewUrl(el._file);
    const res = await fetch(url, { signal: job.ctl.signal });
    previewObserver.unobserve(el); // made, or the engine can't: either way, not asked again
    if (!res.ok) return;
    await res.blob(); // now in the browser's cache, where the picture below loads it from
    const img = new Image();
    img.alt = "";
    img.onload = () => {
      if (!el.isConnected) return;
      // the picture, still marked as waiting; the name on hover, as on indexed tiles
      el.classList.add("has-preview");
      el.replaceChildren(img, Object.assign(document.createElement("span"), { className: "badge tl", textContent: t("browser.pending") }),
        Object.assign(document.createElement("span"), { className: "name", textContent: el._file.name }));
    };
    img.src = url;
  } catch { /* let go of, or failed: the tile keeps its label */ }
  finally {
    previewLoading.delete(job);
    pumpPreviews();
  }
}

// ---------- recent searches ----------
const RECENT_KEY = "mmf.recent";
const RECENT_MAX = 10;
let recent = store.get(RECENT_KEY, []).filter((x) => typeof x === "string").slice(0, RECENT_MAX);
let recentCursor = -1;
let idleCommit;
let quietFocus = false; // the launch-time focus shouldn't pop the dropdown over the start screen

function addRecent(q) {
  q = q.trim();
  if (!q) return;
  recent = [q, ...recent.filter((x) => x !== q)].slice(0, RECENT_MAX);
  store.set(RECENT_KEY, recent);
  renderRecent();
}
/** Remember the current text query (on Enter, a chip, opening a result, or after a pause). */
function commitRecent() {
  clearTimeout(idleCommit);
  if (isTextQuery()) addRecent(state.query);
}

function renderRecent() {
  const box = $("recent");
  box.innerHTML = "";
  if (!recent.length) { hideRecent(); return; }
  const head = document.createElement("div");
  head.className = "recent-head";
  head.innerHTML = `<span>${esc(t("recent.title"))}</span>`;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "link";
  clear.textContent = t("recent.clearAll");
  clear.onclick = () => { recent = []; store.set(RECENT_KEY, recent); renderRecent(); $("q").focus(); };
  head.appendChild(clear);
  box.appendChild(head);
  const ul = document.createElement("ul");
  recent.forEach((q, i) => {
    const li = document.createElement("li");
    li.className = i === recentCursor ? "on" : "";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "recent-q";
    pick.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>${esc(q)}</span>`;
    pick.onclick = () => pickRecent(q);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "recent-del";
    del.title = t("recent.delete");
    del.setAttribute("aria-label", t("recent.deleteNamed", { q }));
    del.textContent = "×";
    del.onclick = () => {
      recent = recent.filter((x) => x !== q);
      store.set(RECENT_KEY, recent);
      recentCursor = -1;
      renderRecent();
      $("q").focus();
    };
    li.append(pick, del);
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function showRecent() {
  if (!recent.length || state.imageBlob || state.similarVid != null) return;
  recentCursor = -1;
  renderRecent();
  $("recent").classList.remove("hidden");
}
function hideRecent() {
  $("recent").classList.add("hidden");
  recentCursor = -1;
}
function pickRecent(q) {
  hideRecent();
  $("q").value = q;
  setQuery(q);
  commitRecent();
  $("q").blur();
}

// keep focus in the input while clicking inside the dropdown
$("recent").addEventListener("mousedown", (e) => e.preventDefault());
$("q").addEventListener("focus", () => { if (quietFocus) quietFocus = false; else showRecent(); });
$("q").addEventListener("click", () => { if ($("recent").classList.contains("hidden")) showRecent(); });
$("q").addEventListener("blur", hideRecent);
$("q").addEventListener("keydown", (e) => {
  const open = !$("recent").classList.contains("hidden");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open) { showRecent(); return; }
    e.preventDefault();
    const n = recent.length;
    recentCursor = e.key === "ArrowDown" ? (recentCursor + 1) % n : (recentCursor - 1 + n) % n;
    renderRecent();
  } else if (e.key === "Enter" && open && recentCursor >= 0) {
    e.preventDefault();
    pickRecent(recent[recentCursor]);
  } else if (e.key === "Escape" && open) {
    e.preventDefault();
    hideRecent();
  }
});

// ---------- query inputs ----------
let debounce;
$("q").addEventListener("input", () => {
  hideRecent();
  clearTimeout(debounce);
  clearTimeout(idleCommit);
  debounce = setTimeout(() => {
    setQuery($("q").value);
    idleCommit = setTimeout(commitRecent, 3000); // typed and paused: worth remembering
  }, 350);
});
$("searchForm").onsubmit = (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  hideRecent();
  setQuery($("q").value);
  commitRecent();
};

// bumped by every new search input, so slow work (a web image download) can tell it was superseded
let inputSeq = 0;

function setQuery(q) {
  inputSeq++;
  q = q.trim();
  state.query = q; // with an image in the search box, the text refines that image search
  const byImage = state.imageBlob || state.similarVid != null;
  history.replaceState(null, "", q && !byImage ? `?q=${encodeURIComponent(q)}` : location.pathname);
  runSearch();
}

const updatePlaceholder = () => {
  $("q").placeholder = t($("queryImage").classList.contains("hidden") ? "search.placeholder" : "search.placeholderImage");
};

function showQueryImage(src) {
  const thumb = $("queryImageThumb");
  if (thumb.src.startsWith("blob:")) URL.revokeObjectURL(thumb.src);
  thumb.src = src;
  $("queryImage").classList.remove("hidden");
  updatePlaceholder();
}

/** Back to the start screen: no text, no image, no open viewer. */
function goHome() {
  inputSeq++;
  clearTimeout(debounce);
  clearTimeout(idleCommit);
  closeViewer();
  hideRecent();
  clearImage(false);
  clearDates();
  state.query = "";
  $("q").value = "";
  history.replaceState(null, "", location.pathname);
  runSearch();
  window.scrollTo({ top: 0 });
}
$("homeBtn").onclick = goHome;

// ---------- capture-date range ----------
// The chosen days are local dates: the range runs from the start of the first to the end of the last.
const startOfDay = (value) => (value ? new Date(`${value}T00:00`).getTime() : null);
/**
 * Local midnight after the given day, made from the date's parts: where a clock change skips midnight
 * itself, the day's start comes out as 01:00, and adding a day to that would carry the hour along.
 */
function dayAfter(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime();
}
// The calendar behind the date button: a first click picks the first day, a second one the last (in either
// order), a preset picks both. Nothing changes until "Apply"; the filter itself is state.after / state.before.
const FIRST_YEAR = 1990; // capture dates before this are ignored by the engine too
const pad2 = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDay = (day) => new Date(`${day}T00:00`);
const addDays = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return isoDay(d); };
const cal = { open: false, from: null, to: null, hover: null, view: null }; // days as "YYYY-MM-DD"; view: the month shown
// the applied range as days: the last one is read 12 hours before state.before (a midnight a clock change
// skipped comes out as 01:00, so just before it can already be the next day)
const appliedFrom = () => (state.after != null ? isoDay(new Date(state.after)) : null);
const appliedTo = () => (state.before != null ? isoDay(new Date(state.before - 12 * 3600 * 1000)) : null);
const DATE_PRESETS = {
  "date.today": (today) => [today, today],
  "date.last7": (today) => [addDays(today, -6), today],
  "date.last30": (today) => [addDays(today, -29), today],
  "date.thisYear": (today) => [`${today.slice(0, 4)}-01-01`, today],
  "date.lastYear": (today) => [`${+today.slice(0, 4) - 1}-01-01`, `${+today.slice(0, 4) - 1}-12-31`],
};

function formatDays(a, b) {
  const f = new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" });
  return a === b ? f.format(parseDay(a)) : f.formatRange(parseDay(a), parseDay(b));
}
/** The applied range on the button (the icon alone when there is none). */
function renderDateButton() {
  const from = appliedFrom(), to = appliedTo();
  $("dateLabel").textContent = from || to ? formatDays(from ?? to, to ?? from) : "";
  $("dateBtn").classList.toggle("on", hasDates());
  $("dateClear").classList.toggle("hidden", !hasDates());
}
function clearDates() {
  state.after = state.before = null;
  renderDateButton();
  closeCalendar();
}
$("dateClear").onclick = () => { clearDates(); inputSeq++; runSearch(); };

/** The week's first day as the language has it (0 = Sunday). */
function firstWeekday() {
  try {
    const locale = new Intl.Locale(lang);
    return ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 7) % 7;
  } catch { return 0; }
}
function openCalendar() {
  closeMenu();
  cal.from = appliedFrom();
  cal.to = appliedTo();
  cal.hover = null;
  const shown = parseDay(cal.to ?? cal.from ?? isoDay(new Date()));
  cal.view = new Date(shown.getFullYear(), shown.getMonth(), 1);
  cal.open = true;
  $("datePop").classList.remove("hidden");
  $("dateBtn").setAttribute("aria-expanded", "true");
  renderCalendar();
  placeCalendar();
  ($("dateGrid").querySelector(".edge, .today") || $("dateGrid").querySelector("button:not(:disabled)"))?.focus();
}
function closeCalendar(focusButton = false) {
  if (!cal.open) return;
  cal.open = false;
  closeDropdown();
  $("datePop").classList.add("hidden");
  $("dateBtn").setAttribute("aria-expanded", "false");
  if (focusButton) $("dateBtn").focus();
}
function renderCalendar() {
  const today = isoDay(new Date());
  // the year and month lists, and the arrows (no month before FIRST_YEAR, none after this one)
  const year = $("dateYear"), month = $("dateMonth");
  const thisYear = new Date().getFullYear();
  if (year.options.length !== thisYear - FIRST_YEAR + 1) {
    year.replaceChildren(...Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => new Option(String(thisYear - i), String(thisYear - i))));
  }
  const monthName = new Intl.DateTimeFormat(lang, { month: "long" });
  month.replaceChildren(...Array.from({ length: 12 }, (_, m) => new Option(monthName.format(new Date(2000, m, 1)), String(m))));
  year.value = String(cal.view.getFullYear());
  month.value = String(cal.view.getMonth());
  syncDropdowns();
  $("datePrev").disabled = cal.view.getFullYear() === FIRST_YEAR && cal.view.getMonth() === 0;
  $("dateNext").disabled = cal.view.getFullYear() === thisYear && cal.view.getMonth() === new Date().getMonth();

  const first = firstWeekday();
  const weekdays = (width) => Array.from({ length: 7 }, (_, i) => // Jan 1 2023 was a Sunday
    new Intl.DateTimeFormat(lang, { weekday: width }).format(new Date(2023, 0, 1 + ((first + i) % 7))));
  let names = weekdays("short");
  if (names.some((name) => name.length > 4)) names = weekdays("narrow"); // e.g. Arabic: whole words, wider than a day
  const cells = names.map((name) => {
    const el = document.createElement("span");
    el.className = "wd";
    el.setAttribute("role", "columnheader");
    el.textContent = name;
    return el;
  });
  const start = new Date(cal.view);
  start.setDate(1 - ((start.getDay() - first + 7) % 7));
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = isoDay(d);
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.day = day;
    b.textContent = d.getDate();
    b.setAttribute("aria-label", new Intl.DateTimeFormat(lang, { dateStyle: "full" }).format(d));
    b.disabled = day > today; // nothing is captured in the future
    b.classList.toggle("out", d.getMonth() !== cal.view.getMonth());
    b.classList.toggle("today", day === today);
    cells.push(b);
  }
  $("dateGrid").replaceChildren(...cells);
  paintRange();

  // presets: the one that matches what is picked shows as chosen
  $("datePresets").replaceChildren(...Object.entries(DATE_PRESETS).map(([key, range]) => {
    const [a, b] = range(today);
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = t(key);
    el.setAttribute("aria-pressed", cal.from === a && (cal.to ?? cal.from) === b);
    el.onclick = () => pickDays(a, b);
    return el;
  }));
  $("dateSummary").textContent = !cal.from ? t("date.pickStart")
    : !cal.to ? `${formatDays(cal.from, cal.from)} – ${t("date.pickEnd")}`
    : formatDays(...[cal.from, cal.to].sort());
}
/** Under the button, moved sideways as far as needed to stay inside the window (it opens toward the inline end). */
function placeCalendar() {
  const pop = $("datePop");
  pop.style.transform = "";
  const r = pop.getBoundingClientRect();
  const shift = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
  if (shift) pop.style.transform = `translateX(${shift}px)`;
}
window.addEventListener("resize", () => { if (cal.open) placeCalendar(); });

/** Shade the range on the days shown: picked, or (first day picked) up to the day under the mouse. */
function paintRange() {
  const end = cal.to ?? cal.hover ?? cal.from;
  const [lo, hi] = cal.from && end ? [cal.from, end].sort() : [null, null];
  for (const b of $("dateGrid").querySelectorAll("button")) {
    const day = b.dataset.day;
    const inside = !!lo && day >= lo && day <= hi;
    b.classList.toggle("in", inside);
    b.classList.toggle("lo", day === lo);
    b.classList.toggle("hi", day === hi);
    b.classList.toggle("edge", day === cal.from || day === cal.to);
    b.setAttribute("aria-selected", inside);
  }
}

/** Pick a whole range (a preset) and show the month it ends in. */
function pickDays(from, to) {
  cal.from = from;
  cal.to = to;
  cal.hover = null;
  const shown = parseDay(to);
  cal.view = new Date(shown.getFullYear(), shown.getMonth(), 1);
  renderCalendar();
}
function showMonth(year, month) {
  cal.view = new Date(year, month, 1);
  renderCalendar();
}
$("dateBtn").onclick = () => (cal.open ? closeCalendar(true) : openCalendar());
$("datePrev").onclick = () => showMonth(cal.view.getFullYear(), cal.view.getMonth() - 1);
$("dateNext").onclick = () => showMonth(cal.view.getFullYear(), cal.view.getMonth() + 1);
$("dateYear").onchange = () => showMonth(+$("dateYear").value, cal.view.getMonth());
$("dateMonth").onchange = () => showMonth(cal.view.getFullYear(), +$("dateMonth").value);
$("dateGrid").onclick = (e) => {
  const day = e.target.closest("button")?.dataset.day;
  if (!day) return;
  if (!cal.from || cal.to) { cal.from = day; cal.to = null; } // a new range
  else [cal.from, cal.to] = [cal.from, day].sort(); // its last day (or, picked earlier, its first)
  cal.hover = null;
  const d = parseDay(day);
  if (d.getMonth() !== cal.view.getMonth()) cal.view = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar();
  $("dateGrid").querySelector(`[data-day="${day}"]`)?.focus();
};
$("dateGrid").onmouseover = (e) => {
  const day = e.target.closest("button:not(:disabled)")?.dataset.day;
  if (!cal.from || cal.to || !day || day === cal.hover) return;
  cal.hover = day;
  paintRange();
};
$("dateGrid").onmouseleave = () => { if (cal.hover) { cal.hover = null; paintRange(); } };
// arrows move between days (and on into the next or previous month)
$("dateGrid").onkeydown = (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  const day = document.activeElement?.dataset?.day;
  if (!step || !day) return;
  e.preventDefault();
  const rtl = document.documentElement.dir === "rtl" && Math.abs(step) === 1 ? -1 : 1;
  const next = addDays(day, step * rtl);
  if (next > isoDay(new Date()) || next < `${FIRST_YEAR}-01-01`) return;
  const d = parseDay(next);
  if (d.getMonth() !== cal.view.getMonth() || d.getFullYear() !== cal.view.getFullYear()) showMonth(d.getFullYear(), d.getMonth());
  $("dateGrid").querySelector(`[data-day="${next}"]`)?.focus();
};
$("dateReset").onclick = () => { cal.from = cal.to = cal.hover = null; renderCalendar(); };
$("dateCancel").onclick = () => closeCalendar(true);
$("dateApply").onclick = () => {
  const [from, to] = cal.from ? [cal.from, cal.to ?? cal.from].sort() : [null, null]; // one day picked: that day
  state.after = startOfDay(from);
  state.before = to ? dayAfter(to) : null; // the whole last day
  renderDateButton();
  closeCalendar(true);
  inputSeq++;
  runSearch();
};
// Esc closes it (and only it: not a drawer or the selection behind); so does a click elsewhere
$("datePop").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closeCalendar(true);
});
document.addEventListener("mousedown", (e) => {
  if (cal.open && !$("dateFilter").contains(e.target) && !e.target.closest(".dropdown-menu")) closeCalendar();
});
renderDateButton();

function setImage(blob) {
  inputSeq++;
  if (!blob || !blob.type.startsWith("image/")) return toast("Only image files can be searched");
  hideRecent();
  state.imageBlob = blob;
  state.similarVid = null;
  state.query = "";
  $("q").value = "";
  history.replaceState(null, "", location.pathname);
  showQueryImage(URL.createObjectURL(blob));
  runSearch();
}

/** Drop the image from the search box; any typed text stays as a plain text search. */
function clearImage(rerun = true) {
  state.imageBlob = null;
  state.similarVid = null;
  state.similarExclude = null;
  const thumb = $("queryImageThumb");
  if (thumb.src.startsWith("blob:")) URL.revokeObjectURL(thumb.src);
  thumb.removeAttribute("src");
  $("queryImage").classList.add("hidden");
  updatePlaceholder();
  if (rerun) {
    inputSeq++;
    history.replaceState(null, "", state.query ? `?q=${encodeURIComponent(state.query)}` : location.pathname);
    runSearch();
  }
}
$("clearImage").onclick = () => clearImage();
$("imageInput").onchange = (e) => { setImage(e.target.files[0]); e.target.value = ""; };

document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
  if (item) { e.preventDefault(); setImage(item.getAsFile()); }
});
let dragDepth = 0;
const DROP_TYPES = ["Files", "text/uri-list", "text/html"];
// the tile last dragged out as files: dropped back on this window, it searches with the file's own vector
// (like "Find similar") instead of uploading the file. Recognised by the dropped file's path, so another
// file that merely has the same name isn't mistaken for it, however long ago the drag was.
let outgoingDrag = null;
const samePath = (a, b) => !!a && !!b && a.normalize("NFC") === b.normalize("NFC");
document.addEventListener("dragenter", (e) => {
  if (DROP_TYPES.some((t) => e.dataTransfer.types.includes(t))) { dragDepth++; $("dropzone").classList.remove("hidden"); }
});
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").classList.add("hidden"); } });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropzone").classList.add("hidden");
  const files = [...e.dataTransfer.files];
  const own = outgoingDrag;
  if (own && files.some((f) => samePath(window.mmf.pathForFile?.(f), own.r.path))) {
    outgoingDrag = null;
    const { r } = own;
    // let go on the tile it came from: the drag was abandoned, not a search
    if (+e.target.closest?.(".tile[data-id]")?.dataset.id === r.id) return;
    if (r.vid != null) return searchSimilar(r);
    return setImageFromUrl(`/thumb/${r.thumb}`); // no picture vector (e.g. a silent, frameless video)
  }
  const f = files.find((x) => x.type.startsWith("image/")) || files[0];
  if (f) return setImage(f);
  const url = droppedImageUrl(e.dataTransfer);
  if (url) setImageFromUrl(url);
  else if (DROP_TYPES.some((type) => e.dataTransfer.types.includes(type))) toast("No image found in the dropped item");
});

/** An image dragged from a browser: prefer the <img> itself over the link it may be wrapped in. */
function droppedImageUrl(dt) {
  const html = dt.getData("text/html");
  if (html) {
    const src = new DOMParser().parseFromString(html, "text/html").querySelector("img[src]")?.getAttribute("src");
    if (src && /^(https?:|data:image\/)/i.test(src)) return src;
  }
  const uri = dt.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  if (uri && /^(https?:|data:image\/)/i.test(uri)) return uri;
  return null;
}

async function setImageFromUrl(url) {
  const seq = ++inputSeq;
  toast(t("toast.fetchingImage"));
  try {
    // data: URLs and our own pages are fetched directly (the engine's proxy has no session cookie, so its
    // own addresses would be refused); other sites go through the engine, as the page can't fetch them itself
    const local = url.startsWith("data:") || new URL(url, location.href).origin === location.origin;
    const res = local ? await fetch(url) : await fetch(`/api/fetch_image?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const blob = await res.blob();
    if (seq === inputSeq) setImage(blob); // otherwise the user has moved on to another search
  } catch (e) {
    if (seq === inputSeq) toast(`Couldn't fetch the image: ${e.message}`, 4000);
  }
}

function segment(id, attr, onPick) {
  $(id).onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onPick(b.dataset[attr]);
  };
}
segment("typeFilter", "type", (v) => { state.type = v; runSearch(); });
$("useAudio").onchange = (e) => { state.audio = e.target.checked; runSearch(); };

function renderExamples() {
  const box = $("examples");
  box.innerHTML = "";
  t("examples").forEach((q) => {
    const b = document.createElement("button");
    b.textContent = q;
    b.onclick = () => { $("q").value = q; setQuery(q); commitRecent(); };
    box.appendChild(b);
  });
}

// ---------- settings ----------
function initialLanguage() {
  const saved = store.get("mmf.lang", null);
  if (MESSAGES[saved]) return saved;
  return detectLanguage(window.mmf?.systemLanguages?.length ? window.mmf.systemLanguages : navigator.languages);
}

/** Put every piece of UI text in the current language (static markup and whatever is on screen). */
function applyLanguage(code) {
  lang = MESSAGES[code] ? code : "en";
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === "ar" ? "rtl" : "ltr";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml); // our own strings
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute("aria-label", el.title);
  }
  const platform = window.mmf?.platform;
  $("vReveal").textContent = t(platform === "darwin" ? "viewer.revealMac" : platform === "win32" ? "viewer.revealWin" : "viewer.revealLinux");
  $("jobReveal").textContent = $("vReveal").textContent;
  if (shownJob) renderIndexJob(shownJob);
  $("langSelect").value = lang;
  syncDropdowns(); // the selected value and the option text just changed
  updateSortDir();
  updatePlaceholder();
  renderExamples();
  renderRecent();
  render();
  if (browse.data) { sortBrowse(browse.data); renderBrowse(); }
  if (lastStatus) renderStatus(lastStatus);
  if (dlView) renderDownloads(dlView);
  renderDateButton();
  if (cal.open) renderCalendar();
  // once the saved language is known: the main process keeps these for a start without a window
  if (prefsLoaded) window.mmf?.setTrayLabels?.({
    open: t("tray.open"), settings: t("settings.title"), quit: t("tray.quit"), notice: t("tray.notice"), indexing: t("tray.indexing"),
    start: t("index.start"), pause: t("index.pause"),
    jobQuitBackup: t("backup.quitBackup"), jobQuitRestore: t("backup.quitRestore"), keepRunning: t("backup.cancel"),
  });
}

for (const [code, name] of LANGUAGES) $("langSelect").add(new Option(name, code));

// ---------- dropdowns ----------
// A styled <select>'s native pop-up drifts sideways on macOS (it lines its text up with the control's text, not
// with the box), so each one gets a button and a list of our own. The <select> stays the source of truth: the
// rest of the code keeps reading .value and listening for "change".
let openDropdown = null; // { select, button, list }
const dropdownSyncs = [];
/** Show each select's current option on its button; call after setting a value or option text from code. */
const syncDropdowns = () => dropdownSyncs.forEach((sync) => sync());
function enhanceSelect(select) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dropdown-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  select.after(button);
  select.hidden = true;
  const sync = () => { button.textContent = select.selectedOptions[0]?.textContent || ""; };
  dropdownSyncs.push(sync);
  select.addEventListener("change", sync);
  button.onclick = () => (openDropdown?.select === select ? closeDropdown() : showDropdown(select, button));
  button.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); showDropdown(select, button); }
  };
  sync();
}
function showDropdown(select, button) {
  closeDropdown();
  closeMenu();
  const list = document.createElement("div");
  list.className = "dropdown-menu";
  list.setAttribute("role", "listbox");
  for (const opt of select.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", opt.selected);
    item.textContent = opt.textContent;
    item.onclick = () => {
      closeDropdown();
      button.focus();
      if (select.value === opt.value) return;
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    list.appendChild(item);
  }
  list.onkeydown = (e) => {
    const items = [...list.children];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[Math.max(i - 1, 0)].focus(); }
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation(); // not the drawer's or the viewer's Esc
      closeDropdown();
      button.focus();
    }
  };
  document.body.appendChild(list);
  // right under the button, lined up with its edge (the far edge in right-to-left), kept on screen
  const r = button.getBoundingClientRect();
  list.style.minWidth = `${r.width}px`;
  const { width, height } = list.getBoundingClientRect();
  const left = document.documentElement.dir === "rtl" ? r.right - width : r.left;
  list.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
  list.style.top = `${r.bottom + 4 + height <= innerHeight - 4 ? r.bottom + 4 : Math.max(4, r.top - 4 - height)}px`;
  button.setAttribute("aria-expanded", "true");
  openDropdown = { select, button, list };
  const current = list.querySelector('[aria-selected="true"]') || list.firstElementChild;
  current?.focus();
  current?.scrollIntoView({ block: "nearest" });
}
function closeDropdown() {
  if (!openDropdown) return;
  openDropdown.list.remove();
  openDropdown.button.setAttribute("aria-expanded", "false");
  openDropdown = null;
}
document.addEventListener("mousedown", (e) => {
  if (openDropdown && !openDropdown.list.contains(e.target) && !openDropdown.button.contains(e.target)) closeDropdown();
});
document.addEventListener("scroll", (e) => { if (openDropdown && !openDropdown.list.contains(e.target)) closeDropdown(); }, true);
window.addEventListener("resize", closeDropdown);
window.addEventListener("blur", closeDropdown);
for (const select of document.querySelectorAll("select")) enhanceSelect(select);
$("langSelect").onchange = (e) => { store.set("mmf.lang", e.target.value); applyLanguage(e.target.value); };
$("themeSelect").onchange = (e) => {
  store.set("mmf.theme", e.target.value);
  window.mmf?.setTheme(e.target.value); // the main process switches the page's light/dark preference
};

/**
 * Startup and background options live in the main process (the OS login item, the tray), so ask it.
 * Called straight away rather than with the saved settings, which wait for the engine's model loading.
 */
async function loadAppSettings() {
  let s;
  try { s = await window.mmf.getAppSettings(); } catch { return; }
  const login = s.openAtLogin;
  $("startupRow").classList.toggle("hidden", !login.shown);
  $("startupCheck").disabled = !login.available; // development build: nothing to register
  $("startupNote").classList.toggle("hidden", login.available);
  showLoginItem(login);
  $("backgroundRow").classList.toggle("hidden", s.runInBackground == null);
  $("backgroundCheck").checked = !!s.runInBackground;
}
/** The login item as the OS has it; "Start in the background" belongs to it, so only shows while it's on. */
function showLoginItem({ enabled, hidden }) {
  $("startupCheck").checked = enabled;
  $("startHiddenRow").classList.toggle("hidden", !enabled || hidden == null);
  if (enabled && hidden != null) $("startHiddenCheck").checked = hidden; // while off, keep the choice for next time
}
async function setLoginItem(on) {
  try { showLoginItem(await window.mmf.setOpenAtLogin(on, $("startHiddenCheck").checked)); }
  catch (err) { toast(`Couldn't change the startup setting: ${err.message}`); loadAppSettings(); }
}
$("startupCheck").onchange = (e) => setLoginItem(e.target.checked);
$("startHiddenCheck").onchange = () => setLoginItem(true);
loadAppSettings();
$("autoplayCheck").onchange = (e) => store.set("mmf.videoAutoplay", e.target.checked);
$("backgroundCheck").onchange = (e) => {
  store.set("mmf.background", e.target.checked);
  window.mmf.setRunInBackground(e.target.checked);
};
window.mmf?.onOpenSettings?.(() => openDrawer("settings")); // "Settings" in the tray menu

// indexing performance: kept and applied by the engine
function showPerformance(p) {
  for (const r of document.querySelectorAll('input[name="perfMode"]')) r.checked = r.value === p.mode;
  for (const r of document.querySelectorAll('input[name="perfBackground"]')) r.checked = r.value === p.backgroundMode;
  $("perfBattery").checked = p.pauseOnBattery;
}
// saves go one at a time, each sending the form as it is by then, so the last change is the one kept;
// a load that started before a change doesn't paint over it. Until the saved setting has arrived the
// controls stay off: a change then would send the placeholder values of the other ones and replace it.
const perfInputs = document.querySelectorAll('input[name="perfMode"], input[name="perfBackground"], #perfBattery');
let perfLoaded = false;
let perfEdits = 0;
let perfSaving = Promise.resolve();
for (const el of perfInputs) el.disabled = true;
async function loadPerformance() {
  const edits = perfEdits;
  try {
    const p = await api("/api/performance");
    if (edits === perfEdits) showPerformance(p);
    perfLoaded = true;
    for (const el of perfInputs) el.disabled = false;
  } catch { /* tried again when the settings are opened */ }
}
function savePerformance() {
  const edit = ++perfEdits;
  perfSaving = perfSaving.then(async () => {
    const mode = document.querySelector('input[name="perfMode"]:checked')?.value;
    const backgroundMode = document.querySelector('input[name="perfBackground"]:checked')?.value;
    try { await post("/api/performance", { mode, backgroundMode, pauseOnBattery: $("perfBattery").checked }); }
    catch (err) {
      toast(`Couldn't change the performance setting: ${err.message}`);
      // show what the engine kept, unless a later change is on its way (it sends the whole form anyway)
      if (edit === perfEdits) loadPerformance();
    }
  });
}
for (const el of perfInputs) el.onchange = savePerformance;

// ---------- confirm dialog ----------
// In the app's own look rather than the system's. One at a time: a new one answers the previous one no.
let confirmDone = null;
/** Resolves true when `yes` is pressed, false on Cancel, Esc or a click beside the card. */
function confirmDialog(text, yes) {
  closeConfirm(false);
  closeMenu();
  $("confirmNo").classList.remove("hidden"); // a message's dialog hides it
  $("confirmText").textContent = text;
  $("confirmYes").textContent = yes;
  $("confirmModal").classList.remove("hidden");
  $("confirmNo").focus(); // Enter right away cancels: both questions replace or remove something
  return new Promise((resolve) => { confirmDone = resolve; });
}
function closeConfirm(answer) {
  if (!confirmDone) return;
  const done = confirmDone;
  confirmDone = null;
  $("confirmModal").classList.add("hidden");
  done(answer);
}
/** A message with only an OK button, in the same dialog. */
function alertDialog(text) {
  const done = confirmDialog(text, t("dl.ok"));
  $("confirmNo").classList.add("hidden");
  $("confirmYes").focus();
  return done;
}
$("confirmYes").onclick = () => closeConfirm(true);
$("confirmNo").onclick = () => closeConfirm(false);
$("confirmModal").onclick = (e) => { if (e.target === e.currentTarget) closeConfirm(false); };

// ---------- index backup / restore ----------
// The main process runs the job; this modal shows it until it ends (or is canceled), asking for its state.
let jobTimer = 0;
let shownJob = null;
async function pollIndexJob() {
  let job;
  try { job = await window.mmf.getIndexJob(); } catch { return; }
  renderIndexJob(job);
}
function renderIndexJob(job) {
  clearTimeout(jobTimer);
  shownJob = job;
  const modal = $("jobModal");
  if (!job || job.state === "canceled") {
    if (job && !modal.classList.contains("hidden")) toast(t("backup.canceled"));
    modal.classList.add("hidden");
    return;
  }
  const restore = job.kind === "restore";
  const running = job.state === "running";
  const done = job.state === "done";
  modal.classList.remove("hidden");
  closeMenu();
  $("jobSpinner").classList.toggle("hidden", !running && !(done && restore));
  $("jobTitle").textContent = t(running ? (restore ? "backup.restoring" : "backup.running")
    : done ? (restore ? "backup.restoreDone" : "backup.done")
    : restore ? "backup.restoreFailed" : "backup.failed");
  const end = job.finishedAt || Date.now();
  $("jobDetail").textContent = running
    // time left and progress, always both: placeholders until there is enough to estimate
    ? `${t("remaining", { time: jobSecondsLeft(job.progress) == null ? "--:--:--" : fmtTime(jobSecondsLeft(job.progress)) })}`
      + ` · ${job.progress?.total ? Math.min(99, Math.floor((job.progress.done / job.progress.total) * 100)) : 0}%`
    : done && !restore ? `${job.file}\n${t("backup.doneDetail", { time: fmtWhen(job.finishedAt), duration: fmtTime((end - job.startedAt) / 1000) })}`
    : done ? ""
    : job.error || ""; // errors stay in English
  $("jobCancel").classList.toggle("hidden", !running);
  $("jobClose").classList.toggle("hidden", running || (done && restore)); // a finished restore restarts the app
  $("jobReveal").classList.toggle("hidden", !(done && !restore));
  if (running) jobTimer = setTimeout(pollIndexJob, 500);
}
/** Seconds left from the pace since the archive (or the unpacking) started; null until a couple of seconds in. */
function jobSecondsLeft(pr) {
  if (!pr?.total || !pr.done || !pr.since) return null;
  const elapsed = Date.now() - pr.since;
  if (elapsed < 2000 || pr.done >= pr.total) return null;
  return ((pr.total - pr.done) * elapsed) / pr.done / 1000;
}

function closeIndexJob() {
  if (shownJob?.state === "running") return;
  shownJob = null; // dismissed: a language change mustn't bring it back
  $("jobModal").classList.add("hidden");
}
const startIndexJob = (start) => async () => {
  closeDrawers();
  try {
    if (await start()) pollIndexJob();
  } catch (e) { toast(ipcMessage(e), 4000); }
};
$("backupBtn").onclick = startIndexJob(() => window.mmf.startBackup(t("backup.pickFolder")));
$("restoreBtn").onclick = startIndexJob(async () => (await confirmDialog(t("backup.restoreConfirm"), t("backup.restore")))
  && window.mmf.startRestore(t("backup.pickFile")));
$("jobCancel").onclick = () => window.mmf.cancelIndexJob();
$("jobClose").onclick = closeIndexJob;
$("jobReveal").onclick = () => window.mmf.revealBackup();
window.mmf?.onIndexJob?.(renderIndexJob); // the end of a job, even if this page wasn't asking
// e.g. the window was reopened in the middle of a backup
window.mmf?.getIndexJob?.().then((job) => { if (job?.state === "running") renderIndexJob(job); }, () => {});

// ---------- drawers, folders & status ----------
function openDrawer(id) {
  if (id === "settings" && !perfLoaded) loadPerformance();
  closeDrawers();
  $(id).classList.add("open");
  $(id).setAttribute("aria-hidden", "false");
  $("scrim").classList.add("on");
}
function closeDrawers() {
  for (const d of document.querySelectorAll(".drawer")) { d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); }
  $("scrim").classList.remove("on");
}
$("openFolders").onclick = () => openDrawer("drawer");
$("openSettings").onclick = () => openDrawer("settings");
for (const b of document.querySelectorAll(".close-drawer")) b.onclick = closeDrawers;

// the indexed and excluded folders, both as a grid of cards or as a list
function applyFolderView(view) {
  for (const id of ["folders", "excludedList"]) $(id).classList.toggle("as-list", view === "list");
  for (const b of $("folderView").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.view === view);
    b.setAttribute("aria-pressed", b.dataset.view === view);
  }
}
for (const b of $("folderView").querySelectorAll("button")) {
  b.onclick = () => { store.set("mmf.folderView", b.dataset.view); applyFolderView(b.dataset.view); };
}
$("scrim").onclick = closeDrawers;

async function addFolder(path) {
  try {
    const r = await post("/api/folders", { path });
    toast(t("toast.indexing", { path: r.path }));
    refreshStatus();
    loadBrowse();
  } catch (e) { toast(e.message); }
}
async function pickFolder() {
  for (const p of await window.mmf.pickFolders(t("picker.add"))) await addFolder(p);
}
$("pickFolder").onclick = pickFolder;
$("pickExcluded").onclick = async () => {
  for (const p of await window.mmf.pickFolders(t("picker.exclude"))) {
    try {
      const r = await post("/api/excluded", { path: p });
      toast(t("toast.excluded", { name: r.path.split(/[\\/]/).pop(), n: num(r.removed) }));
    } catch (e) { toast(e.message, 4000); }
  }
  refreshStatus();
  if (isActive()) runSearch();
  loadBrowse();
};
$("welcomeAdd").onclick = () => { openDrawer("drawer"); pickFolder(); };
$("pathForm").onsubmit = (e) => {
  e.preventDefault();
  const p = $("pathInput").value.trim();
  if (p) { addFolder(p); $("pathInput").value = ""; }
};
// ▶ / ⏸ next to the status line: a pause holds (launches and coming back to the window don't restart it) until ▶
let pauseRequested = false; // shown at once, before the busy engine answers
$("indexToggle").onclick = async () => {
  const pausing = !!lastStatus?.progress.running;
  if (pausing) {
    pauseRequested = true;
    $("indexToggle").classList.add("pausing");
  }
  try { await post(pausing ? "/api/pause" : "/api/resume"); } catch (e) {
    pauseRequested = false;
    $("indexToggle").classList.remove("pausing");
    toast(e.message);
  }
  refreshStatus();
};

let lastDone = -1, wasRunning = false, lastStatus = null;
async function refreshStatus() {
  let s;
  try { s = await api("/api/status"); } catch {
    $("status").textContent = $("statusShort").textContent = "Can't connect to the engine";
    hideBoot();
    return;
  }
  const { progress: p, folders, stats } = s;
  lastStatus = s;
  state.progress = p;
  state.hasIndex = stats.images + stats.videos > 0;
  state.hasFolders = folders.length > 0;
  if (!state.hasIndex) hideBoot(); // otherwise the folder listing replaces the placeholders
  $("welcome").classList.toggle("hidden", folders.length > 0);
  updateHome();
  renderStatus(s);

  // refresh visible results as new files land in the index (not while the user is paging or viewing)
  const done = p.done;
  if ((p.running && Math.floor(done / 10) !== Math.floor(lastDone / 10)) || (wasRunning && !p.running)) {
    if (isActive() && !state.viewer.list && !state.expanded) runSearch();
    else if (!isActive()) { // new thumbnails / counts, and files no longer waiting
      if (state.viewer.list) browse.stale = true; // once the viewer closes
      else loadBrowse();
    }
  }
  lastDone = done;
  wasRunning = p.running;
}

/** The status details (opened from the ▶/⏸ button), one per line. */
function setStatusLines(lines) {
  $("status").replaceChildren(...lines.filter(Boolean).map((line) => {
    const el = document.createElement("div");
    el.append(line);
    return el;
  }));
}

/** Status line, progress bar and the folder drawer, drawn from the last /api/status answer. */
function renderStatus(s) {
  const { progress: p, folders, stats } = s;
  const toggle = $("indexToggle");
  toggle.classList.toggle("hidden", !folders.length);
  toggle.classList.toggle("running", p.running);
  // paused but still running = finishing the file in hand before it stops (the engine keeps both flags)
  if (!p.running) pauseRequested = false;
  toggle.classList.toggle("pausing", p.running && (!!s.paused || pauseRequested));
  toggle.setAttribute("aria-label", t(p.running ? "index.pause" : "index.start"));
  const counts = t("status.counts", { photos: num(stats.images), videos: num(stats.videos) });
  const eng = s.engine;
  const engLabel = eng.status === "ready" ? `${s.model} / ${eng.device in DEVICE_KEYS ? t(DEVICE_KEYS[eng.device]) : eng.device}`
    : eng.status === "error" ? "Model error" : t("engine.loading", { model: s.model });
  if (p.running) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const simple = s.held === "battery" ? t("status.battery")
      : p.phase === "scanning" ? t("phase.scanning")
      : p.phase === "loading-model" ? t("phase.loadingModel") : null;
    const main = simple ?? `${t(p.phase === "names" ? "phase.names" : p.phase === "dates" ? "phase.updating" : "phase.indexing")} ${num(p.done)}/${num(p.total)} (${pct}%)`;
    const cur = !simple && p.current ? p.current.split(/[\\/]/).pop() : "";
    // the time left for the whole run (file names and indexing together, estimated by the engine), in bold
    // right after what is being worked on
    const eta = s.eta != null ? t("eta", { time: fmtTime(s.eta) }) : "";
    toggle.style.setProperty("--pct", pct);
    $("statusShort").textContent = simple ?? `${pct}%`;
    setStatusLines([main, eta && Object.assign(document.createElement("b"), { textContent: eta }),
      // the file in hand: under "Indexing 12/300" it needs no label of its own
      cur && Object.assign(document.createElement("span"), { className: "status-file", textContent: cur }), counts]);
    $("progress").classList.remove("hidden");
    $("progressBar").style.width = `${pct}%`;
  } else {
    const done = s.paused ? t("status.paused") : s.lastRun ? t("status.indexedAt", { time: fmtWhen(s.lastRun.finishedAt) }) : "";
    // beside the button only while the model isn't ready (starting, or failed): searching waits on it then
    $("statusShort").textContent = eng.status === "ready" ? "" : engLabel;
    setStatusLines([counts, done, engLabel, eng.status === "error" && eng.error]);
    $("progress").classList.add("hidden");
  }

  const ul = $("folders");
  ul.innerHTML = folders.length ? "" : `<li class="muted small">${esc(t("folders.none"))}</li>`;
  folders.forEach((f) => {
    const li = document.createElement("li");
    li.title = f.path; // the whole path, which the card cuts short
    li.innerHTML = `<div class="fp"><b>${esc(f.path.split(/[\\/]/).pop() || f.path)}</b><span class="tail"><bdi>${esc(f.path)}</bdi></span><span>${esc(t("status.counts", { photos: num(f.images), videos: num(f.videos) }))}</span></div>`;
    const rm = document.createElement("button");
    rm.className = "icon-btn";
    rm.title = t("folder.remove");
    rm.textContent = "×";
    rm.onclick = async () => {
      if (!(await confirmDialog(t("folder.removeConfirm", { path: f.path }), t("confirm.remove")))) return;
      await post("/api/folders/remove", { path: f.path });
      refreshStatus();
      runSearch();
      loadBrowse();
    };
    li.appendChild(rm);
    ul.appendChild(li);
  });
  const ex = $("excludedList");
  ex.innerHTML = s.excluded.length ? "" : `<li class="muted small">${esc(t("excluded.none"))}</li>`;
  s.excluded.forEach((p) => {
    const li = document.createElement("li");
    const root = folders.find((f) => p.startsWith(f.path));
    li.title = p; // the whole path, which the card cuts short
    li.innerHTML = `<div class="fp"><b>${esc(p.split(/[\\/]/).pop())}</b><span class="tail"><bdi>${esc(root ? "…" + p.slice(root.path.length) : p)}</bdi></span></div>`;
    const rm = document.createElement("button");
    rm.className = "icon-btn";
    rm.title = t("excluded.remove");
    rm.textContent = "×";
    rm.onclick = async () => {
      await post("/api/excluded/remove", { path: p });
      toast(t("toast.unexcluded"));
      refreshStatus();
      loadBrowse();
    };
    li.appendChild(rm);
    ex.appendChild(li);
  });
  $("statsLine").textContent = t("stats.line", { vectors: num(stats.vectors), engine: engLabel });
  renderErrors(stats.errors);
}

/** Files that couldn't be processed: each can be shown in its folder or taken off the list. */
let errorsKey = "";
function renderErrors(errors) {
  $("errorsBox").classList.toggle("hidden", !errors.length);
  // rebuilt only when it changes: the status comes every 1.5 s, and a rebuild could swallow a click
  const key = `${lang}\n${errors.map((e) => `${e.id} ${e.error}`).join("\n")}`;
  if (key === errorsKey) return;
  errorsKey = key;
  const platform = window.mmf?.platform;
  const ul = $("errors");
  ul.innerHTML = "";
  for (const e of errors) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="err-text"><b>${esc(e.path.split(/[\\/]/).pop())}</b><br>${esc(e.error || "")}</div>`;
    if (window.mmf?.reveal) {
      const reveal = document.createElement("button");
      reveal.className = "icon-btn";
      reveal.title = t(platform === "darwin" ? "viewer.revealMac" : platform === "win32" ? "viewer.revealWin" : "viewer.revealLinux");
      reveal.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
      reveal.onclick = () => window.mmf.reveal(e.id).catch((err) => toast(`Can't open: ${ipcMessage(err)}`));
      li.appendChild(reveal);
    }
    const hide = document.createElement("button");
    hide.className = "icon-btn";
    hide.title = t("errors.hide");
    hide.textContent = "×";
    hide.onclick = async () => {
      await post("/api/errors/hide", { ids: [e.id] }).catch((err) => toast(err.message));
      refreshStatus();
    };
    li.appendChild(hide);
    ul.appendChild(li);
  }
}
$("clearErrors").onclick = async () => {
  await post("/api/errors/hide", {}).catch((err) => toast(err.message));
  refreshStatus();
};
const DEVICE_KEYS = { webgpu: "device.webgpu", dml: "device.dml", cpu: "device.cpu" };

// ---------- saving videos from the web ----------
// The main process runs yt-dlp, one download at a time, into the indexed folder chosen here; the folder
// watcher then indexes the finished file. Offline nothing can be downloaded, so a message says so instead.
let dlView = null;   // the main process's last { tool, jobs }
let dlKey = "";      // what the list was last built from: rebuilt only when that changes, so clicks aren't swallowed
async function openDownloads() {
  let view;
  try { view = await window.mmf.prepareDownloads(); } catch (e) { return toast(ipcMessage(e), 4000); }
  if (view?.disabled) return; // turned off in settings (its button is hidden then)
  if (view?.offline) return alertDialog(t("dl.offline"));
  const none = !lastStatus?.folders.length;
  $("dlNoFolder").classList.toggle("hidden", !none);
  $("dlStart").disabled = none;
  renderDownloads(view);
  openDrawer("downloads");
  $("dlUrls").querySelector("input")?.focus();
}
/** One more address field; "+" adds them, and a download leaves just one empty field. */
function addUrlField(focus) {
  const input = document.createElement("input");
  input.type = "text"; // not "url": an empty or wrong field is skipped, not a reason to stop the form
  input.inputMode = "url";
  input.spellcheck = false;
  input.dataset.i18nPlaceholder = "dl.urlPlaceholder";
  input.placeholder = t("dl.urlPlaceholder");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.textContent = "×";
  remove.dataset.i18nTitle = "dl.remove";
  remove.title = t("dl.remove");
  remove.setAttribute("aria-label", remove.title);
  remove.onclick = () => {
    const next = li.nextElementSibling || li.previousElementSibling;
    li.remove();
    next?.querySelector("input").focus();
  };
  const li = document.createElement("li");
  li.append(input, remove);
  $("dlUrls").appendChild(li);
  if (focus) input.focus();
}
function resetUrlFields() {
  $("dlUrls").replaceChildren();
  addUrlField(false);
}
const isWebAddress = (text) => {
  try { return ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
};
/** Where the folder chooser starts: the indexed folder being browsed (the one holding the folder on screen), or the first one. */
/**
 * Where the folder chooser starts: the folder chosen last time while it is still inside an indexed folder,
 * else the indexed folder being browsed (the one holding the folder on screen), or the first one.
 */
function downloadStartFolder() {
  const folders = lastStatus?.folders || [];
  const rootOf = (at) => at && folders.find((f) => at === f.path || at.startsWith(f.path.replace(/[\\/]$/, "") + (at.includes("\\") ? "\\" : "/")));
  const last = store.get("mmf.downloadFolder", null);
  if (typeof last === "string" && rootOf(last)) return last;
  return (rootOf(browse.path) || folders[0])?.path || "";
}
function renderDownloads(view) {
  if (!view) return;
  const prev = dlView;
  dlView = view;
  for (const j of view.jobs) {
    if (j.state === "done" && prev && prev.jobs.find((p) => p.id === j.id)?.state !== "done") toast(j.error ? `${t("dl.partial")} · ${downloadNames(j)}` : t("dl.done", { name: downloadNames(j) }), 4000);
  }
  const tool = { fetching: "dl.fetching", unavailable: "dl.unavailable", unsupported: "dl.unsupported" }[view.tool];
  $("dlTool").textContent = tool ? t(tool) : "";
  $("dlTool").classList.toggle("hidden", !tool);
  if (view.tool === "unsupported") $("dlStart").disabled = true;

  const key = `${lang}\n${view.jobs.map((j) => [j.id, j.state, j.title, j.files.join("\t"), j.error].join("\t")).join("\n")}`;
  if (key !== dlKey) {
    dlKey = key;
    const list = $("dlList");
    list.replaceChildren(...view.jobs.slice().reverse().map(downloadItem));
    if (!view.jobs.length) list.innerHTML = `<li class="muted small">${esc(t("dl.empty"))}</li>`;
  }
  for (const j of view.jobs) {
    const el = $("dlList").querySelector(`[data-id="${j.id}"] .dl-state`);
    if (el && j.state === "running") el.textContent = downloadProgress(j);
  }
}
/** The saved file; a post's several: how many first (a long name would cut it off), then the first one. */
const downloadNames = (j) => (j.files.length > 1 ? `${t("dl.count", { n: num(j.files.length) })} · ${j.files[0]}` : j.files[0] || "");
function downloadProgress(j) {
  const p = j.progress;
  return p?.total ? t("dl.running", { pct: Math.min(100, Math.floor((p.done / p.total) * 100)) }) : t("dl.starting");
}
function downloadItem(j) {
  const li = document.createElement("li");
  li.dataset.id = j.id;
  li.title = j.url;
  const state = j.state === "running" ? downloadProgress(j)
    : j.state === "done" ? (j.error ? `${t("dl.partial")} · ${downloadNames(j)}` : downloadNames(j))
    : j.state === "failed" ? `${t("dl.failed")}: ${j.error || ""}` // errors stay in English
    : t(j.state === "queued" ? "dl.queued" : "dl.canceled");
  li.innerHTML = `<div class="fp"><b>${esc(j.title || j.url)}</b><span class="dl-state">${esc(state)}</span></div><div class="dl-actions"></div>`;
  if (j.error) li.querySelector(".dl-state").title = j.error; // failed, or done with some of a post's videos missing
  const actions = li.querySelector(".dl-actions");
  const button = (cls, text, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.onclick = () => run().catch((err) => toast(ipcMessage(err)));
    actions.appendChild(b);
    return b;
  };
  if (j.state === "queued" || j.state === "running") {
    button("ghost", t("dl.cancel"), () => window.mmf.cancelDownload(j.id));
  } else {
    if (j.state === "done") {
      const platform = window.mmf?.platform;
      button("ghost", t(platform === "darwin" ? "viewer.revealMac" : platform === "win32" ? "viewer.revealWin" : "viewer.revealLinux"),
        () => window.mmf.revealDownload(j.id));
    }
    const remove = button("icon-btn", "×", () => window.mmf.removeDownload(j.id));
    remove.title = t("dl.remove");
    remove.setAttribute("aria-label", remove.title);
  }
  return li;
}
$("dlAddUrl").onclick = () => addUrlField(true);
$("dlPostFolder").onchange = () => store.set("mmf.downloadPostFolder", $("dlPostFolder").checked);
$("dlClearDone").onclick = () => window.mmf.clearDoneDownloads().catch((err) => toast(ipcMessage(err)));
$("dlForm").onsubmit = async (e) => {
  e.preventDefault();
  // empty fields and anything that isn't a web address are skipped
  const urls = [...$("dlUrls").querySelectorAll("input")].map((input) => input.value.trim()).filter(isWebAddress);
  if (!urls.length) {
    toast(t("dl.noUrls"));
    return $("dlUrls").querySelector("input")?.focus();
  }
  try {
    const r = await window.mmf.startDownload(urls, downloadStartFolder(), t("dl.pickFolder"), $("dlPostFolder").checked);
    if (r?.offline) return alertDialog(t("dl.offline"));
    if (r?.ids) {
      store.set("mmf.downloadFolder", r.folder);
      resetUrlFields();
    }
  } catch (err) { toast(ipcMessage(err), 4000); }
};
resetUrlFields();
/** Settings › experimental › "Web media download": the download button is there only while it is on. */
function applyWebDownload(on) {
  $("webDownloadCheck").checked = on;
  $("openDownloads").classList.toggle("hidden", !on || !window.mmf?.prepareDownloads);
  if (!on && $("downloads").classList.contains("open")) closeDrawers();
}
$("webDownloadCheck").onchange = async (e) => {
  const on = e.target.checked;
  store.set("mmf.webDownload", on);
  applyWebDownload(on);
  // turning it off ends every download and cleans up after them: no second change until that is done
  e.target.disabled = true;
  try { await window.mmf.setWebDownload(on); } catch (err) { toast(ipcMessage(err)); } finally { e.target.disabled = false; }
};
if (window.mmf?.prepareDownloads) {
  $("openDownloads").onclick = openDownloads;
  window.mmf.onDownloads(renderDownloads);
  // e.g. the window was reopened while a download runs
  window.mmf.getDownloads().then((view) => { if (view) renderDownloads(view); }, () => {});
} else {
  $("experimentalRow").classList.add("hidden"); // the page opened outside the app: nothing to run yt-dlp
}

(async () => {
  applyLanguage(initialLanguage()); // OS language until the saved settings arrive
  try { Object.assign(prefs, await api("/api/prefs")); } catch { /* start with defaults */ }
  prefsLoaded = true;
  applyLanguage(initialLanguage());
  $("themeSelect").value = ["light", "dark"].includes(store.get("mmf.theme")) ? store.get("mmf.theme") : "system";
  $("autoplayCheck").checked = store.get("mmf.videoAutoplay", true) !== false;
  $("dlPostFolder").checked = store.get("mmf.downloadPostFolder", true) !== false;
  applyWebDownload(store.get("mmf.webDownload", false) === true);
  applyFolderView(store.get("mmf.folderView") === "grid" ? "grid" : "list"); // a list unless the grid was chosen
  readBrowseSort();
  syncDropdowns();
  browse.path = store.get("mmf.browse", null);
  recent = store.get(RECENT_KEY, []).filter((x) => typeof x === "string").slice(0, RECENT_MAX);
  refreshStatus();
  setInterval(refreshStatus, 1500);
  loadPerformance();
  renderRecent();
  quietFocus = true;
  $("q").focus();
  const initialQ = new URLSearchParams(location.search).get("q");
  if (initialQ) { $("q").value = initialQ; setQuery(initialQ); }
})();
