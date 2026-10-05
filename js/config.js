// =====================================================================
//  CONFIGURACIÓN — lo único que hay que editar
// =====================================================================
export const CONFIG = {
  // Datos de tu proyecto Supabase (Project Settings > API).
  // Si los dejás vacíos, la página funciona en MODO DEMO (datos de prueba en este navegador).
  SUPABASE_URL: "",
  SUPABASE_KEY: "", // "anon public" o "publishable" key (es pública, no pasa nada si se ve)

  // Dónde arranca el mapa: Avellaneda, Buenos Aires
  CENTER: [-58.3653, -34.6623], // [longitud, latitud]
  ZOOM: 14,

  // Cómo se mueven los vendedores: "foot" (a pie), "bike" o "car"
  PROFILE: "foot",

  // Nombre que aparece arriba
  APP_NAME: "Mapa de Ventas",
};
