// Búsqueda de locales potenciales en OpenStreetMap (gratis, vía Overpass API)

export const CATEGORIES = {
  cafe: "Cafetería",
  restaurant: "Restaurante",
  fast_food: "Comida rápida",
  ice_cream: "Heladería",
  bar: "Bar",
  pub: "Bar",
  kiosk: "Kiosco",
  convenience: "Almacén / Autoservicio",
  supermarket: "Supermercado",
  bakery: "Panadería",
  pastry: "Pastelería",
  confectionery: "Golosinas / Confitería",
  deli: "Fiambrería / Rotisería",
  greengrocer: "Verdulería",
  coffee: "Café",
  food: "Comercio de alimentos",
  otro: "Otro",
};

const AMENITIES = ["cafe", "restaurant", "fast_food", "ice_cream", "bar", "pub"];
const SHOPS = ["kiosk", "convenience", "supermarket", "bakery", "pastry", "confectionery", "deli", "coffee", "food"];

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** true si el local pertenece a una cadena de la lista negra */
export function isBlacklisted(tags, blacklist) {
  const fields = [tags.name, tags.brand, tags.operator, tags["name:es"]].map(normalize).filter(Boolean);
  return blacklist.some((b) => {
    const nb = normalize(b);
    if (!nb) return false;
    return fields.some((f) => f === nb || f.startsWith(nb + " ") || f.endsWith(" " + nb) || f.includes(" " + nb + " ") ||
      (nb.length >= 5 && f.includes(nb)));
  });
}

/**
 * bbox: [oeste, sur, este, norte]
 * Devuelve { places: [...], skipped: n } con los locales ya filtrados.
 */
export async function searchPlaces(bbox, blacklist) {
  const [w, s, e, n] = bbox;
  const b = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:40];
(
  nwr["amenity"~"^(${AMENITIES.join("|")})$"](${b});
  nwr["shop"~"^(${SHOPS.join("|")})$"](${b});
);
out center tags;`;

  let data = null, lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined,
      });
      if (!r.ok) { lastErr = new Error("HTTP " + r.status); continue; }
      data = await r.json();
      break;
    } catch (err) { lastErr = err; }
  }
  if (!data) throw lastErr || new Error("Sin respuesta");

  const places = [];
  let skipped = 0;
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    if (isBlacklisted(t, blacklist)) { skipped++; continue; }
    const cat = t.amenity && AMENITIES.includes(t.amenity) ? t.amenity : t.shop || "otro";
    const addr = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ") || null;
    places.push({
      osm_id: `${el.type[0]}${el.id}`,
      name: t.name || t.brand || "",
      category: cat,
      address: addr,
      lat: +lat.toFixed(6),
      lon: +lon.toFixed(6),
    });
  }
  return { places, skipped };
}
