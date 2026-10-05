// Utilidades geográficas: cortar recorridos en tramos, simplificar y "pegar" a las calles (OSRM).
import { CONFIG } from "./config.js";

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function distM(a, b) {
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const LIMITS = {
  foot: { maxAcc: 40, maxSpeed: 4, maxGapS: 600, maxJumpM: 400 },
  bike: { maxAcc: 50, maxSpeed: 12, maxGapS: 600, maxJumpM: 1000 },
  car:  { maxAcc: 60, maxSpeed: 40, maxGapS: 600, maxJumpM: 3000 },
};

/**
 * pts: [[lon, lat, tsUnix, acc, device], ...] ordenados por device y ts.
 * Devuelve tramos [[[lon,lat,ts], ...], ...] sin saltos imposibles ni puntos imprecisos.
 */
export function segmentPoints(pts, profile = CONFIG.PROFILE) {
  const L = LIMITS[profile] || LIMITS.foot;
  const segs = [];
  let cur = [], prev = null;
  for (const p of pts) {
    const [lon, lat, ts, acc, dev] = p;
    if (acc != null && acc > L.maxAcc) continue;
    const pt = [lon, lat, ts];
    if (prev) {
      const dt = ts - prev.ts, d = distM(prev.pt, pt);
      const newSeg = dev !== prev.dev || dt > L.maxGapS || d > L.maxJumpM;
      if (!newSeg && dt > 0 && d / dt > L.maxSpeed * 2.5) continue; // salto de GPS: lo ignoramos
      if (newSeg) { if (cur.length > 1) segs.push(cur); cur = []; }
      if (!newSeg && d < 3) continue; // quieto: no sumamos puntos
    }
    cur.push(pt);
    prev = { pt, ts, dev };
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// Douglas-Peucker con tolerancia en metros
export function simplify(line, tolM = 4) {
  if (line.length < 3) return line.slice();
  const lat0 = toRad(line[0][1]);
  const xy = line.map((p) => [toRad(p[0]) * R * Math.cos(lat0), toRad(p[1]) * R]);
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = xy[s], [x2, y2] = xy[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = xy[i];
      let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return line.filter((_, i) => keep[i]);
}

function downsample(line, minM) {
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) if (distM(out[out.length - 1], line[i]) >= minM) out.push(line[i]);
  out.push(line[line.length - 1]);
  return out;
}

const round = (line) => line.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pega un tramo a las calles usando el servidor OSRM público de FOSSGIS. */
async function matchLine(line, profile) {
  const pts = downsample(line, profile === "foot" ? 12 : 25);
  if (pts.length < 2) return null;
  const out = [];
  const CHUNK = 90;
  for (let i = 0; i < pts.length - 1; i += CHUNK - 1) {
    const chunk = pts.slice(i, i + CHUNK);
    if (chunk.length < 2) break;
    const coords = chunk.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
    const radiuses = chunk.map(() => 25).join(";");
    let tsOk = chunk.every((p, k) => p[2] && (k === 0 || p[2] > chunk[k - 1][2]));
    const ts = tsOk ? `&timestamps=${chunk.map((p) => p[2]).join(";")}` : "";
    const url = `https://routing.openstreetmap.de/routed-${profile}/match/v1/driving/${coords}` +
      `?overview=full&geometries=geojson&gaps=split&tidy=true&radiuses=${radiuses}${ts}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.code !== "Ok" || !j.matchings?.length) return null;
    for (const m of j.matchings) out.push(m.geometry.coordinates);
    await sleep(1100); // respetamos el límite del servidor gratuito
  }
  return out;
}

/**
 * Convierte los puntos crudos de un día en líneas compactas pegadas a las calles.
 * Si el servidor de calles no responde, guarda la línea simplificada igual (nunca se pierde nada).
 */
export async function compactDay(rawPts, profile = CONFIG.PROFILE) {
  const segs = segmentPoints(rawPts, profile);
  const lines = [];
  let matchedAll = true;
  for (const seg of segs) {
    let m = null;
    try { m = await matchLine(seg, profile); } catch { m = null; }
    if (m && m.length) lines.push(...m.map((l) => round(simplify(l, 2))));
    else { matchedAll = false; lines.push(round(simplify(seg, 5))); }
  }
  return { lines: lines.filter((l) => l.length > 1), matched: matchedAll };
}

/** Para mostrar el día de hoy en vivo (sin pegar a calles, sólo limpio y simplificado). */
export function liveLines(rawPts, profile = CONFIG.PROFILE) {
  return segmentPoints(rawPts, profile).map((s) => round(simplify(s, 4)));
}
