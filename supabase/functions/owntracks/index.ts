// =====================================================================
//  Edge Function "owntracks" — recibe el GPS que manda la app OwnTracks
//  Supabase > Edge Functions > Deploy a new function > Via Editor
//  Nombre: owntracks   ·   Pegar este código   ·   Deploy
//  IMPORTANTE: en la configuración de la función, desactivar "Verify JWT"
//  (OwnTracks se autentica con usuario y PIN del grupo, no con JWT).
// =====================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBasicAuth(req: Request): { user: string; pass: string } | null {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = atob(h.slice(6).trim());
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, info: "OwnTracks endpoint" });

  const auth = parseBasicAuth(req);
  if (!auth) return json({ error: "auth" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json([]);
  }

  // OwnTracks manda un objeto por request; aceptamos también listas por las dudas.
  const msgs = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
  const points = msgs
    .filter((m) => m && m._type === "location" && typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => ({ lat: m.lat, lon: m.lon, tst: m.tst ?? Math.floor(Date.now() / 1000), acc: m.acc ?? null }));

  if (points.length === 0) return json([]);

  const device =
    req.headers.get("x-limit-d") ??
    (typeof msgs[0]?.tid === "string" ? (msgs[0].tid as string) : "") ??
    "";

  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_points`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_user: auth.user, p_pin: auth.pass, p_device: device, p_points: points }),
  });

  if (!r.ok) {
    const txt = await r.text();
    if (txt.includes("CREDENCIALES_INVALIDAS")) return json({ error: "credenciales" }, 401);
    console.error("ingest error", r.status, txt);
    return json({ error: "server" }, 500); // OwnTracks reintentará más tarde
  }
  // OwnTracks espera un array JSON como respuesta
  return json([]);
});
