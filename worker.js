const _cache = new Map(); // Cache LRU de respuestas reales de Gemini (evita gastar cuota + colisión slice(0,200))
const _suggestLimit = new Map(); // ip -> { count, firstTs, lastTs }
const _summLimit = new Map(); // ip -> { count, firstTs, lastTs } para /api/summarize
// FIX SISTÉMICO: hash rápido para cache key (evita colisión prefijo 200)
function hashKey(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31 + s.charCodeAt(i))|0; } return String(h) + '_' + s.length + '_' + s.slice(0,30); }
function lruSet(map, key, val, max=400){ if(map.size>=max){ const first=map.keys().next().value; map.delete(first); } map.set(key,val); }
function isThinkingLeak(s){ return /The user wants a one-sentence summary|Based on the provided context|Key elements to include|Here.?s a thinking process|Analyze the Request|system-reminder|Your operational mode|operational mode|read-only|build mode|markdown format|encabezados y listas cuando ayude/i.test(s || ""); }
// Gemini: único proveedor de IA. Requiere secret GEMINI_API_KEY.
async function callGemini(env, prompt, isQA) {
  if (!env.GEMINI_API_KEY) return { err: "no-gemini-key" };
  const sys = "Eres tutor académico de Eminus Plus. Respondes SIEMPRE en español, claro y directo, con formato markdown breve (encabezados y listas cuando ayude). Nunca muestres procesos internos ni texto en inglés.";
  // 3.5/3.6 verificados con key real; los lite suelen tener más cuota free; 3.8 al final (503 intermitente)
  // thinkingBudget:0 solo en full (el lite lo rechaza con 400); sin thinking la respuesta sale completa
  const models = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"];
  const errs = [];
  // FIX vercel: presupuesto TOTAL de la cascada (~22s). En Cloudflare no existía cap
  // duro de runtime; en Vercel Edge una cascada 4x20s podía morir a mitad (la instancia
  // se corta). Al cruzar el presupuesto se sale sin intentar más modelos.
  const t0 = Date.now();
  const BUDGET_MS = 22000;
  for (const m of models) {
    if (Date.now() - t0 > BUDGET_MS) { errs.push(`gemini budget ${m} (skip)`); continue; }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort("timeout"), 20000);
    const genConfig = { maxOutputTokens: isQA ? 2048 : 800, temperature: 0.4 };
    if (!m.includes("lite")) genConfig.thinkingConfig = { thinkingBudget: 0 };
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        let detail = "";
        try { detail = `: ${JSON.parse(body).error?.message || ""}`.slice(0, 160); } catch { detail = body ? `: ${body.slice(0, 160)}` : ""; }
        errs.push(`gemini HTTP ${r.status} ${m}${detail}`);
        continue;
      }
      const j = await r.json().catch(() => ({}));
      if (j.error) { errs.push(`gemini ERR ${m}: ${String(j.error.message || j.error).slice(0, 160)}`); continue; }
      let text = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
      if (!text) { errs.push(`gemini empty ${m}`); continue; }
      // Sanea bloques de instructivo (cerrados o sin cerrar): nunca son parte de la respuesta
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").replace(/<system-reminder[\s\S]*$/gi, "").trim();
      if (!text) { errs.push(`gemini reminder-only ${m}`); continue; }
      if (isThinkingLeak(text)) { errs.push(`gemini thinking-leak ${m}`); continue; }
      return { text, model: m };
    } catch (e) { clearTimeout(t); errs.push(`gemini ${m}: ${e.name === "AbortError" ? "timeout" : (e.message || e)}`); }
  }
  return { err: errs.join(" | ") || "gemini-failed" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    // FIX SISTÉMICO: CORS restringido + candado por ID (ver abajo): /api/* solo
    // extension oficial tras la gracia; unveiled: eminus.uv.mx, workers.dev, localhost.
    const allowed = !origin || origin.includes('eminus.uv.mx') || origin.includes('uv.mx') || origin.startsWith('chrome-extension://') || origin.includes('workers.dev') || origin.includes('localhost');
    const cors = {
      "Access-Control-Allow-Origin": allowed ? (origin || "*") : "https://eminus.uv.mx",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // Candado por instalacion: solo la extension oficial desbloquea /api/*.
    // Gracia hasta GRACE_UNTIL para versiones ya instaladas; despues, 403.
    const EXT_ID = 'chrome-extension://hhmkanfafjomoffacpahenjnehfcnhaj';
    const GRACE_UNTIL = Date.parse('2026-10-23T00:00:00Z');
    if (url.pathname.startsWith("/api/")) {
      const legacyOk = !origin || origin.includes('uv.mx') || origin.startsWith('chrome-extension://') || origin.includes('workers.dev') || origin.includes('localhost');
      if (origin !== EXT_ID) {
        if (Date.now() < GRACE_UNTIL && legacyOk) {
          cors["X-EP-Grace"] = 'id-required-after-2026-10-23';
        } else {
          return new Response(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
        }
      }
    }
    // Salud
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, service: "eminus-uvplus-ai", endpoints: ["/api/summarize", "/api/description", "/api/suggest", "/api/miuv/*", "/api/unlock"] }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    // FIX SISTÉMICO: Proxy MiUV — evita CORS redirect a www.uv.mx
    if (url.pathname.startsWith("/api/miuv/")) {
      const path = url.pathname.slice("/api/miuv/".length);
      const search = url.search;
      const targetUrl = `https://dsiapes.uv.mx/MiUVestudiantes/portales/estudiantes/${path}${search}`;
      const cookie = req.headers.get('Cookie') || '';
      const referer = req.headers.get('Referer') || 'https://eminus.uv.mx/eminus4/page/course/list';
      const userAgent = req.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      try {
        const resp = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Cookie': cookie,
            'Referer': referer,
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-419,es-US;q=0.9,es;q=0.8',
          },
          credentials: 'include',
          redirect: 'follow',
          signal: controller.signal
        });
        clearTimeout(t);
        const html = await resp.text();
        // Detecta redirect a login o www.uv.mx
        const finalUrl = resp.url;
        if (finalUrl.includes('www.uv.mx') || finalUrl.toLowerCase().includes('login')) {
          return new Response(JSON.stringify({ error: 'SESSION_EXPIRED', redirectUrl: finalUrl }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
        }
        // FIX 503: el upstream (dsiapes) respondió 5xx/4xx/503 — NO se entrega como 200.
        // Antes una página de error IIS/dsiapes salía como HTML "exitoso" y la extensión
        // la cacheaba como horario/calificaciones válidas.
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: 'UPSTREAM_HTTP', upstream: resp.status }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
        }
        if (!html || html.length < 500) {
          return new Response(JSON.stringify({ error: 'UPSTREAM_EMPTY' }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
        }
        return new Response(html, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
      } catch (e) {
        clearTimeout(t);
        return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }
    // Desbloqueo de rutas: entrega la clave solo a instalaciones validas
    // (el candado de arriba ya verifico el origen). Requiere secreto EP_URL_KEY.
    if (url.pathname === "/api/unlock") {
      if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
      if (!env.EP_URL_KEY) return new Response(JSON.stringify({ error: "unlock no configurado" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ key: env.EP_URL_KEY, ver: env.EP_URL_KEY_VER || "1" }), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    // Buzón sugerencias — POST /api/suggest (anti-spam profesional, sin exponer webhook)
    if (url.pathname === "/api/suggest") {
      if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
      try {
        const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
        const body = await req.json().catch(()=>({}));
        const type = String(body.type||"").trim().toLowerCase();
        const message = String(body.message||"").trim();
        const email = String(body.email||"").trim().slice(0,120);
        const page = String(body.page||"").trim().slice(0,300);
        const hp = String(body.hp||"").trim(); // honeypot
        const ts = Number(body.ts||0);
        // honeypot
        if (hp) return new Response(JSON.stringify({ error: "Spam detectado" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        // validaciones
        if (!["idea","bug","otro"].includes(type)) return new Response(JSON.stringify({ error: "Tipo inválido" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        if (message.length < 10) return new Response(JSON.stringify({ error: "Mensaje muy corto" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        if (message.length > 1000) return new Response(JSON.stringify({ error: "Mensaje muy largo" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return new Response(JSON.stringify({ error: "Email inválido" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        // timestamp anti-bypass (debe ser reciente 2min)
        if (ts && Math.abs(Date.now()-ts) > 120000) return new Response(JSON.stringify({ error: "Timestamp inválido" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        // rate limit
        const now = Date.now();
        let rec = _suggestLimit.get(ip);
        if (!rec || now - rec.firstTs > 3600000) rec = { count:0, firstTs: now, lastTs: 0 };
        if (now - rec.lastTs < 60000) return new Response(JSON.stringify({ error: "Espera 60s entre envíos" }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
        if (rec.count >= 5) return new Response(JSON.stringify({ error: "Límite 5/hora alcanzado" }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
        // contenido spam: demasiados links
        const linkCount = (message.match(/https?:\/\//g)||[]).length;
        if (linkCount > 3) return new Response(JSON.stringify({ error: "Demasiados enlaces" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
        // webhook secreto
        const webhook = env.DISCORD_WEBHOOK_URL || env.DISCORD_SUGGEST_WEBHOOK;
        if (!webhook) return new Response(JSON.stringify({ error: "Buzón no configurado" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
        // construye embed Discord profesional
        const typeEmoji = type==="bug"?"🐞": type==="idea"?"💡":"💬";
        const color = type==="bug"? 15548997 : type==="idea"? 5763719 : 5793266;
        const id = Math.random().toString(36).slice(2,8).toUpperCase();
        const embed = {
          title: `${typeEmoji} Nueva sugerencia [${id}] · ${type}`,
          color,
          description: message.slice(0, 900),
          fields: [
            ...(email ? [{ name:"✉️ Email", value: email.slice(0,100), inline:true }] : []),
            { name:"🌐 Página", value: page ? page.slice(0,200) : "https://eminus.uv.mx", inline:true },
            { name:"📅 Fecha", value: new Date().toLocaleString("es-MX",{ timeZone:"America/Mexico_City" }), inline:true },
            { name:"🛡️ IP", value: ip.slice(0,30), inline:true }
          ],
          footer: { text: `Eminus Plus · ${id} · anti-spam v1` },
          timestamp: new Date().toISOString()
        };
        const discordRes = await fetch(webhook, {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ embeds:[embed], username:"Eminus Plus Buzón", avatar_url:"https://eminus.uv.mx/favicon.ico" })
        });
        if (!discordRes.ok) {
          const t = await discordRes.text().catch(()=> "");
          return new Response(JSON.stringify({ error:"Discord error "+discordRes.status, detail:t.slice(0,200) }), { status: 502, headers:{ ...cors,"Content-Type":"application/json" } });
        }
        rec.count++; rec.lastTs = now; _suggestLimit.set(ip, rec);
        return new Response(JSON.stringify({ ok:true, id }), { headers:{ ...cors,"Content-Type":"application/json" } });
      } catch(e){
        return new Response(JSON.stringify({ error:e.message||String(e) }), { status:500, headers:{ ...cors,"Content-Type":"application/json" } });
      }
    }
    // FIX SISTÉMICO: rate-limit para /api/summarize — evita spam que trababa por 429 free tier
    if (url.pathname === "/api/summarize" || url.pathname === "/api/description") {
      const ipS = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const nowS = Date.now();
      let recS = _summLimit.get(ipS);
      if (!recS || nowS - recS.firstTs > 60000) recS = { count:0, firstTs: nowS };
      if (recS.count >= 30) return new Response(JSON.stringify({ error: "Rate limit 30/min — espera 1 min" }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
      recS.count++; _summLimit.set(ipS, recS);
      // Limpieza periódica del map para no crecer infinito
      if(_summLimit.size>500){ const k=_summLimit.keys().next().value; _summLimit.delete(k); }
    }
    // Solo POST /api/*
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }

    try {
      const body = await req.json().catch(() => ({}));
      const raw = body.description ?? body.text ?? body.prompt ?? "";
      const input = String(raw).slice(0, 8000);
      if (!input.trim()) {
        return new Response(JSON.stringify({ summary: "Sin descripción" }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      // Limpia HTML + system-reminder (evita que el modelo lo incluya en thinking)
      const clean = input.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);

      // Detecta si es Q&A (contiene Pregunta:) o resumen — todo pasa por Gemini
      const isQA = /Pregunta\s*:/i.test(clean);
      const prompt = isQA ? clean : `Resume en 1 frase en español máximo 25 palabras: ${clean}`;
      let lastErr = null;

      // Solo Gemini: único proveedor, sin nada local
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY no configurada como secret" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      }
      {
        const g = await callGemini(env, prompt, isQA);
        if (g.text) {
          const hk = hashKey(clean); lruSet(_cache, hk, g.text, 400);
          return new Response(JSON.stringify({ summary: g.text, model: g.model || "gemini" }), { headers: { ...cors, "Content-Type": "application/json" } });
        }
        lastErr = g.err || "gemini-failed";
      }
      // Gemini falló: se sirve caché de una respuesta real anterior, si existe; si no, error real
      const hk2=hashKey(clean);
      if (_cache.has(hk2)) {
        return new Response(JSON.stringify({ summary: _cache.get(hk2), cached: true }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "IA no disponible — Gemini falló, reintenta en unos segundos", lastErr }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }
}
