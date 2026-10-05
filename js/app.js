import { CONFIG } from "./config.js";
import { api, errorText, isNetworkError } from "./api.js";
import { uniqueRandomColor, minDistance } from "./colors.js";
import { compactDay, liveLines } from "./geo.js";
import { searchPlaces, CATEGORIES } from "./overpass.js";

// ---------------------------------------------------------------------
// Constantes y estado
// ---------------------------------------------------------------------
const STATUS = {
  pendiente:   { label: "Pendiente",      color: "#9aa0a6" },
  cliente:     { label: "Cliente",        color: "#1e8e3e" },
  no_interesa: { label: "No le interesa", color: "#d93025" },
  cerrado:     { label: "Cerrado",        color: "#f29900" },
  inexistente: { label: "Inexistente",    color: "#202124" },
};
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const REFRESH_MS = 90 * 1000;

const S = {
  state: null,
  tracks: null,
  range: localStorage.getItem("mv_range") || "today",
  hiddenGroups: new Set(JSON.parse(localStorage.getItem("mv_hidden_groups") || "[]")),
  hiddenStatus: new Set(JSON.parse(localStorage.getItem("mv_hidden_status") || "[]")),
  queue: JSON.parse(localStorage.getItem("mv_queue") || "[]"),
  map: null,
  mapReady: false,
  geolocate: null,
  placeId: null,
  addMode: false,
  syncing: false,
  compacting: false,
  lastError: null,
  timer: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAdmin = () => S.state?.me?.role === "admin";
const myGroup = () => S.state?.groups.find((g) => g.id === S.state.me.group_id);
const groupById = (id) => S.state?.groups.find((g) => g.id === id);
const placeById = (id) => S.state?.places.find((p) => p.id === id);
const saveQueue = () => localStorage.setItem("mv_queue", JSON.stringify(S.queue));

function toast(msg, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " +
    d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}
const fmtDay = (day) => { const [y, m, d] = day.split("-"); return `${d}/${m}/${y.slice(2)}`; };

function addDays(day, n) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------
async function boot() {
  document.title = CONFIG.APP_NAME;
  $("login-title").textContent = CONFIG.APP_NAME;
  if (api.demo) { $("demo-hint").classList.remove("hidden"); $("btn-reset-demo").classList.remove("hidden"); }
  $("version-info").textContent = api.demo ? "Modo demo: los datos se guardan sólo en este navegador." : "Conectado a Supabase.";

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  bindUI();
  window.addEventListener("online", () => { updateSync(); flushQueue(); refreshAll(); });
  window.addEventListener("offline", updateSync);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

  if (!api.hasSession()) return showLogin();
  try {
    await loadState();
    showApp();
  } catch (err) {
    if (isNetworkError(err) && loadCachedState()) { showApp(); toast("Sin conexión: mostrando los últimos datos guardados"); }
    else showLogin();
  }
}

function showLogin() {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("pin").value = "";
  setTimeout(() => $("pin").focus(), 50);
}

function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  const g = myGroup();
  $("me-chip").querySelector(".dot").style.background = isAdmin() ? "conic-gradient(#e94235,#fbbc04,#34a853,#4285f4,#e94235)" : g?.color;
  $("me-chip").querySelector(".label").textContent = isAdmin() ? "Administrador" : g?.name || "Grupo";
  $("admin-section").classList.toggle("hidden", !isAdmin());
  document.querySelectorAll("#trail-filter button").forEach((b) => b.classList.toggle("active", b.dataset.range === S.range));
  initMap();
  renderPanel();
  updateSync();
  flushQueue();
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) refreshAll(); }, REFRESH_MS);
}

// ---------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------
async function loadState() {
  const st = await api.getState();
  S.state = st;
  applyQueueToState();
  localStorage.setItem("mv_cache_state", JSON.stringify(st));
  return st;
}

function loadCachedState() {
  const c = localStorage.getItem("mv_cache_state");
  if (!c) return false;
  S.state = JSON.parse(c);
  applyQueueToState();
  const t = localStorage.getItem("mv_cache_tracks");
  if (t) S.tracks = JSON.parse(t);
  return true;
}

function rangeDates() {
  const today = S.state?.today || new Date().toISOString().slice(0, 10);
  if (S.range === "today") return [today, today];
  if (S.range === "7") return [addDays(today, -6), today];
  if (S.range === "30") return [addDays(today, -29), today];
  return [null, null];
}

async function loadTracks() {
  const [from, to] = rangeDates();
  const res = await api.getTracks(from, to);
  S.tracks = res;
  try { localStorage.setItem("mv_cache_tracks", JSON.stringify(res)); } catch { /* lleno: no pasa nada */ }
  renderTracks();
}

async function refreshAll(manual = false) {
  if (!S.state) return;
  const btn = $("btn-refresh");
  if (manual) btn.classList.add("spin");
  try {
    await flushQueue();
    await loadState();
    renderPlaces();
    renderPanel();
    await loadTracks();
    S.lastError = null;
    if (manual) toast("Actualizado");
    runCompaction();
  } catch (err) {
    if (/SESION_INVALIDA|GRUPO_INACTIVO/.test(err.message)) { toast(errorText(err)); await api.logout(); return showLogin(); }
    S.lastError = err;
    if (manual) toast(errorText(err));
  } finally {
    btn.classList.remove("spin");
    updateSync();
  }
}

// ---------------------------------------------------------------------
// Cola sin conexión: los cambios se aplican al instante y se suben cuando hay señal
// ---------------------------------------------------------------------
function applyQueueToState() {
  if (!S.state) return;
  for (const a of S.queue) applyAction(a);
}

function applyAction(a) {
  if (a.type === "add") {
    if (!placeById(a.tempId)) {
      S.state.places.push({ id: a.tempId, osm_id: null, name: a.place.name || "Local sin nombre", category: a.place.category,
        address: null, lat: a.place.lat, lon: a.place.lon, status: "pendiente", note: a.place.note || null, status_at: null,
        status_group: null, created_group: S.state.me.group_id, _pending: true });
    }
    return;
  }
  const p = placeById(a.placeId);
  if (!p) return;
  if (a.type === "status") Object.assign(p, { status: a.status, status_at: a.at, status_group: S.state.me.group_id, _pending: true });
  if (a.type === "note") Object.assign(p, { note: a.note || null, _pending: true });
}

function enqueue(a) {
  S.queue.push(a);
  saveQueue();
  applyAction(a);
  renderPlaces();
  renderPanel();
  updateSync();
  flushQueue();
}

async function flushQueue() {
  if (S.syncing || !S.queue.length) return;
  S.syncing = true;
  updateSync();
  try {
    while (S.queue.length) {
      const a = S.queue[0];
      try {
        if (a.type === "add") {
          const p = await api.addPlace(a.place);
          const local = placeById(a.tempId);
          if (local) Object.assign(local, p, { _pending: false });
          for (const b of S.queue) if (b.placeId === a.tempId) b.placeId = p.id;
          if (S.placeId === a.tempId) S.placeId = p.id;
        } else if (a.placeId < 0) {
          // el alta todavía no se subió: esperamos
          break;
        } else if (a.type === "status") {
          const p = await api.setPlaceStatus(a.placeId, a.status, null, a.at);
          const local = placeById(a.placeId);
          if (local) Object.assign(local, p, { _pending: false });
        } else if (a.type === "note") {
          const p = await api.setPlaceNote(a.placeId, a.note);
          const local = placeById(a.placeId);
          if (local) Object.assign(local, p, { _pending: false });
        }
        S.queue.shift();
        saveQueue();
      } catch (err) {
        if (isNetworkError(err)) break;
        if (/SESION_INVALIDA/.test(err.message)) break;
        toast("No se pudo guardar un cambio: " + errorText(err));
        S.queue.shift();
        saveQueue();
      }
    }
  } finally {
    S.syncing = false;
    renderPlaces();
    updateSync();
  }
}

function updateSync() {
  const el = $("sync");
  const n = S.queue.length;
  el.classList.remove("offline", "error");
  let text;
  if (!navigator.onLine) { el.classList.add("offline"); text = "Sin conexión"; }
  else if (S.syncing) text = "Sincronizando…";
  else if (S.lastError && isNetworkError(S.lastError)) { el.classList.add("offline"); text = "Sin conexión"; }
  else text = api.demo ? "Demo" : "En línea";
  if (n) text += ` · ${n} sin subir`;
  el.querySelector(".sync-text").textContent = text;
}

// ---------------------------------------------------------------------
// Compactación automática de días anteriores (rastro permanente pegado a calles)
// ---------------------------------------------------------------------
async function runCompaction() {
  if (S.compacting || !navigator.onLine) return;
  const lock = +localStorage.getItem("mv_compact_lock") || 0;
  if (Date.now() - lock < 5 * 60 * 1000) return;
  S.compacting = true;
  localStorage.setItem("mv_compact_lock", String(Date.now()));
  try {
    const pending = await api.pendingCompaction();
    let done = 0;
    for (const job of pending) {
      const raw = await api.getRaw(job.group_id, job.day, job.max_id);
      const { lines, matched } = await compactDay(raw, CONFIG.PROFILE);
      if (await api.saveTrack(job.group_id, job.day, job.max_id, lines, matched)) done++;
      localStorage.setItem("mv_compact_lock", String(Date.now()));
    }
    if (done) await loadTracks();
  } catch (err) {
    console.warn("compactación", err);
  } finally {
    S.compacting = false;
    localStorage.removeItem("mv_compact_lock");
  }
}

// ---------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------
function initMap() {
  if (S.map) { renderPlaces(); renderTracks(); return; }
  const view = JSON.parse(localStorage.getItem("mv_view") || "null");
  const map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: view?.center || CONFIG.CENTER,
    zoom: view?.zoom ?? CONFIG.ZOOM,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  S.map = map;

  S.geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: true,
  });
  map.addControl(S.geolocate, "bottom-right");
  S.geolocate.on("trackuserlocationstart", () => $("btn-locate").classList.add("active"));
  S.geolocate.on("trackuserlocationend", () => $("btn-locate").classList.remove("active"));
  S.geolocate.on("error", () => toast("No se pudo obtener tu ubicación. Revisá los permisos de ubicación."));

  map.on("moveend", () => {
    const c = map.getCenter();
    localStorage.setItem("mv_view", JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
  });

  map.on("load", () => {
    map.addSource("tracks", { type: "geojson", data: emptyFC() });
    map.addSource("places", { type: "geojson", data: emptyFC() });

    map.addLayer({ id: "tracks-casing", type: "line", source: "tracks",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 9, 19, 14] } });
    map.addLayer({ id: "tracks-line", type: "line", source: "tracks",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"],
        "line-opacity": ["case", ["get", "today"], 1, 0.75],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 16, 5.5, 19, 9] } });

    map.addLayer({ id: "places-circle", type: "circle", source: "places",
      paint: {
        "circle-color": ["match", ["get", "status"], ...Object.entries(STATUS).flatMap(([k, v]) => [k, v.color]), "#9aa0a6"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 6.5, 18, 11],
        "circle-stroke-color": ["case", ["get", "pending"], "#fbbc04", "#ffffff"],
        "circle-stroke-width": ["case", ["get", "pending"], 3, 2],
        "circle-opacity": ["case", ["==", ["get", "status"], "inexistente"], 0.55, 1],
      } });
    map.addLayer({ id: "places-label", type: "symbol", source: "places", minzoom: 16,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12,
        "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#333", "text-halo-color": "#fff", "text-halo-width": 1.6 } });

    map.on("click", "places-circle", (e) => {
      if (S.addMode) return;
      const f = e.features[0];
      openPlace(f.properties.id);
    });
    map.on("mouseenter", "places-circle", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "places-circle", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "tracks-line", (e) => {
      if (S.addMode) return;
      if (map.queryRenderedFeatures(e.point, { layers: ["places-circle"] }).length) return;
      const p = e.features[0].properties;
      const g = groupById(p.group);
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b style="color:${esc(g?.color)}">●</b> <b>${esc(g?.name || "Grupo")}</b><br>${fmtDay(p.day)}${p.live ? " · en vivo" : ""}`)
        .addTo(map);
    });

    S.mapReady = true;
    renderPlaces();
    if (S.tracks) renderTracks();
    loadTracks().catch((err) => { S.lastError = err; updateSync(); }).finally(runCompaction);
  });
}

const emptyFC = () => ({ type: "FeatureCollection", features: [] });

function renderPlaces() {
  if (!S.mapReady || !S.state) return;
  const features = S.state.places
    .filter((p) => !S.hiddenStatus.has(p.status))
    .map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { id: p.id, status: p.status, name: p.name, pending: !!p._pending } }));
  S.map.getSource("places").setData({ type: "FeatureCollection", features });
}

function renderTracks() {
  if (!S.mapReady || !S.tracks || !S.state) return;
  const today = S.state.today;
  const features = [];
  const color = (gid) => groupById(gid)?.color;
  for (const t of S.tracks.tracks) {
    if (S.hiddenGroups.has(t.group_id) || !color(t.group_id)) continue;
    for (const line of t.lines) {
      if (line.length < 2) continue;
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line },
        properties: { color: color(t.group_id), group: t.group_id, day: t.day, today: t.day === today, live: false } });
    }
  }
  for (const r of S.tracks.raw) {
    if (S.hiddenGroups.has(r.group_id) || !color(r.group_id)) continue;
    for (const line of liveLines(r.pts, CONFIG.PROFILE)) {
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line },
        properties: { color: color(r.group_id), group: r.group_id, day: r.day, today: r.day === today, live: true } });
    }
  }
  S.map.getSource("tracks").setData({ type: "FeatureCollection", features });
}

// ---------------------------------------------------------------------
// Ficha de local
// ---------------------------------------------------------------------
function openPlace(id) {
  const p = placeById(id);
  if (!p) return;
  S.placeId = id;
  $("pl-name").textContent = p.name || "Local sin nombre";
  const bits = [CATEGORIES[p.category] || p.category || "Local"];
  if (p.address) bits.push(p.address);
  if (p.status_at) {
    const g = groupById(p.status_group);
    bits.push(`Último cambio: ${fmtWhen(p.status_at)}${g ? " · " + g.name : ""}`);
  }
  if (p._pending) bits.push("⏳ pendiente de subir");
  $("pl-meta").textContent = bits.join(" · ");

  const box = $("pl-status-buttons");
  box.innerHTML = "";
  for (const [k, v] of Object.entries(STATUS)) {
    if (k === "pendiente") continue;
    const b = document.createElement("button");
    b.className = "status-btn" + (p.status === k ? " selected" : "");
    if (p.status === k) { b.style.background = v.color; b.style.borderColor = v.color; }
    b.innerHTML = `<span class="sw" style="background:${p.status === k ? "#fff" : v.color}"></span>${v.label}`;
    b.onclick = () => setStatus(p.id, k);
    box.appendChild(b);
  }
  if (p.status !== "pendiente") {
    const b = document.createElement("button");
    b.className = "status-btn";
    b.innerHTML = `<span class="sw" style="background:${STATUS.pendiente.color}"></span>Volver a pendiente`;
    b.onclick = () => setStatus(p.id, "pendiente");
    box.appendChild(b);
  }

  $("pl-note").value = p.note || "";
  $("pl-nav").href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`;
  $("sheet").classList.add("open");
  loadHistory(p.id);
}

async function loadHistory(id) {
  const ul = $("pl-history");
  ul.innerHTML = '<li class="muted">Cargando…</li>';
  if (id < 0) { ul.innerHTML = '<li class="muted">Local nuevo, todavía sin subir.</li>'; return; }
  try {
    const h = await api.placeHistory(id);
    if (S.placeId !== id) return;
    const local = S.queue.filter((a) => a.type === "status" && a.placeId === id)
      .map((a) => ({ status: a.status, at: a.at, group_id: S.state.me.group_id, pending: true }));
    const all = [...local.reverse(), ...h];
    ul.innerHTML = all.length ? all.map((e) => {
      const g = groupById(e.group_id);
      const st = STATUS[e.status] || STATUS.pendiente;
      return `<li><span class="sw" style="background:${st.color}"></span><span><b>${esc(st.label)}</b> · ${esc(g ? g.name : "Admin")}${e.pending ? " ⏳" : ""}${e.note ? `<br><span class="muted">${esc(e.note)}</span>` : ""}</span><span class="when">${fmtWhen(e.at)}</span></li>`;
    }).join("") : '<li class="muted">Nadie lo visitó todavía.</li>';
  } catch (err) {
    ul.innerHTML = `<li class="muted">${isNetworkError(err) ? "Sin conexión: el historial se verá cuando vuelva la señal." : esc(errorText(err))}</li>`;
  }
}

function setStatus(id, status) {
  enqueue({ type: "status", placeId: id, status, at: new Date().toISOString() });
  toast(`Marcado como "${STATUS[status].label}"`);
  openPlace(S.placeId);
}

// ---------------------------------------------------------------------
// Agregar local / buscar locales
// ---------------------------------------------------------------------
function setAddMode(on) {
  S.addMode = on;
  $("crosshair").classList.toggle("hidden", !on);
  $("bottom-actions").classList.toggle("hidden", on);
  $("add-actions").classList.toggle("hidden", !on);
  $("trail-filter").classList.toggle("hidden", on);
  if (on) { closeSheet(); toast("Mové el mapa hasta que la cruz quede sobre el local"); }
}

function confirmAdd() {
  const c = S.map.getCenter();
  setAddMode(false);
  const cats = ["cafe", "restaurant", "kiosk", "convenience", "bakery", "pastry", "ice_cream", "bar", "fast_food", "deli", "supermarket", "otro"];
  openModal("Nuevo local", `
    <label class="small muted">Nombre</label>
    <input id="np-name" placeholder="Ej.: Café La Esquina" />
    <label class="small muted">Tipo</label>
    <select id="np-cat">${cats.map((k) => `<option value="${k}">${esc(CATEGORIES[k])}</option>`).join("")}</select>
    <label class="small muted">Nota (opcional)</label>
    <textarea id="np-note" rows="2"></textarea>
    <button id="np-save" class="btn primary block">Guardar local</button>`);
  setTimeout(() => $("np-name").focus(), 50);
  $("np-save").onclick = () => {
    const tempId = -Date.now();
    enqueue({ type: "add", tempId, place: { name: $("np-name").value.trim(), category: $("np-cat").value,
      note: $("np-note").value.trim(), lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6) } });
    closeModal();
    toast("Local agregado");
    openPlace(tempId);
  };
}

async function searchHere() {
  if (!navigator.onLine) return toast("Necesitás conexión para buscar locales");
  if (S.map.getZoom() < 14.5) return toast("Acercá un poco más el mapa para buscar en esta zona");
  const b = S.map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const btn = $("btn-search");
  btn.disabled = true;
  btn.textContent = "Buscando…";
  try {
    const { places, skipped } = await searchPlaces(bbox, S.state.blacklist || []);
    if (!places.length) {
      toast(skipped ? `Sólo se encontraron cadenas excluidas (${skipped})` : "No se encontraron locales en esta zona. Podés agregarlos con ＋ Local");
      return;
    }
    const n = await api.importPlaces(places);
    await loadState();
    renderPlaces();
    renderPanel();
    toast(`${n} locales nuevos${places.length - n ? `, ${places.length - n} ya estaban` : ""}${skipped ? ` · ${skipped} cadenas excluidas` : ""}`, 4500);
  } catch (err) {
    toast("No se pudo buscar ahora (" + errorText(err) + "). Probá de nuevo en un rato.");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔎 Buscar locales aquí";
  }
}

// ---------------------------------------------------------------------
// Panel lateral
// ---------------------------------------------------------------------
function renderPanel() {
  if (!S.state) return;
  const gt = $("group-toggles");
  gt.innerHTML = "";
  for (const g of S.state.groups.filter((x) => x.active || isAdmin())) {
    const el = document.createElement("span");
    el.className = "toggle" + (S.hiddenGroups.has(g.id) ? " off" : "");
    el.innerHTML = `<span class="sw line" style="background:${esc(g.color)}"></span>${esc(g.name)}`;
    el.onclick = () => {
      S.hiddenGroups.has(g.id) ? S.hiddenGroups.delete(g.id) : S.hiddenGroups.add(g.id);
      localStorage.setItem("mv_hidden_groups", JSON.stringify([...S.hiddenGroups]));
      renderPanel(); renderTracks();
    };
    gt.appendChild(el);
  }
  if (!S.state.groups.length) gt.innerHTML = '<span class="muted small">Todavía no hay grupos.</span>';

  const counts = {};
  for (const p of S.state.places) counts[p.status] = (counts[p.status] || 0) + 1;
  const stt = $("status-toggles");
  stt.innerHTML = "";
  for (const [k, v] of Object.entries(STATUS)) {
    const el = document.createElement("span");
    el.className = "toggle" + (S.hiddenStatus.has(k) ? " off" : "");
    el.innerHTML = `<span class="sw" style="background:${v.color}"></span>${v.label} (${counts[k] || 0})`;
    el.onclick = () => {
      S.hiddenStatus.has(k) ? S.hiddenStatus.delete(k) : S.hiddenStatus.add(k);
      localStorage.setItem("mv_hidden_status", JSON.stringify([...S.hiddenStatus]));
      renderPanel(); renderPlaces();
    };
    stt.appendChild(el);
  }

  const visited = S.state.places.filter((p) => p.status !== "pendiente").length;
  const total = S.state.places.length;
  let html = `<div class="stat"><b>${counts.cliente || 0}</b>Clientes</div>
    <div class="stat"><b>${visited}/${total}</b>Locales visitados</div>`;
  const byGroup = {};
  for (const p of S.state.places) if (p.status_group) {
    const e = (byGroup[p.status_group] ||= { visited: 0, clients: 0 });
    e.visited++; if (p.status === "cliente") e.clients++;
  }
  for (const g of S.state.groups.filter((x) => x.active)) {
    const e = byGroup[g.id] || { visited: 0, clients: 0 };
    html += `<div class="stat" style="border-left:4px solid ${esc(g.color)}"><b>${e.clients}</b>${esc(g.name)}: clientes · ${e.visited} visitas</div>`;
  }
  $("stats").innerHTML = html;

  if (isAdmin()) renderAdmin();
}

function renderAdmin() {
  const box = $("groups-admin");
  box.innerHTML = "";
  for (const g of S.state.groups) {
    const row = document.createElement("div");
    row.className = "group-row" + (g.active ? "" : " inactive");
    row.innerHTML = `<span class="sw" style="background:${esc(g.color)}"></span>
      <div class="info"><b>${esc(g.name)}${g.active ? "" : " (inactivo)"}</b><span>PIN ${esc(g.pin)} · usuario ${esc(g.ot_user)}</span></div>`;
    const bSetup = document.createElement("button");
    bSetup.className = "btn"; bSetup.textContent = "📱 Celular";
    bSetup.onclick = () => showOwnTracksSetup(g);
    const bEdit = document.createElement("button");
    bEdit.className = "btn"; bEdit.textContent = "Editar";
    bEdit.onclick = () => editGroup(g);
    row.append(bSetup, bEdit);
    box.appendChild(row);
  }
  if (document.activeElement !== $("blacklist")) $("blacklist").value = (S.state.blacklist || []).join("\n");
}

function newGroupDialog() {
  const existing = S.state.groups.map((g) => g.color);
  let color = uniqueRandomColor(existing);
  const n = S.state.groups.length + 1;
  openModal("Nuevo grupo", `
    <label class="small muted">Nombre</label>
    <input id="ng-name" value="Grupo ${n}" />
    <div class="color-preview"><span id="ng-sw" class="sw"></span><div><b>Color asignado al azar</b><br><span class="small muted" id="ng-dist"></span></div></div>
    <button id="ng-other" class="btn block">🎲 Otro color</button>
    <button id="ng-save" class="btn primary block">Crear grupo</button>
    ${S.state.groups.filter((g) => g.active).length >= 10 ? '<p class="error">Ya tenés 10 grupos activos: con más, los colores empiezan a parecerse.</p>' : ""}`);
  const paint = () => {
    $("ng-sw").style.background = color;
    const d = minDistance(color, existing);
    $("ng-dist").textContent = d >= 25 ? "Muy distinto a los demás ✔" : d >= 15 ? "Distinto a los demás ✔" : "Bastante parecido a otro: probá otro";
  };
  paint();
  $("ng-other").onclick = () => { color = uniqueRandomColor(existing); paint(); };
  $("ng-save").onclick = async () => {
    try {
      const g = await api.createGroup($("ng-name").value.trim() || `Grupo ${n}`, color);
      await loadState();
      renderPanel(); renderTracks();
      showOwnTracksSetup(groupById(g.id) || g);
    } catch (err) { toast(errorText(err)); }
  };
}

function editGroup(g) {
  const others = S.state.groups.filter((x) => x.id !== g.id).map((x) => x.color);
  let color = g.color;
  openModal("Editar grupo", `
    <label class="small muted">Nombre</label>
    <input id="eg-name" value="${esc(g.name)}" />
    <div class="color-preview"><span id="eg-sw" class="sw"></span><button id="eg-color" class="btn">🎲 Cambiar color</button></div>
    <button id="eg-save" class="btn primary block">Guardar</button>
    <button id="eg-pin" class="btn block">🔑 Generar PIN nuevo</button>
    <p class="muted small">Con un PIN nuevo hay que volver a configurar los celulares de ese grupo.</p>
    <button id="eg-active" class="btn block ${g.active ? "danger" : ""}">${g.active ? "Desactivar grupo" : "Reactivar grupo"}</button>
    <p class="muted small">Desactivar no borra nada: el rastro y el historial se conservan para siempre.</p>`);
  const paint = () => ($("eg-sw").style.background = color);
  paint();
  $("eg-color").onclick = () => { color = uniqueRandomColor(others); paint(); };
  const done = async (p, msg) => {
    try { await p; await loadState(); renderPanel(); renderTracks(); closeModal(); toast(msg); }
    catch (err) { toast(errorText(err)); }
  };
  $("eg-save").onclick = () => done(api.updateGroup(g.id, { name: $("eg-name").value, color }), "Grupo actualizado");
  $("eg-pin").onclick = () => { if (confirm("¿Generar un PIN nuevo para " + g.name + "?")) done(api.updateGroup(g.id, { newPin: true }), "PIN nuevo generado"); };
  $("eg-active").onclick = () => done(api.updateGroup(g.id, { active: !g.active }), g.active ? "Grupo desactivado" : "Grupo reactivado");
}

function ownTracksConfig(g) {
  const device = "celu" + Math.floor(100 + Math.random() * 900);
  return {
    _type: "configuration",
    mode: 3,                       // HTTP
    url: api.ownTracksUrl(),
    auth: true,
    username: g.ot_user,
    password: g.pin,
    deviceId: device,
    tid: String(g.id).padStart(2, "0").slice(-2),
    monitoring: 2,                 // "Move": rastreo continuo
    locatorDisplacement: 15,       // metros
    locatorInterval: 15,           // segundos
    moveModeLocatorInterval: 15,
    locatorPriority: 3,            // alta precisión (Android)
    ignoreInaccurateLocations: 50,
    ignoreStaleLocations: 0,
    cmd: false,
    remoteConfiguration: false,
    pubExtendedData: false,
    extendedData: false,
  };
}

function showOwnTracksSetup(g) {
  const cfg = ownTracksConfig(g);
  const json = JSON.stringify(cfg);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const link = "owntracks:///config?inline=" + encodeURIComponent(b64);
  let qrHtml = "";
  try {
    const qr = qrcode(0, "L");
    qr.addData(link);
    qr.make();
    qrHtml = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { qrHtml = '<p class="muted">No se pudo generar el QR, usá el enlace o el archivo.</p>'; }
  const share = `Configuración del ${g.name} para OwnTracks (tocá el enlace con OwnTracks ya instalado):\n${link}`;
  openModal(`Celular · ${g.name}`, `
    <ol class="steps">
      <li>Instalar <b>OwnTracks</b> (gratis): <a href="https://apps.apple.com/app/owntracks/id692424691" target="_blank" rel="noopener">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=org.owntracks.android" target="_blank" rel="noopener">Android</a></li>
      <li>Abrir OwnTracks una vez y aceptar permisos de ubicación <b>"Siempre"</b> (y en Android, desactivar el ahorro de batería para OwnTracks).</li>
      <li>Escanear este QR con la cámara <b>o</b> abrir el enlace desde el celular (podés mandarlo por WhatsApp).</li>
    </ol>
    <div class="qr">${qrHtml}</div>
    <div class="row">
      <a class="btn" href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn" id="ot-copy">Copiar enlace</button>
      <button class="btn" id="ot-file">Archivo .otrc</button>
    </div>
    <h3>Configuración manual (si lo anterior no funciona)</h3>
    <div class="kv">
      <div><b>Modo:</b> HTTP</div>
      <div><b>URL:</b> ${esc(cfg.url)}</div>
      <div><b>Usuario:</b> ${esc(cfg.username)}</div>
      <div><b>Contraseña:</b> ${esc(cfg.password)}</div>
      <div><b>Monitoreo:</b> Move (rastreo continuo)</div>
    </div>
    <p class="muted small">PIN para entrar a esta página: <b>${esc(g.pin)}</b>. Al terminar la jornada, en OwnTracks pasar el monitoreo a "Manual" o "Significant" para ahorrar batería.</p>
    ${api.demo ? '<p class="error">Modo demo: la URL todavía no es real. Conectá Supabase para usar OwnTracks.</p>' : ""}`);
  $("ot-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Enlace copiado"); }
    catch { prompt("Copiá el enlace:", link); }
  };
  $("ot-file").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" }));
    a.download = `${g.ot_user}.otrc`;
    a.click();
  };
}

// ---------------------------------------------------------------------
// UI genérica
// ---------------------------------------------------------------------
function openModal(title, html) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal").classList.remove("hidden");
}
const closeModal = () => $("modal").classList.add("hidden");
const closeSheet = () => { $("sheet").classList.remove("open"); S.placeId = null; };
function openPanel() { renderPanel(); $("panel").classList.add("open"); $("backdrop").classList.remove("hidden"); }
function closePanel() { $("panel").classList.remove("open"); $("backdrop").classList.add("hidden"); }

function bindUI() {
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    const btn = e.submitter || $("login-form").querySelector("button");
    btn.disabled = true;
    try {
      await api.login($("pin").value.trim());
      S.queue = JSON.parse(localStorage.getItem("mv_queue") || "[]");
      await loadState();
      showApp();
      refreshAll();
    } catch (err) {
      $("login-error").textContent = errorText(err);
    } finally { btn.disabled = false; }
  };

  $("btn-menu").onclick = openPanel;
  $("backdrop").onclick = closePanel;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => {
    const w = b.dataset.close;
    if (w === "panel") closePanel(); else if (w === "sheet") closeSheet(); else closeModal();
  }));
  $("modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };

  $("btn-locate").onclick = () => S.geolocate?.trigger();
  $("btn-refresh").onclick = () => refreshAll(true);
  $("btn-add").onclick = () => setAddMode(true);
  $("btn-add-cancel").onclick = () => setAddMode(false);
  $("btn-add-confirm").onclick = confirmAdd;
  $("btn-search").onclick = searchHere;

  document.querySelectorAll("#trail-filter button").forEach((b) => (b.onclick = () => {
    S.range = b.dataset.range;
    localStorage.setItem("mv_range", S.range);
    document.querySelectorAll("#trail-filter button").forEach((x) => x.classList.toggle("active", x === b));
    loadTracks().catch((err) => toast(errorText(err)));
  }));

  $("pl-save-note").onclick = () => {
    if (S.placeId == null) return;
    enqueue({ type: "note", placeId: S.placeId, note: $("pl-note").value.trim() });
    toast("Nota guardada");
  };

  $("btn-new-group").onclick = newGroupDialog;
  $("btn-save-blacklist").onclick = async () => {
    const list = [...new Set($("blacklist").value.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean))];
    try { await api.setBlacklist(list); S.state.blacklist = list; toast("Lista guardada"); }
    catch (err) { toast(errorText(err)); }
  };
  $("btn-admin-pin").onclick = async () => {
    try {
      await api.changeAdminPin($("admin-old").value.trim(), $("admin-new").value.trim());
      $("admin-old").value = $("admin-new").value = "";
      toast("PIN de administrador cambiado");
    } catch (err) { toast(errorText(err)); }
  };
  $("btn-logout").onclick = async () => {
    if (S.queue.length && !confirm(`Hay ${S.queue.length} cambios sin subir. Si salís ahora se van a subir la próxima vez que entres desde este celular. ¿Salir igual?`)) return;
    await api.logout();
    closePanel(); closeSheet();
    clearInterval(S.timer);
    S.state = null;
    showLogin();
  };
  $("btn-reset-demo").onclick = () => {
    if (!confirm("¿Borrar todos los datos de demo?")) return;
    api.resetDemo();
    localStorage.removeItem("mv_queue");
    localStorage.removeItem("mv_cache_state");
    localStorage.removeItem("mv_cache_tracks");
    location.reload();
  };
}

boot();
