// Service worker: la app abre sin señal y los mapas ya vistos quedan guardados.
const VERSION = "mv-v3";
const SHELL = [
  "./", "index.html", "css/styles.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "js/app.js", "js/api.js", "js/config.js", "js/colors.js", "js/geo.js", "js/overpass.js", "js/avellaneda.js",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",
  "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",
];
const TILE_CACHE = "mv-tiles";
const MAX_TILES = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Mapas (OpenFreeMap): primero caché, si no hay, red y se guarda
  if (url.hostname.endsWith("openfreemap.org")) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit && !url.pathname.includes("/styles/")) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) { c.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); }
          return res;
        } catch (err) {
          if (hit) return hit;
          throw err;
        }
      })
    );
    return;
  }

  // Archivos de la app: red primero (para tener siempre la última versión) y si no hay señal, caché
  const isShell = url.origin === location.origin || SHELL.includes(req.url);
  if (isShell) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
  }
});
