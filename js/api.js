// Capa de datos: Supabase (real) o Demo (todo en este navegador, para probar sin cuentas).
import { CONFIG } from "./config.js";
import { uniqueRandomColor } from "./colors.js";
import { PRELOADED_PLACES } from "./avellaneda.js";

export const ERRORS = {
  PIN_INCORRECTO: "PIN incorrecto",
  SESION_INVALIDA: "Tu sesión expiró, volvé a ingresar",
  GRUPO_INACTIVO: "Tu grupo fue desactivado",
  SOLO_ADMIN: "Sólo el administrador puede hacer esto",
  DEMASIADOS_INTENTOS: "Demasiados intentos, esperá unos minutos",
  PIN_CORTO: "El PIN debe tener al menos 6 dígitos",
  PIN_EN_USO: "Ese PIN ya lo usa un grupo",
  LOCAL_NO_EXISTE: "Ese local ya no existe",
};

export function errorText(err) {
  const m = String(err?.message || err);
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (m.includes("Failed to fetch") || m.includes("NetworkError")) return "Sin conexión";
  return m;
}

export const isNetworkError = (err) => /Failed to fetch|NetworkError|Load failed|network/i.test(String(err?.message || err));

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------
class SupabaseApi {
  constructor(url, key) {
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.demo = false;
    this.token = localStorage.getItem("mv_token");
  }
  async rpc(name, params = {}) {
    const headers = { apikey: this.key, "Content-Type": "application/json" };
    if (this.key.startsWith("eyJ")) headers.Authorization = `Bearer ${this.key}`;
    const r = await fetch(`${this.url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(params) });
    const txt = await r.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    if (!r.ok) throw new Error(body?.message || body?.hint || txt || `Error ${r.status}`);
    return body;
  }
  t(params = {}) { return { p_token: this.token, ...params }; }

  async login(pin) {
    const res = await this.rpc("login", { p_pin: pin });
    this.token = res.token;
    localStorage.setItem("mv_token", res.token);
    return res;
  }
  async logout() {
    try { await this.rpc("logout", this.t()); } catch { /* sin conexión: igual salimos */ }
    this.token = null;
    localStorage.removeItem("mv_token");
  }
  hasSession() { return !!this.token; }
  getState() { return this.rpc("get_state", this.t()); }
  getTracks(from, to) { return this.rpc("get_tracks", this.t({ p_from: from, p_to: to })); }
  placeHistory(id) { return this.rpc("place_history", this.t({ p_place: id })); }
  setPlaceStatus(id, status, note, at) {
    return this.rpc("set_place_status", this.t({ p_place: id, p_status: status, p_note: note ?? null, p_at: at }));
  }
  setPlaceNote(id, note) { return this.rpc("set_place_note", this.t({ p_place: id, p_note: note })); }
  addPlace(p) {
    return this.rpc("add_place", this.t({ p_name: p.name, p_category: p.category, p_lat: p.lat, p_lon: p.lon, p_note: p.note ?? null }));
  }
  importPlaces(list) { return this.rpc("import_places", this.t({ p_places: list })); }
  pendingCompaction() { return this.rpc("pending_compaction", this.t()); }
  getRaw(g, day, maxId) { return this.rpc("get_raw", this.t({ p_group: g, p_day: day, p_max_id: maxId })); }
  saveTrack(g, day, maxId, lines, matched) {
    return this.rpc("save_track", this.t({ p_group: g, p_day: day, p_max_id: maxId, p_lines: lines, p_matched: matched }));
  }
  createGroup(name, color) { return this.rpc("create_group", this.t({ p_name: name, p_color: color })); }
  updateGroup(id, { name = null, color = null, active = null, newPin = false } = {}) {
    return this.rpc("update_group", this.t({ p_id: id, p_name: name, p_color: color, p_active: active, p_new_pin: newPin }));
  }
  setBlacklist(list) { return this.rpc("set_blacklist", this.t({ p_list: list })); }
  changeAdminPin(oldPin, newPin) { return this.rpc("change_admin_pin", this.t({ p_old: oldPin, p_new: newPin })); }
  ownTracksUrl() { return `${this.url}/functions/v1/owntracks`; }
}



// ---------------------------------------------------------------------
// Demo (localStorage) — mismo comportamiento que el servidor
// ---------------------------------------------------------------------
const DEMO_KEY = "mv_demo_db";
const DEFAULT_BLACKLIST = [
  "grido", "freddo", "luccianos", "rapanui", "chungo", "persicco", "cremolatti", "jauja", "volta", "situ",
  "havanna", "starbucks", "cafe martinez", "bonafide", "mcdonalds", "burger king", "mostaza", "subway", "kfc",
  "carrefour", "coto", "jumbo", "disco", "vea", "changomas",
];
const localDay = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

class DemoApi {
  constructor() {
    this.demo = true;
    this.token = localStorage.getItem("mv_token");
    this.db = JSON.parse(localStorage.getItem(DEMO_KEY) || "null") || this.seed();
  }
  save() { localStorage.setItem(DEMO_KEY, JSON.stringify(this.db)); }
  seq(name) { this.db.seq[name] = (this.db.seq[name] || 0) + 1; return this.db.seq[name]; }
  delay(v) { return new Promise((r) => setTimeout(() => r(structuredClone(v)), 120)); }
  fail(code) { return Promise.reject(new Error(code)); }

  seed() {
    this.db = { seq: {}, adminPin: "246810", blacklist: DEFAULT_BLACKLIST, groups: [], places: [], events: [],
                points: [], tracks: [], sessions: {} };
    for (const x of PRELOADED_PLACES) {
      const isBl = DEFAULT_BLACKLIST.some(b => x.name.toLowerCase().includes(b.toLowerCase()));
      if (!isBl) {
        this.db.places.push({ id: this.seq("p"), ...x, status: "pendiente", note: null, status_at: null, status_group: null, created_group: null });
      }
    }
    this.save();
    return this.db;
  }



  sess() {
    const s = this.db.sessions[this.token];
    if (!s) throw new Error("SESION_INVALIDA");
    if (s.group_id && !this.db.groups.find((g) => g.id === s.group_id)?.active) throw new Error("GRUPO_INACTIVO");
    return s;
  }
  async guard(fn) { try { return await this.delay(fn()); } catch (e) { return this.fail(e.message); } }
  admin() { const s = this.sess(); if (!s.is_admin) throw new Error("SOLO_ADMIN"); return s; }
  dayOf(ts) { return localDay(new Date(ts * 1000)); }

  hasSession() { return !!this.token; }
  login(pin, color) {
    return this.guard(() => {
      const tok = Math.random().toString(36).slice(2) + Date.now().toString(36);
      if (pin === this.db.adminPin) {
        this.db.sessions[tok] = { is_admin: true, group_id: null };
      } else {
        const name = pin.trim();
        let g = this.db.groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!g) {
          g = { id: this.seq("g"), name, color: color || "#ff0000", active: true, ot_user: "grupo" + Date.now(), pin: "000000" };
          this.db.groups.push(g);
        } else if (color) {
          g.color = color;
        }
        this.db.sessions[tok] = { is_admin: false, group_id: g.id };
      }
      this.save();
      this.token = tok; localStorage.setItem("mv_token", tok);
      const s = this.db.sessions[tok];
      return { token: tok, role: s.is_admin ? "admin" : "group", group_id: s.group_id };
    });
  }
  async logout() { delete this.db.sessions[this.token]; this.save(); this.token = null; localStorage.removeItem("mv_token"); }
  getState() {
    return this.guard(() => {
      const s = this.sess();
      const groups = this.db.groups.map((g) => s.is_admin ? g : { id: g.id, name: g.name, color: g.color, active: g.active });
      return { me: { role: s.is_admin ? "admin" : "group", group_id: s.group_id }, groups, places: this.db.places,
               blacklist: this.db.blacklist, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, today: localDay() };
    });
  }
  getTracks(from, to) {
    return this.guard(() => {
      this.sess();
      const inR = (d) => (!from || d >= from) && (!to || d <= to);
      const raw = {};
      for (const p of this.db.points) {
        const day = this.dayOf(p.ts);
        if (!inR(day)) continue;
        const k = p.group_id + "|" + day;
        (raw[k] ||= { group_id: p.group_id, day, pts: [] }).pts.push([p.lon, p.lat, p.ts, p.acc, p.device]);
      }
      for (const r of Object.values(raw)) r.pts.sort((a, b) => (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : a[2] - b[2]));
      return { tracks: this.db.tracks.filter((t) => inR(t.day)), raw: Object.values(raw) };
    });
  }
  placeHistory(id) {
    return this.guard(() => { this.sess(); return this.db.events.filter((e) => e.place_id === id).sort((a, b) => (a.at < b.at ? 1 : -1)); });
  }
  setPlaceStatus(id, status, note, at) {
    return this.guard(() => {
      const s = this.sess();
      const p = this.db.places.find((x) => x.id === id);
      if (!p) throw new Error("LOCAL_NO_EXISTE");
      const when = at && at < new Date().toISOString() ? at : new Date().toISOString();
      this.db.events.push({ id: this.seq("e"), place_id: id, group_id: s.group_id, status, note: note ?? null, at: when });
      if (!p.status_at || p.status_at <= when) Object.assign(p, { status, status_at: when, status_group: s.group_id, note: note ?? p.note });
      this.save();
      return p;
    });
  }
  setPlaceNote(id, note) {
    return this.guard(() => {
      this.sess();
      const p = this.db.places.find((x) => x.id === id);
      if (!p) throw new Error("LOCAL_NO_EXISTE");
      p.note = (note || "").trim() || null; this.save(); return p;
    });
  }
  addPlace({ name, category, lat, lon, note }) {
    return this.guard(() => {
      const s = this.sess();
      const p = { id: this.seq("p"), osm_id: null, name: (name || "").trim() || "Local sin nombre", category, address: null, lat, lon,
                  status: "pendiente", note: (note || "").trim() || null, status_at: null, status_group: null, created_group: s.group_id };
      this.db.places.push(p); this.save(); return p;
    });
  }
  importPlaces(list) {
    return this.guard(() => {
      const s = this.sess();
      let n = 0;
      for (const x of list) {
        const ex = this.db.places.find((p) => p.osm_id === x.osm_id);
        if (ex) { ex.name = x.name; ex.category = x.category; ex.address = x.address ?? ex.address; continue; }
        this.db.places.push({ id: this.seq("p"), ...x, status: "pendiente", note: null, status_at: null, status_group: null, created_group: s.group_id });
        n++;
      }
      this.save(); return n;
    });
  }
  pendingCompaction() {
    return this.guard(() => {
      this.sess();
      const today = localDay(), m = {};
      for (const p of this.db.points) {
        const day = this.dayOf(p.ts);
        if (day >= today) continue;
        const k = p.group_id + "|" + day;
        const e = (m[k] ||= { group_id: p.group_id, day, max_id: 0, n: 0 });
        e.max_id = Math.max(e.max_id, p.id); e.n++;
      }
      return Object.values(m);
    });
  }
  getRaw(g, day, maxId) {
    return this.guard(() => {
      this.sess();
      return this.db.points.filter((p) => p.group_id === g && p.id <= maxId && this.dayOf(p.ts) === day)
        .sort((a, b) => a.ts - b.ts).map((p) => [p.lon, p.lat, p.ts, p.acc, p.device]);
    });
  }
  saveTrack(g, day, maxId, lines, matched) {
    return this.guard(() => {
      this.sess();
      const before = this.db.points.length;
      this.db.points = this.db.points.filter((p) => !(p.group_id === g && p.id <= maxId && this.dayOf(p.ts) === day));
      if (this.db.points.length === before) return false;
      const t = this.db.tracks.find((x) => x.group_id === g && x.day === day);
      if (t) { t.lines.push(...lines); t.matched = t.matched && matched; }
      else this.db.tracks.push({ group_id: g, day, lines, matched });
      this.save(); return true;
    });
  }
  newPin() {
    let pin;
    do { pin = String(100000 + Math.floor(Math.random() * 899999)); }
    while (pin === this.db.adminPin || this.db.groups.some((g) => g.pin === pin));
    return pin;
  }
  createGroup(name, color) {
    return this.guard(() => {
      this.admin();
      const id = this.seq("g");
      const g = { id, name: name.trim(), color, active: true, ot_user: "grupo" + id, pin: this.newPin() };
      this.db.groups.push(g); this.save(); return g;
    });
  }
  updateGroup(id, { name = null, color = null, active = null, newPin = false } = {}) {
    return this.guard(() => {
      this.admin();
      const g = this.db.groups.find((x) => x.id === id);
      if (name?.trim()) g.name = name.trim();
      if (color) g.color = color;
      if (active !== null) g.active = active;
      if (newPin) g.pin = this.newPin();
      if (newPin || !g.active) for (const [k, s] of Object.entries(this.db.sessions)) if (s.group_id === id) delete this.db.sessions[k];
      this.save(); return g;
    });
  }
  setBlacklist(list) { return this.guard(() => { this.admin(); this.db.blacklist = list; this.save(); return null; }); }
  changeAdminPin(oldPin, newPin) {
    return this.guard(() => {
      this.admin();
      if ((newPin || "").length < 6) throw new Error("PIN_CORTO");
      if (oldPin !== this.db.adminPin) throw new Error("PIN_INCORRECTO");
      if (this.db.groups.some((g) => g.pin === newPin)) throw new Error("PIN_EN_USO");
      this.db.adminPin = newPin; this.save(); return null;
    });
  }
  ownTracksUrl() { return "https://TU-PROYECTO.supabase.co/functions/v1/owntracks"; }
  resetDemo() { localStorage.removeItem(DEMO_KEY); localStorage.removeItem("mv_token"); }
}

export const api = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY
  ? new SupabaseApi(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY)
  : new DemoApi();
