// api/ep.js — Handler Vercel (Edge runtime) que reexporta la MISMA lógica de worker.js.
// Fuente única: worker.js se queda exacto (mismo archivo vive en Cloudflare durante la
// transición). Vercel ejecuta Web APIs estándar (fetch/Request/Response/AbortController/atob),
// así que el handler solo inyecta el objeto env que el módulo espera.
import ep from '../worker.js';

export const config = { runtime: 'edge' };

function envFromProcess() {
  return {
    GEMINI_API_KEY: (process.env && process.env.GEMINI_API_KEY) || undefined,
    EP_URL_KEY: (process.env && process.env.EP_URL_KEY) || undefined,
    EP_URL_KEY_VER: (process.env && process.env.EP_URL_KEY_VER) || undefined,
    DISCORD_WEBHOOK_URL: (process.env && process.env.DISCORD_WEBHOOK_URL) || undefined,
    DISCORD_SUGGEST_WEBHOOK: (process.env && process.env.DISCORD_SUGGEST_WEBHOOK) || undefined,
  };
}

export default function handler(request) {
  // Defensa anti-rewrite: si el runtime entregara el path de destino (/api/ep) en vez
  // del path original del cliente, lo dejamos visible en logs (perdón: 404s migración).
  try {
    const p = new URL(request.url).pathname;
    if (p === '/api/ep') console.warn('[ep] rewrite altero request.url -> revisar rutas /api/*');
  } catch {}
  return ep.fetch(request, envFromProcess());
}
