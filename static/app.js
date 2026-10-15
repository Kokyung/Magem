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
  seq: 0, hasIndex: false, progress: null,
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

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
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
const withRange = (label) => (hasDates() ? `${label} · ${rangeLabel()}` : label);

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
  $("viewer").classList.remove("hidden");
  $("vName").textContent = r.name;
  $("vPath").textContent = r.path;
  $("vScore").innerHTML = r.percent == null ? ""
    : `<span class="muted">${esc(t("viewer.relevance"))}</span> ${r.percent}% · <span class="muted">${esc(t("viewer.foundBy", { via: t(VIA_KEY[r.via] || "via.scene") }))}</span>`;
  $("vSimilar").disabled = r.vid == null;
  $("vText").classList.toggle("hidden", !r.text);
  $("vText").innerHTML = r.text ? `<p class="small muted">${esc(t("viewer.location"))}</p><div class="matched">${highlight(r.text, state.query)}</div>` : "";

  const media = $("viewerMedia");
  media.innerHTML = "";
  if (r.kind === "image") {
    const img = new Image();
    img.src = `/media/${r.id}`;
    img.onerror = () => { img.src = `/thumb/${r.thumb}`; }; // e.g. HEIC in browsers without support
    media.appendChild(img);
  } else {
    const v = document.createElement("video");
    v.src = `/media/${r.id}#t=${Math.max(0, (r.t || 0) - 0.5)}`;
    v.controls = true;
    v.autoplay = true;
    v.onerror = () => {
      media.innerHTML = `<div class="fallback"><img src="/thumb/${esc(r.thumb)}" alt=""><p>This format can't be played here.<br>Use “${esc(t("viewer.open"))}”.</p></div>`;
    };
    media.appendChild(v);
  }

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

function closeViewer() {
  $("viewer").classList.add("hidden");
  $("viewerMedia").innerHTML = "";
  state.viewer = { list: null, index: -1 };
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

$("viewerMedia").oncontextmenu = (e) => {
  const r = viewerResult();
  if (!r) return;
  e.preventDefault();
  singleFileMenu(e, r);
};

document.addEventListener("keydown", (e) => {
  // the backup modal owns the keyboard while it is open: Esc closes it once the job is over
  if (!$("jobModal").classList.contains("hidden")) {
    if (e.key === "Escape") closeIndexJob();
    return;
  }
  // any key dismisses an open menu (it acts on the file it was opened for, which arrows would change)
  if (menuOpen()) { closeMenu(); if (e.key === "Escape") return; }
  const { list, index } = state.viewer;
  if (!list) {
    if (e.key === "Escape") {
      if (selection.ids.size) clearSelection();
      else closeDrawers();
    }
    return;
  }
  if (e.key === "Escape") closeViewer();
  if (e.key === "ArrowRight") openViewer(list, Math.min(index + 1, list.results.length - 1));
  if (e.key === "ArrowLeft") openViewer(list, Math.max(index - 1, 0));
});

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
const browse = { path: store.get("mmf.browse", null), data: null, shown: BROWSE_PAGE, seq: 0 };
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
  const show = home && state.hasIndex;
  const wasHidden = $("browser").classList.contains("hidden");
  $("browser").classList.toggle("hidden", !show);
  if (show && wasHidden) loadBrowse();
}

async function loadBrowse(p = browse.path) {
  if (!prefsLoaded) return; // the saved folder isn't known yet; startup loads it afterwards
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
  const list = { results: indexed };
  const grid = $("browseGrid");
  grid.innerHTML = "";
  d.files.slice(0, browse.shown).forEach((f) => {
    if (f.indexed) {
      grid.appendChild(tile(f, list, indexed.indexOf(f)));
    } else {
      const el = document.createElement("div");
      el.className = "tile pending";
      el.title = f.path;
      el.innerHTML = `<div><b>${esc(f.name)}</b>${esc(t(f.failed ? "browser.failed" : "browser.pending"))}</div>`;
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
  const imgs = indexed.filter((f) => f.kind === "image").length;
  const pending = d.files.filter((f) => !f.indexed && !f.failed).length;
  const failed = d.files.filter((f) => f.failed).length;
  $("browseNote").textContent = !d.path ? ""
    : !d.files.length && !d.dirs.length ? t("browser.empty")
    : d.files.length ? [t("count.photos", { n: num(imgs) }), t("count.videos", { n: num(indexed.length - imgs) }),
      pending && t("count.pending", { n: num(pending) }), failed && t("count.failed", { n: num(failed) })].filter(Boolean).join(" · ") : "";
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
/** Local midnight after the given day (a calendar day, so a daylight-saving change doesn't shift it). */
function dayAfter(value) {
  const d = new Date(`${value}T00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}
function readDates() {
  let [from, to] = [$("dateFrom").value, $("dateTo").value];
  if (from && to && from > to) { [from, to] = [to, from]; $("dateFrom").value = from; $("dateTo").value = to; }
  state.after = startOfDay(from);
  state.before = to ? dayAfter(to) : null; // the whole last day
  $("dateClear").classList.toggle("hidden", !hasDates());
}
function clearDates() {
  $("dateFrom").value = "";
  $("dateTo").value = "";
  readDates();
}
for (const id of ["dateFrom", "dateTo"]) $(id).onchange = () => { readDates(); inputSeq++; runSearch(); };
$("dateClear").onclick = () => { clearDates(); inputSeq++; runSearch(); };

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
  // once the saved language is known: the main process keeps these for a start without a window
  if (prefsLoaded) window.mmf?.setTrayLabels?.({
    open: t("tray.open"), settings: t("settings.title"), quit: t("tray.quit"), notice: t("tray.notice"),
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
$("backgroundCheck").onchange = (e) => {
  store.set("mmf.background", e.target.checked);
  window.mmf.setRunInBackground(e.target.checked);
};
window.mmf?.onOpenSettings?.(() => openDrawer("settings")); // "Settings" in the tray menu

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
$("restoreBtn").onclick = startIndexJob(() => confirm(t("backup.restoreConfirm")) && window.mmf.startRestore(t("backup.pickFile")));
$("jobCancel").onclick = () => window.mmf.cancelIndexJob();
$("jobClose").onclick = closeIndexJob;
$("jobReveal").onclick = () => window.mmf.revealBackup();
window.mmf?.onIndexJob?.(renderIndexJob); // the end of a job, even if this page wasn't asking
// e.g. the window was reopened in the middle of a backup
window.mmf?.getIndexJob?.().then((job) => { if (job?.state === "running") renderIndexJob(job); }, () => {});

// ---------- drawers, folders & status ----------
function openDrawer(id) {
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
  try { s = await api("/api/status"); } catch { $("status").textContent = "Can't connect to the engine"; hideBoot(); return; }
  const { progress: p, folders, stats } = s;
  lastStatus = s;
  state.progress = p;
  state.hasIndex = stats.images + stats.videos > 0;
  if (!state.hasIndex) hideBoot(); // otherwise the folder listing replaces the placeholders
  $("welcome").classList.toggle("hidden", folders.length > 0);
  updateHome();
  renderStatus(s);

  // refresh visible results as new files land in the index (not while the user is paging or viewing)
  const done = p.done;
  if ((p.running && Math.floor(done / 10) !== Math.floor(lastDone / 10)) || (wasRunning && !p.running)) {
    if (isActive() && !state.viewer.list && !state.expanded) runSearch();
    else if (!isActive() && !state.viewer.list) loadBrowse(); // new thumbnails / counts
  }
  lastDone = done;
  wasRunning = p.running;
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
  const engLabel = eng.status === "ready" ? `${s.model} · ${eng.device in DEVICE_KEYS ? t(DEVICE_KEYS[eng.device]) : eng.device}`
    : eng.status === "error" ? "Model error" : t("engine.loading", { model: s.model });
  $("status").title = eng.status === "error" ? eng.error || "" : "";
  if (p.running) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const cur = p.current ? p.current.split(/[\\/]/).pop() : "";
    const main = p.phase === "scanning" ? t("phase.scanning")
      : p.phase === "loading-model" ? t("phase.loadingModel")
      : `${t(p.phase === "names" ? "phase.names" : "phase.indexing")} ${num(p.done)}/${num(p.total)} (${pct}%) ${cur}`.trim();
    // the time left for the whole run (file names and indexing together, estimated by the engine), in bold
    // right after what is being worked on
    const eta = s.eta != null ? t("eta", { time: fmtTime(s.eta) }) : "";
    const parts = [main, counts];
    if (eta) parts.splice(1, 0, { bold: eta });
    $("status").replaceChildren(...parts.flatMap((part, i) => {
      const node = typeof part === "string" ? part : Object.assign(document.createElement("b"), { textContent: part.bold });
      return i ? [" · ", node] : [node];
    }));
    $("progress").classList.remove("hidden");
    $("progressBar").style.width = `${pct}%`;
  } else {
    const done = s.paused ? t("status.paused") : s.lastRun ? t("status.indexedAt", { time: fmtWhen(s.lastRun.finishedAt) }) : "";
    $("status").textContent = [counts, done, engLabel].filter(Boolean).join(" · ");
    $("progress").classList.add("hidden");
  }

  const ul = $("folders");
  ul.innerHTML = folders.length ? "" : `<li class="muted small">${esc(t("folders.none"))}</li>`;
  folders.forEach((f) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="fp"><b>${esc(f.path.split(/[\\/]/).pop() || f.path)}</b><span>${esc(f.path)}</span><span>${esc(t("status.counts", { photos: num(f.images), videos: num(f.videos) }))}</span></div>`;
    const rm = document.createElement("button");
    rm.className = "icon-btn";
    rm.title = t("folder.remove");
    rm.textContent = "×";
    rm.onclick = async () => {
      if (!confirm(t("folder.removeConfirm", { path: f.path }))) return;
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
    li.innerHTML = `<div class="fp"><b>${esc(p.split(/[\\/]/).pop())}</b><span>${esc(root ? "…" + p.slice(root.path.length) : p)}</span></div>`;
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
  $("errorsBox").classList.toggle("hidden", !stats.errors.length);
  $("errors").innerHTML = stats.errors.map((e) => `<li><b>${esc(e.path.split(/[\\/]/).pop())}</b><br>${esc(e.error || "")}</li>`).join("");
}
const DEVICE_KEYS = { webgpu: "device.webgpu", dml: "device.dml", cpu: "device.cpu" };

(async () => {
  applyLanguage(initialLanguage()); // OS language until the saved settings arrive
  try { Object.assign(prefs, await api("/api/prefs")); } catch { /* start with defaults */ }
  prefsLoaded = true;
  applyLanguage(initialLanguage());
  $("themeSelect").value = ["light", "dark"].includes(store.get("mmf.theme")) ? store.get("mmf.theme") : "system";
  readBrowseSort();
  syncDropdowns();
  browse.path = store.get("mmf.browse", null);
  recent = store.get(RECENT_KEY, []).filter((x) => typeof x === "string").slice(0, RECENT_MAX);
  refreshStatus();
  setInterval(refreshStatus, 1500);
  renderRecent();
  quietFocus = true;
  $("q").focus();
  const initialQ = new URLSearchParams(location.search).get("q");
  if (initialQ) { $("q").value = initialQ; setQuery(initialQ); }
})();
