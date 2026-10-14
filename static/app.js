const $ = (id) => document.getElementById(id);
document.documentElement.classList.add(`platform-${window.mmf?.platform || "web"}`);
const PAGE = 60;          // image-relevance list page
const SECTION_PAGE = 12;  // first page of each text-relevance section (two rows)
const SECTION_MORE = 24;
const SECTIONS = ["name", "ocr", "audio"];
const VIA_KEY = { image: "via.scene", frame: "via.scene", audio: "via.audio", name: "via.name", ocr: "via.ocr" };

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
  view: store.get("mmf.view", "image") === "text" ? "text" : "image",
  lists: {},            // "main" for image relevance; name / ocr / audio for text relevance
  expanded: false,      // user paged a list: don't auto-refresh under them
  seq: 0, hasIndex: false, progress: null,
  viewer: { list: null, index: -1 },
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
const isActive = () => !!(state.query || state.imageBlob || state.similarVid != null);

function baseParams(limit, offset) {
  return new URLSearchParams({ type: state.type, audio: state.audio ? "1" : "0", limit, offset });
}

/** Re-run the whole search (append=false) or fetch the next page of one list. */
async function runSearch(append = null) {
  if (append) {
    // a pending availability check may drop rows; page offsets must be read after it settles
    await pruneRun;
    const page = runSearchNow(append);
    paging = page;
    return page.finally(() => { if (paging === page) paging = null; });
  }
  return runSearchNow(append);
}

async function runSearchNow(append) {
  const seq = ++state.seq;
  if (!append) state.expanded = false;
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
    } else if (state.query && state.view === "image") {
      await loadMain(seq, append, (p) => {
        p.set("q", state.query);
        p.set("view", "image");
        return api(`/api/search?${p}`);
      });
    } else if (state.query) {
      await loadSections(seq, append);
    } else {
      state.lists = {};
      render();
    }
  } catch (e) {
    if (seq === state.seq) toast(`Search failed: ${e.message}`);
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

async function loadSections(seq, appendKey) {
  const p = baseParams(appendKey ? SECTION_MORE : SECTION_PAGE, appendKey ? state.lists[appendKey].offset : 0);
  p.set("q", state.query);
  p.set("view", "text");
  if (appendKey) p.set("section", appendKey);
  const { sections } = await api(`/api/search?${p}`);
  if (seq !== state.seq) return;
  if (!appendKey) state.lists = {};
  for (const [key, data] of Object.entries(sections)) {
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
  updateHome();
  $("viewMode").classList.toggle("hidden", !isTextQuery());
  const box = $("results");
  box.innerHTML = "";
  if (!active) { $("summary").textContent = ""; return; }

  if (state.lists.main) {
    const list = state.lists.main;
    const byImage = state.imageBlob ? t("summary.byImage") : state.similarVid != null ? t("summary.similar") : null;
    const label = byImage ? (state.query ? t("summary.imagePlus", { q: state.query }) : byImage) : t("summary.byImageView", { q: state.query });
    $("summary").textContent = list.total ? t("summary.count", { label, n: num(list.total) }) : t("summary.none", { label });
    box.appendChild(listBlock("main", list));
    return;
  }
  const keys = SECTIONS.filter((k) => state.lists[k]);
  const total = keys.reduce((n, k) => n + state.lists[k].total, 0);
  $("summary").textContent = t("summary.count", { label: t("summary.byTextView", { q: state.query }), n: num(total) });
  for (const key of keys) {
    const list = state.lists[key];
    const sec = document.createElement("section");
    sec.className = "result-section";
    sec.innerHTML = `<header><h2>${esc(t(`sec.${key}.title`))}<span class="count">${num(list.total)}</span></h2>
      <p class="muted small">${esc(t(`sec.${key}.desc`))}</p></header>`;
    if (key === "ocr") {
      const note = document.createElement("p");
      note.id = "ocrPendingNote";
      note.className = "pending-note small hidden";
      sec.appendChild(note);
      updateOcrPendingNote(note);
    }
    if (list.total) {
      sec.appendChild(listBlock(key, list));
    } else {
      const note = document.createElement("p");
      note.className = "muted small empty-note";
      const p = state.progress;
      note.textContent = key === "name" && p?.running && p.phase === "names"
          ? t("sec.analyzingNames")
          : t("sec.empty");
      sec.appendChild(note);
    }
    box.appendChild(sec);
  }
}

/** "Text in photos" can grow while text recognition is still working through files. */
function updateOcrPendingNote(note = $("ocrPendingNote")) {
  if (!note) return;
  const o = state.ocr;
  const left = o && o.available ? o.pendingImages + o.pendingVideos : 0;
  note.classList.toggle("hidden", !left);
  if (!left) return;
  const parts = [o.pendingImages && t("count.photos", { n: num(o.pendingImages) }), o.pendingVideos && t("count.videos", { n: num(o.pendingVideos) })].filter(Boolean);
  const p = state.progress;
  note.textContent = `${t("ocr.pending", { parts: parts.join(" · ") })} `
    + t(!p?.running ? "ocr.stopped" : p.ocr?.running ? "ocr.running" : "ocr.afterIndex");
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
    const icon = r.via === "audio" ? "🔊" : r.via === "ocr" ? "T" : "▶";
    if (r.t != null) badges += `<span class="badge tl">${icon} ${fmtTime(r.t)}</span>`;
    if (r.duration) badges += `<span class="badge tr">${fmtTime(r.duration)}</span>`;
  }
  // name/OCR hits show the matched text on the tile; others show the file name on hover
  const caption = r.text
    ? `<span class="caption"><span>${highlight(r.text.replace(/\s*\n\s*/g, " · "), state.query)}</span></span>`
    : `<span class="name">${esc(r.name)}</span>`;
  b.innerHTML = `<img loading="lazy" src="/thumb/${r.thumb}" alt="">${badges}${caption}`;
  b.onclick = () => { commitRecent(); openViewer(list, i); };
  return b;
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
  $("vOcr").classList.toggle("hidden", r.ocrDone || !state.ocr?.available);
  if (!r.ocrDone) refreshViewerOcr();
  $("vSimilar").disabled = r.vid == null;
  $("vText").classList.toggle("hidden", !r.text);
  $("vText").innerHTML = r.text ? `<p class="small muted">${esc(t(r.via === "ocr" ? "viewer.ocrText" : "viewer.location"))}</p><div class="matched">${highlight(r.text, state.query)}</div>` : "";

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
      media.innerHTML = `<div class="fallback"><img src="/thumb/${r.thumb}" alt=""><p>This format can't be played here.<br>Use “${esc(t("viewer.open"))}”.</p></div>`;
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
      const icon = m.modality === "audio" ? "🔊 " : m.modality === "ocr" ? "T " : "";
      btn.innerHTML = `<img src="/thumb/${m.thumb}" alt=""><span>${icon}${fmtTime(m.t)}</span>`;
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

/** The viewer's "waiting to be recognized" line follows the file's current OCR state, not the search snapshot. */
async function refreshViewerOcr() {
  const r = viewerResult();
  if (!r || r.ocrDone) return;
  try {
    if ((await post("/api/file", { id: r.id })).ocr_done) r.ocrDone = true;
  } catch {
    return;
  }
  if (viewerResult() === r) $("vOcr").classList.toggle("hidden", r.ocrDone || !state.ocr?.available);
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
};

document.addEventListener("keydown", (e) => {
  const { list, index } = state.viewer;
  if (!list) {
    if (e.key === "Escape") closeDrawers();
    return;
  }
  if (e.key === "Escape") closeViewer();
  if (e.key === "ArrowRight") openViewer(list, Math.min(index + 1, list.results.length - 1));
  if (e.key === "ArrowLeft") openViewer(list, Math.max(index - 1, 0));
});

// ---------- results deleted outside the app ----------
// Coming back to the window, ask the engine which results on screen are gone and drop just those,
// keeping loaded pages, scroll position and an open viewer.
const PRUNE_BATCH = 1000;
let pruneRun = Promise.resolve();
let paging = null; // in-flight "show more" request: checks wait for it so offsets stay consistent
let pruning = false;

function pruneUnavailable() {
  if (pruning) return pruneRun;
  pruning = true;
  pruneRun = prune().finally(() => { pruning = false; });
  return pruneRun;
}

async function prune() {
  if (paging) await paging.catch(() => {});
  const lists = Object.values(state.lists);
  const ids = [...new Set(lists.flatMap((l) => l.results.map((r) => r.id)))];
  if (!ids.length) return;
  try {
    const gone = new Set();
    for (let i = 0; i < ids.length; i += PRUNE_BATCH) {
      for (const id of (await post("/api/unavailable", { ids: ids.slice(i, i + PRUNE_BATCH) })).ids) gone.add(id);
    }
    if (!gone.size) return;
    const viewing = viewerResult();
    for (const l of lists) {
      const removed = l.results.filter((r) => gone.has(r.id)).length;
      l.results = l.results.filter((r) => !gone.has(r.id));
      l.total -= removed;
      l.offset -= removed;
    }
    if (viewing && gone.has(viewing.id)) closeViewer();
    else if (viewing) state.viewer.index = state.viewer.list.results.indexOf(viewing);
    render();
  } catch {
    // engine unreachable: the next search filters deleted files anyway
  }
}
window.addEventListener("focus", () => { pruneUnavailable(); if (!isActive()) loadBrowse(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) pruneUnavailable(); });

// ---------- folder browser (start screen) ----------
const BROWSE_PAGE = 200;
const browse = { path: store.get("mmf.browse", null), data: null, shown: BROWSE_PAGE, seq: 0 };
const SORT_KEY = "mmf.browseSort";
let browseSort = { key: "name", dir: "asc" };
function readBrowseSort() {
  const s = store.get(SORT_KEY, {});
  browseSort = { key: s?.key === "mtime" ? "mtime" : "name", dir: s?.dir === "desc" ? "desc" : "asc" };
  $("sortKey").value = browseSort.key;
  $("sortDir").value = browseSort.dir;
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
  browseSort = { key: $("sortKey").value, dir: $("sortDir").value };
  store.set(SORT_KEY, browseSort);
  if (!browse.data) return;
  sortBrowse(browse.data);
  renderBrowse();
}
$("sortKey").onchange = changeBrowseSort;
$("sortDir").onchange = changeBrowseSort;

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
  state.query = "";
  $("q").value = "";
  history.replaceState(null, "", location.pathname);
  runSearch();
  window.scrollTo({ top: 0 });
}
$("homeBtn").onclick = goHome;

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
    // data: URLs are local; web images go through the engine (the page itself can't fetch other sites)
    const res = url.startsWith("data:") ? await fetch(url) : await fetch(`/api/fetch_image?url=${encodeURIComponent(url)}`);
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
$("viewSelect").onchange = (e) => { state.view = e.target.value; store.set("mmf.view", state.view); runSearch(); };
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
  $("langSelect").value = lang;
  updatePlaceholder();
  renderExamples();
  renderRecent();
  render();
  if (browse.data) { sortBrowse(browse.data); renderBrowse(); }
  if (lastStatus) renderStatus(lastStatus);
  window.mmf?.setTrayLabels?.({ open: t("tray.open"), settings: t("settings.title"), quit: t("tray.quit") });
}

for (const [code, name] of LANGUAGES) $("langSelect").add(new Option(name, code));
$("langSelect").onchange = (e) => { store.set("mmf.lang", e.target.value); applyLanguage(e.target.value); };
$("themeSelect").onchange = (e) => {
  store.set("mmf.theme", e.target.value);
  window.mmf?.setTheme(e.target.value); // the main process switches the page's light/dark preference
};

/** Startup and background options live in the main process (the OS login item, the tray), so ask it. */
async function loadAppSettings() {
  let s;
  try { s = await window.mmf.getAppSettings(); } catch { return; }
  $("startupRow").classList.toggle("hidden", !s.openAtLogin.shown);
  $("startupCheck").disabled = !s.openAtLogin.available; // development build: nothing to register
  $("startupCheck").checked = s.openAtLogin.enabled;
  $("backgroundRow").classList.toggle("hidden", s.runInBackground == null);
  $("backgroundCheck").checked = !!s.runInBackground;
}
$("startupCheck").onchange = async (e) => {
  try { e.target.checked = await window.mmf.setOpenAtLogin(e.target.checked); }
  catch (err) { e.target.checked = !e.target.checked; toast(`Couldn't change the startup setting: ${err.message}`); }
};
$("backgroundCheck").onchange = (e) => {
  store.set("mmf.background", e.target.checked);
  window.mmf.setRunInBackground(e.target.checked);
};
window.mmf?.onOpenSettings?.(() => openDrawer("settings")); // "Settings" in the tray menu

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
$("reindex").onclick = async () => { const r = await post("/api/reindex"); toast(t(r.started ? "toast.reindex" : "toast.alreadyIndexing")); refreshStatus(); };
$("stopIndex").onclick = async () => { await post("/api/stop"); toast(t("toast.stopping")); };

let lastDone = -1, wasRunning = false, lastStatus = null;
async function refreshStatus() {
  let s;
  try { s = await api("/api/status"); } catch { $("status").textContent = "Can't connect to the engine"; return; }
  const { progress: p, folders, stats } = s;
  lastStatus = s;
  state.progress = p;
  state.ocr = stats.ocr;
  updateOcrPendingNote();
  if (p.ocr?.running) refreshViewerOcr();
  state.hasIndex = stats.images + stats.videos > 0;
  $("welcome").classList.toggle("hidden", folders.length > 0);
  updateHome();
  renderStatus(s);

  // refresh visible results as new files land in the index (not while the user is paging or viewing)
  // both counters: text recognition runs alongside indexing and adds matches of its own
  const done = p.done + (p.ocr?.done || 0);
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
  const counts = t("status.counts", { photos: num(stats.images), videos: num(stats.videos) });
  const eng = s.engine;
  const engLabel = eng.status === "ready" ? `${s.model} · ${eng.device in DEVICE_KEYS ? t(DEVICE_KEYS[eng.device]) : eng.device}`
    : eng.status === "error" ? "Model error" : t("engine.loading", { model: s.model });
  $("status").title = eng.status === "error" ? eng.error || "" : "";
  if (p.running) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const cur = p.current ? p.current.split(/[\\/]/).pop() : "";
    // text recognition can run alongside indexing, so it has its own counter
    const o = p.ocr || {};
    const ocrPart = o.running ? t("phase.ocr", { done: num(o.done), total: num(o.total) }) : "";
    const main = p.phase === "scanning" ? t("phase.scanning")
      : p.phase === "loading-model" ? t("phase.loadingModel")
      : p.phase === "ocr" ? (ocrPart ? "" : t("phase.ocrPreparing"))
      : `${t(p.phase === "names" ? "phase.names" : "phase.indexing")} ${num(p.done)}/${num(p.total)} (${pct}%) ${cur}`;
    $("status").textContent = [main, ocrPart, counts].filter(Boolean).join(" · ");
    $("progress").classList.remove("hidden");
    $("progressBar").style.width = `${p.phase === "ocr" && o.total ? Math.round((o.done / o.total) * 100) : pct}%`;
  } else {
    $("status").textContent = `${counts} · ${engLabel}`;
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
  $("statsLine").textContent = t("stats.line", { vectors: num(stats.vectors), text: num(stats.withText), engine: engLabel });
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
  loadAppSettings();
  state.view = store.get("mmf.view", "image") === "text" ? "text" : "image";
  $("viewSelect").value = state.view;
  readBrowseSort();
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
