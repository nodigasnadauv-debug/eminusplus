// Eminus Plus (c) 2026 - Todos los derechos reservados.
// Prohibida su copia, reproduccion o uso no autorizado. Ver LICENSE.
// Background script for the Eminus extension — v3.0 robusto sin reintentos-contador
// ROBUSTEZ: sesión MiUV asegurada ANTES de pedir datos (ensure), no después del error.
// Credenciales en espejo session+local, flag de sesión, single-flight global, timeouts cortos.

// Dual storage: session (efímera) + local (respaldo ante reinicio del SW)
async function credsWrite(creds) {
  const payload = { ep_miuv_creds: creds };
  try { if (chrome.storage.session) await chrome.storage.session.set(payload); } catch {}
  try { await chrome.storage.local.set(payload); } catch {}
}
async function credsRead() {
  try {
    if (chrome.storage.session) {
      const s = await chrome.storage.session.get(['ep_miuv_creds']).catch(()=>null);
      if (s && s.ep_miuv_creds && s.ep_miuv_creds.username) return s.ep_miuv_creds;
    }
  } catch {}
  try {
    const l = await chrome.storage.local.get(['ep_miuv_creds']).catch(()=>null);
    if (l && l.ep_miuv_creds && l.ep_miuv_creds.username) {
      // Rehidrata session si se perdió por reinicio del SW
      try { if (chrome.storage.session) await chrome.storage.session.set({ ep_miuv_creds: l.ep_miuv_creds }); } catch {}
      return l.ep_miuv_creds;
    }
  } catch {}
  return null;
}
async function credsClear() {
  try { if (chrome.storage.session) await chrome.storage.session.remove(['ep_miuv_creds']); } catch {}
  try { await chrome.storage.local.remove(['ep_miuv_creds']); } catch {}
}

// Flag de sesión MiUV válida (memoria + persistido para sobrevivir reinicios del SW)
let _miuvSessionOk = false;
let _miuvSessionTs = 0;
const MIUV_SESSION_TTL = 30 * 60 * 1000;
async function loadSessionFlag() {
  try {
    const d = await chrome.storage.local.get(['ep_miuv_session']).catch(()=>null);
    if (d && d.ep_miuv_session && d.ep_miuv_session.ok) {
      _miuvSessionOk = true;
      _miuvSessionTs = d.ep_miuv_session.ts || 0;
    }
  } catch {}
}
async function setSessionFlag(ok) {
  _miuvSessionOk = ok;
  _miuvSessionTs = ok ? Date.now() : 0;
  try {
    if (ok) await chrome.storage.local.set({ ep_miuv_session: { ok: true, ts: _miuvSessionTs } });
    else await chrome.storage.local.remove(['ep_miuv_session']);
  } catch {}
}
function isSessionFresh() {
  return _miuvSessionOk && (Date.now() - _miuvSessionTs) < MIUV_SESSION_TTL;
}
loadSessionFlag();

// TAXONOMÍA ÚNICA de errores (sin contadores): el caller no reintenta, solo clasifica.
function classifyMiuvError(msg) {
  const m = String(msg || '');
  if (/Credenciales inválidas|INVALID_CREDS/i.test(m)) return 'INVALID_CREDS';
  if (/captcha|bloquead|NEEDS_MANUAL|redirigió|sitio principal|verificación manual|contenido inesperado|no confirmó la sesión/i.test(m)) return 'NEEDS_MANUAL';
  if (/sesión|No hay sesión|SESSION/i.test(m)) return 'SESSION';
  if (/Failed to fetch|NetworkError|aborted|HTTP|NETWORK/i.test(m)) return 'NETWORK';
  return 'UNKNOWN';
}

// FIX: Limpia credenciales cuando Eminus cierra sesión — evita persistencia huérfana
async function clearStoredCreds() {
  try {
    await credsClear();
    await setSessionFlag(false);
    console.log('[EP] Credenciales MiUV limpiadas (sesión Eminus terminada)');
  } catch (e) { console.warn('[EP] clear creds error', e); }
  // FIX SISTÉMICO: Limpiar también caché de horario + MiUV (todos los periodos dinámicos) para no mostrar datos de usuario anterior tras logout
  try {
    const all = await chrome.storage.local.get();
    const toRemove = Object.keys(all).filter(k => k.startsWith('ep_grades') || k.startsWith('ep_avance') || k.startsWith('ep_schedule') || k.startsWith('ep_exams') || k === 'ep_miuv_session');
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
    console.log('[EP] Cachés MiUV limpiados tras logout', toRemove.length);
  } catch {}
}

async function getStoredCreds() {
  return credsRead();
}

async function storeCreds(username, password) {
  try {
    const prev = await credsRead().catch(()=>null);
    const prevUser = prev ? prev.username : null;
    await credsWrite({ username, password, ts: Date.now() });
    console.log('[EP] Credenciales capturadas localmente para auto-login MiUV (usuario:', username, ')');
    // FIX: Si cambió de usuario, invalidar caché de horario + MiUV anterior (todos los periodos dinámicos)
    if (prevUser && prevUser !== username) {
      try {
        const all = await chrome.storage.local.get();
        const toRemove = Object.keys(all).filter(k => k.startsWith('ep_grades') || k.startsWith('ep_avance') || k.startsWith('ep_schedule') || k.startsWith('ep_exams'));
        if (toRemove.length) await chrome.storage.local.remove(toRemove);
        await setSessionFlag(false);
        console.log('[EP] Usuario cambió — cachés MiUV invalidados', toRemove.length);
      } catch {}
    }
  } catch (e) { console.warn('[EP] store creds error', e); }
}

// FIX SISTÉMICO: mutex single-flight para auto-login — evita storm 3 tabs paralelas que trababa y bloqueaba cuenta
let _miuvLoginInflight = null;
let _eminusLoginInflight = null;
// Deduplicación de fetches concurrentes al mismo path (widgets piden a la vez)
const _fetchInflight = new Map();

// FIX SISTÉMICO: Extrae inputs hidden genéricos sin DOMParser (no disponible en SW)
function extractHiddenFields(html) {
  const fields = {};
  const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const nameMatch = tag.match(/name=["']([^"']+)["']/i);
    const valueMatch = tag.match(/value=["']([^"']*)["']/i);
    if (nameMatch) {
      const n = nameMatch[1];
      const v = valueMatch ? valueMatch[1] : '';
      fields[n] = v;
    }
  }
  return fields;
}

function extractSubmitName(html) {
  const m = html.match(/<input[^>]*type=["']submit["'][^>]*name=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  const m2 = html.match(/<button[^>]*type=["']submit["'][^>]*name=["']([^"']+)["'][^>]*>/i);
  if (m2) return m2[1];
  return 'btnLogin';
}

// FIX: Login Eminus con credenciales capturadas — intenta refrescar token 401
async function eminusAutoLogin(username, password){
  if(_eminusLoginInflight) return _eminusLoginInflight;
  _eminusLoginInflight = (async ()=>{
  const loginUrl = 'https://eminus.uv.mx/';
  console.log('[EP] Intentando auto-login Eminus para', username);
  const c1 = new AbortController(); const t1=setTimeout(()=>c1.abort(), 10000);
  try{
    const res = await fetch(loginUrl, {method:'GET', credentials:'include', signal:c1.signal});
    const html = await res.text();
    // intenta extraer endpoint de login del HTML (Angular suele usar /eminusapi/api/Autenticacion)
    const m = html.match(/\/eminusapi\/api\/[^"']*login[^"']*/i) || html.match(/\/eminusapi\/api\/[^"']*autentic/i);
    let apiUrl = m ? 'https://eminus.uv.mx' + m[0] : 'https://eminus.uv.mx/eminusapi/api/Autenticacion/login';
    // intenta POST JSON con credenciales
    const c2 = new AbortController(); const t2=setTimeout(()=>c2.abort(), 10000);
    try{
      const r = await fetch(apiUrl, {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({usuario: username, contrasena: password, username, password}), signal:c2.signal});
      if(r.ok){
        const j = await r.json().catch(()=>null);
        if(j && (j.token || j.accessToken || j.access_token)){
          console.log('[EP] Auto-login Eminus OK (JSON)');
          return true;
        }
      }
    }finally{ clearTimeout(t2); }
    // fallback: intenta form POST clásico
    const hidden = extractHiddenFields(html);
    const params = new URLSearchParams();
    Object.entries(hidden).forEach(([k,v])=> params.append(k,v));
    params.set('username', username); params.set('password', password);
    params.set('txtUser', username); params.set('txtPassword', password);
    const c3 = new AbortController(); const t3=setTimeout(()=>c3.abort(), 10000);
    try{
      const r2 = await fetch(loginUrl, {method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: params.toString(), signal:c3.signal});
      if(r2.ok && !r2.url.includes('login')){ console.log('[EP] Auto-login Eminus OK (form)'); return true; }
    }finally{ clearTimeout(t3); }
    throw new Error('No se pudo refrescar sesión Eminus');
  }finally{ clearTimeout(t1); }
  })().finally(()=>{ _eminusLoginInflight=null; });
  return _eminusLoginInflight;
}
// ROBUSTO: un solo login autoritativo bien hecho (sin loop). Lanza INVALID_CREDS / NEEDS_MANUAL / SESSION.
async function miuvLoginSingle(username, password) {
  await epEnsureUrls();
  const loginUrl = new URL(EP_URLS.bases[0]).origin + '/' + EP_P('login');
  console.log('[EP] Auto-login MiUV (único, autoritativo) para', username);
  // 1. GET login page para ViewState fresco
  const c1 = new AbortController();
  const t1 = setTimeout(() => c1.abort(), 10000);
  let html;
  try {
    const res = await fetch(loginUrl, { method: 'GET', credentials: 'include', redirect: 'follow', signal: c1.signal });
    html = await res.text();
  } finally { clearTimeout(t1); }

  const hidden = extractHiddenFields(html);
  const submitName = extractSubmitName(html);

  // 2. Build form — réplica exacta del payload capturado (incluye hdm*)
  const params = new URLSearchParams();
  Object.entries(hidden).forEach(([k, v]) => params.append(k, v));
  params.set('__EVENTTARGET', '');
  params.set('__EVENTARGUMENT', '');
  params.set('hdmNavega', 'Chrome');
  params.set('hdmSO', 'Windows');
  params.set('hdmDispo', 'Computadora');
  params.set('hdmModCel', '');
  params.set('txtUser', username);
  params.set('txtPassword', password);
  Object.keys(hidden).forEach(k => {
    if (k.toLowerCase().includes('txtuser')) params.set(k, username);
    if (k.toLowerCase().includes('txtpassword')) params.set(k, password);
  });
  // btnValidacion exacto como en captura del usuario
  if (params.has('btnValidacion')) params.set('btnValidacion', 'Iniciar sesión');
  else params.set(submitName, 'Iniciar sesión');

  // 3. POST login (una sola vez). Cadena real verificada en captura:
  // POST login -> 302 con ticket -> portal escritorio. Las cookies
  // viajan solas con credentials:include por ser el navegador real.
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
  const c2 = new AbortController();
  const t2 = setTimeout(() => c2.abort(), 15000);
  try {
    const postRes = await fetch(loginUrl, {
      method: 'POST',
      credentials: 'include',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': UA
      },
      referrer: loginUrl,
      body: params.toString(),
      signal: c2.signal
    });
    const postHtml = await postRes.text();
    const finalUrl = String(postRes.url || '');
    const stillLogin = postHtml.includes('txtUser') || postHtml.includes('txtPassword') || new RegExp('/' + EP_P('login').replace(/\./g, '\\.') + '(\\?|$)', 'i').test(finalUrl);
    const invalid = /contrase.*incorrect|usuario.*no existe|credenciales.*inválid|datos.*incorrectos/i.test(postHtml);
    if (invalid) throw new Error('Credenciales inválidas en MiUV');
    const captcha = /captcha|verificaci[oó]n.*humano|intentos.*excedidos|cuenta.*bloqueada/i.test(postHtml);
    if (captcha) throw new Error('MiUV pide verificación manual (captcha/bloqueo) — abre MiUV una vez');
    if (stillLogin) throw new Error('No hay sesión activa en MiUV');
    // Un POST aceptado pero rebotado a www.uv.mx NO es éxito (no hubo ticket de sesión).
    if (looksUvHomepage(postHtml, finalUrl)) throw new Error('MiUV redirigió al sitio principal tras login — abre MiUV una vez en el navegador');
    // Éxito = cadena del ticket completa: termina en smutiles/escritorio dentro del portal.
    const landedDesk = /smutiles|escritorio/i.test(finalUrl) || new RegExp('smutiles|escritorio|' + EP_URLS.paths.toks + '|divTileHr|span-periodo|cerrar.*sesi|bienvenid', 'i').test(postHtml);
    const inPortal = (() => { try { const o = new URL(finalUrl).origin; return EP_URLS.bases.some(b => { try { return new URL(b).origin === o; } catch { return false; } }); } catch { return /uv\.mx/i.test(finalUrl); } })();
    if (!inPortal || !landedDesk) throw new Error('MiUV no confirmó la sesión — abre MiUV una vez en el navegador');
    if (postHtml.length < 2000) throw new Error('No hay sesión activa en MiUV');
    console.log('[EP] Auto-login MiUV OK');
    await setSessionFlag(true);
    return true;
  } finally { clearTimeout(t2); }
}

// Compat: antes se llamaba miuvAutoLogin desde main.js; ahora es single-flight hacia el login único.
async function miuvAutoLogin(username, password) {
  if (_miuvLoginInflight) return _miuvLoginInflight;
  _miuvLoginInflight = (async () => {
    const u = username, p = password;
    if (!u || !p) {
      const c = await getStoredCreds();
      if (!c || !c.username) throw new Error('Sin credenciales — inicia sesión en Eminus');
      return miuvLoginSingle(c.username, c.password);
    }
    return miuvLoginSingle(u, p);
  })().finally(() => { _miuvLoginInflight = null; });
  return _miuvLoginInflight;
}

// Asegura sesión válida ANTES de pedir datos: si el flag está fresco pasa directo,
// si no hace UN solo login con credenciales guardadas. Sin contadores ni loops.
async function ensureMiuvSession() {
  if (isSessionFresh()) return true;
  if (_miuvLoginInflight) return _miuvLoginInflight;
  const creds = await getStoredCreds();
  if (!creds || !creds.username || !creds.password) throw new Error('Sin credenciales — inicia sesión en Eminus');
  return miuvAutoLogin(creds.username, creds.password);
}

const WORKER_URL = 'https://eminus.uvplus.workers.dev';

// Resumen IA vía Worker proxy (key nunca en cliente)
// El Worker guarda GEMINI_API_KEY como secret y llama a Gemini
// timeoutMs paramétrico: el asistente (cascada de modelos) necesita más aire que un resumen
async function summarizeViaWorker(description, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 9000);
  try {
    // Intenta endpoint /api/summarize primero, fallback a /api/description por compat
    const payload = JSON.stringify({ description });
    let res = await fetch(`${WORKER_URL}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal
    });
    if (!res.ok && (res.status===404 || res.status===405)) {
      // FIX: solo fallback en 404/405 (compat) — antes hacía doble fetch incluso en 400/429 desperdiciando 12s y trabando
      res = await fetch(`${WORKER_URL}/api/description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal
      });
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      try {
        const ej = JSON.parse(errBody);
        const detail = ej.lastErr || ej.error || errBody;
        throw new Error('Worker HTTP ' + res.status + ' — ' + String(detail).slice(0, 300));
      } catch (e) {
        if (e.message && e.message.startsWith('Worker HTTP')) throw e;
        throw new Error('Worker HTTP ' + res.status + ' — ' + errBody.slice(0, 300));
      }
    }
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      if (j.summary) return String(j.summary).trim();
      if (j.answer) return String(j.answer).trim();
      return raw.trim() || 'Sin descripción';
    } catch { return raw.trim() || 'Sin descripción'; }
  } finally { clearTimeout(t); }
}

// Rutas internas protegidas: solo existen descifradas en memoria tras validar
// la instalacion contra el servidor. Nunca en claro en disco ni en consola.
const EP_URLS_VER = '1';
const EP_URLS_ENC = {
  b0: 'WC4mJwkXbR4dKxoCfjRBAy5KYh8sJG5qERwLRygpVzUfPyEjD0krUBcsFhB/',
  b1: 'WC4mJwkXbR4dKxoCICREAzZEYz8dXnUsNCUcQD0wVi9RNCYyCQIyXgssEg81MhhIMEY4NgwQVjEEAFY=',
  horc: 'QyA7PxVfIR8YKwMb',
  calif: 'QyA7JxtOIwNXOQATKA==',
  avance: 'QyA7JxtBIR8YKwMb',
  examen: 'QyA7NR9ObFAKKAs=',
  login: 'XTMnIVVIMVILMQcMIihYAi9dKjsLX1k2EQs=',
  detalle: 'YwAbBzthAQNXGSAzCA==',
  toks: 'QyA7PxVfIU0KIhoTMSJWUTBIJCIEHVs5EgkQUSwm',
};
const EP_URLKEY_CACHE = 'ep_urlkey';
const EP_URLKEY_TTL = 30 * 24 * 3600 * 1000;
let EP_URLS = null;
function epXor(b64, key) {
  const bin = atob(b64);
  const kb = String(key);
  let out = '';
  for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ kb.charCodeAt(i % kb.length));
  return out;
}
function epTryDecrypt(key) {
  try {
    const d = {};
    for (const k of Object.keys(EP_URLS_ENC)) d[k] = epXor(EP_URLS_ENC[k], key);
    if (typeof d.b0 !== 'string' || !d.b0.startsWith('https://') || !d.horc.endsWith('.aspx')) return null;
    return { bases: [d.b0, d.b1], paths: d, ver: EP_URLS_VER };
  } catch { return null; }
}
// Obtiene la clave (cache 30 dias) o la pide al servidor, que solo la
// entrega a instalaciones validas. Descifra una vez: cero costo por request.
async function epEnsureUrls() {
  if (EP_URLS) return EP_URLS;
  try {
    const raw = await chrome.storage.local.get([EP_URLKEY_CACHE]);
    const c = raw[EP_URLKEY_CACHE];
    if (c && c.key && (Date.now() - (c.ts || 0)) < EP_URLKEY_TTL) {
      const d = epTryDecrypt(c.key);
      if (d) { EP_URLS = d; return d; }
    }
  } catch {}
  // Rotacion automatica: la guardada ya no abre -> pide la vigente.
  try { await chrome.storage.local.remove([EP_URLKEY_CACHE]); } catch {}
  const r = await fetch(WORKER_URL + '/api/unlock', { method: 'GET', credentials: 'omit' });
  if (!r.ok) throw new Error('Unlock HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  if (!j.key) throw new Error('Unlock sin clave');
  const nc = { key: String(j.key), ver: String(j.ver || EP_URLS_VER), ts: Date.now() };
  try { await chrome.storage.local.set({ [EP_URLKEY_CACHE]: nc }); } catch {}
  const d2 = epTryDecrypt(nc.key);
  if (!d2) throw new Error('Clave vigente invalida');
  EP_URLS = d2;
  return d2;
}
function EP_P(k) { try { return (EP_URLS && EP_URLS.paths[k]) || ''; } catch { return ''; } }
// Recuerda qué base respondió bien por clave, para que los POST con ViewState
// vayan al MISMO host que entregó el HTML base.
const _miuvBaseUsed = new Map();
function miuvBaseFor(key) {
  try { return _miuvBaseUsed.get(key) || (EP_URLS && EP_URLS.bases[0]) || ''; } catch { return ''; }
}
function looksLoginMiuv(html, url) {
  if (url && String(url).toLowerCase().includes('login')) return true;
  if (!html) return false;
  if (html.includes('txtUser') && html.includes('txtPassword')) return true;
  if (html.includes('id="txtUser"') || html.includes('name="txtUser"')) return true;
  return false;
}
// HALLAZGO PRUEBA REAL (14-oct-2026): MiUV a veces responde con la homepage de www.uv.mx
// (34KB, sin login ni datos). Sin este filtro se marcaba sesión OK y el horario quedaba vacío.
function looksUvHomepage(html, url) {
  if (url && /^https?:\/\/(www\.)?uv\.mx\/?($|[?#])/i.test(String(url))) return true;
  if (!html) return false;
  if (/CollegeOrUniversity/i.test(html) && !/divTile|span-periodo|wucCali|wucAvan|lblMateria|MiUV/i.test(html)) return true;
  return false;
}
function looksMiuvContent(html, path) {
  if (!html) return false;
  const toks = (EP_URLS && EP_URLS.paths.toks) ? EP_URLS.paths.toks : 'divTile|span-periodo';
  if (new RegExp('divTile|span-periodo|lblMateria|wucCali|wucAvan|lblBgPor|dlAvance|lblTituArea|' + toks + '|MiUV', 'i').test(html)) return true;
  return false;
}
// Cap global de concurrencia MiUV (máx 3): horario+califs+avance+exám ya no hacen
// storm de 4 HTML pesados a la vez; el 4º espera slot en cola FIFO. El LOGIN nunca
// espera slot (prioritario). Sin contadores de reintento.
const MIUV_MAX_SLOTS = 3;
let _miuvSlotsUsed = 0;
const _miuvSlotQueue = [];
function pumpMiuvSlot() {
  while (_miuvSlotsUsed < MIUV_MAX_SLOTS && _miuvSlotQueue.length) {
    const run = _miuvSlotQueue.shift();
    try { run(); } catch {}
  }
}
function withMiuvSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _miuvSlotsUsed++;
      Promise.resolve().then(fn).then(
        v => { _miuvSlotsUsed--; pumpMiuvSlot(); resolve(v); },
        e => { _miuvSlotsUsed--; pumpMiuvSlot(); reject(e); }
      );
    };
    if (_miuvSlotsUsed < MIUV_MAX_SLOTS) run();
    else _miuvSlotQueue.push(run);
  });
}
async function fetchMiuvDirect(pathKey, timeoutMs) {
  // Prueba la base vigente y luego el respaldo legacy: las cookies son por host,
  // una puede tener sesión aunque la otra no. Deadline 7s por base (SWR/cache cubre).
  const path = EP_P(pathKey) || pathKey;
  let sawSession = false;
  // FIX 503: recuerda el status HTTP real del upstream. Antes un 503 caía en 'continue'
  // y terminaba reportándose como "MiUV redirigió al sitio principal" (NEEDS_MANUAL),
  // lo que disparaba logins con credenciales y decía "abre MiUV una vez" durante cortes.
  let lastStatus = 0;
  for (const base of EP_URLS.bases) {
    const target = base + path;
    try {
      const got = await withMiuvSlot(async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs || 7000);
        try {
          const resp = await fetch(target, {
            method: 'GET',
            credentials: 'include',
            redirect: 'follow',
            headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            signal: controller.signal
          });
          const h = await resp.text();
          return { h, url: resp.url, ok: resp.ok, status: resp.status };
        } finally { clearTimeout(t); }
      });
      const html = got.h, url = got.url, ok = got.ok;
      if (looksLoginMiuv(html, url)) { sawSession = true; continue; }
      if (looksUvHomepage(html, url)) continue;
      if (!ok) { lastStatus = got.status || lastStatus; continue; }
      if (!html || html.length < 500) continue;
      if (!looksMiuvContent(html, path)) continue;
      _miuvBaseUsed.set(pathKey, base);
      return html;
    } catch (e) {
      // Error de red en esta base: si el mensaje ya clasifica como sesión, anótalo;
      // si no, se intenta la siguiente base. La última propaga.
      if (/sesi[oó]n/i.test(e.message || '')) sawSession = true;
      else if (base === EP_URLS.bases[EP_URLS.bases.length - 1]) throw e;
    }
  }
  if (sawSession) throw new Error('No hay sesión activa en MiUV');
  // FIX 503: status HTTP real del upstream (502/503...) clasifica como NETWORK,
  // no como sesión. Ni login ni "abre MiUV una vez": solo worker/cache/retry.
  if (lastStatus) throw new Error('MiUV HTTP ' + lastStatus);
  throw new Error('MiUV redirigió al sitio principal — abre MiUV una vez en el navegador');
}
// Worker proxy: plan B cuando el directo falla por red/CORS/redirect. Lleva las cookies
// reales de dsiapes vía chrome.declarativeNetRequest (regla de sesión modifyHeaders).
// FIX CRÍTICO: el header Cookie es "forbidden header" en fetch() del SW — Chrome lo
// descarta silenciosamente, así que ANTES el worker pedía a dsiapes SIN cookies y
// siempre rebotaba a login (401 SESSION_EXPIRED). El plan B era un número invertido.
async function ensureDnrWorkerCookieRule(cookieHeader) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
    const rule = {
      id: 1,
      priority: 1,
      condition: {
        urlFilter: '||eminus.uvplus.workers.dev/api/miuv/',
        resourceTypes: ['xmlhttprequest']
      },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Cookie', operation: 'set', value: cookieHeader }
        ]
      }
    };
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [rule] });
  } catch (e) {
    console.warn('[EP] DNR cookie rule error', e && e.message);
  }
}
async function fetchMiuvViaWorker(pathKey) {
  return withMiuvSlot(async () => {
  const path = EP_P(pathKey) || pathKey;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    // Cookies de ambas bases (la sesión vive en la vigente tras el login con ticket)
    const _o0 = new URL(EP_URLS.bases[0]).origin, _o1 = new URL(EP_URLS.bases[1]).origin;
    const [c1, c2] = await Promise.all([
      chrome.cookies.getAll({ url: _o0 }).catch(() => []),
      chrome.cookies.getAll({ url: _o1 }).catch(() => [])
    ]);
    const seen = new Set();
    const cookieHeader = [...c1, ...c2].filter(c => !seen.has(c.name) && seen.add(c.name)).map(c => `${c.name}=${c.value}`).join('; ');
    // FIX: sin cookies de sesión el proxy no tiene nada que reenviar — error de sesión
    // inmediato en lugar de gastar el timeout en un 401 seguro.
    if (!cookieHeader) throw new Error('No hay sesión activa en MiUV');
    // PUT real de cookies: la regla DNR de sesión las viaja al Worker aunque fetch() no permita Cookie
    await ensureDnrWorkerCookieRule(cookieHeader);
    const response = await fetch(`${WORKER_URL}/api/miuv/${path}`, {
      method: 'GET',
      headers: {
        'Referer': 'https://eminus.uv.mx/eminus4/page/course/list',
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.error === 'SESSION_EXPIRED') throw new Error('No hay sesión activa en MiUV');
      if (err.error === 'UPSTREAM_HTTP' || err.error === 'UPSTREAM_EMPTY') {
        // FIX: el worker ya valida el upstream — 502 = portal caído/resp vacía, NO sesión
        throw new Error('MiUV HTTP ' + (err.upstream || 502));
      }
      throw new Error('Worker HTTP ' + response.status);
    }
    const html = await response.text();
    if (looksLoginMiuv(html, '')) throw new Error('No hay sesión activa en MiUV');
    if (looksUvHomepage(html, '')) throw new Error('MiUV redirigió al sitio principal — abre MiUV una vez en el navegador');
    if (!html || html.length < 500) throw new Error('MiUV HTTP vacío');
    return html;
  } finally { clearTimeout(t); }
  });
}
async function fetchMiuvHtmlInternal(pathKey) {
  if (_fetchInflight.has(pathKey)) return _fetchInflight.get(pathKey);
  const job = (async () => {
    await epEnsureUrls();
    try {
      try {
        const html = await fetchMiuvDirect(pathKey, 7000);
        await setSessionFlag(true);
        return html;
      } catch (e) {
        const code = classifyMiuvError(e.message);
        // SESSION o rebote al sitio principal: UN solo login + UN solo re-GET directo.
        // (Si el login mismo rebota, miuvLoginSingle lanza NEEDS_MANUAL terminal.)
        const sessionLike = code === 'SESSION' || /redirigió|inesperado/i.test(e.message || '');
        if (sessionLike) {
          // Sesión expirada: UN solo login + UN solo re-GET directo.
          await ensureMiuvSession();
          try {
            const html2 = await fetchMiuvDirect(pathKey, 7000);
            await setSessionFlag(true);
            return html2;
          } catch (e2) {
            // El re-GET directo falló por red tras loguear: una pasada por Worker con la sesión fresca.
            if (classifyMiuvError(e2.message) !== 'SESSION') {
              const htmlW = await fetchMiuvViaWorker(pathKey);
              await setSessionFlag(true);
              return htmlW;
            }
            throw e2;
          }
        }
        if (code === 'NETWORK' || code === 'UNKNOWN') {
          // El directo no llegó (CORS/redirect/VPN): una pasada por Worker, sin login extra.
          const htmlW = await fetchMiuvViaWorker(pathKey);
          await setSessionFlag(true);
          return htmlW;
        }
        throw e;
      }
    } finally {
      _fetchInflight.delete(pathKey);
    }
  })();
  _fetchInflight.set(pathKey, job);
  return job;
}

async function fetchScheduleHtmlInternal() {
  return fetchMiuvHtmlInternal('horc');
}

// FIX SISTÉMICO: Helper caché genérico MiUV (24h) — mismo TTL que horario para offline instantáneo
// FIX 503: getMiuvCache ahora también VALIDA el cached.html — si alguna vez entró una
// página de error al caché, deja de servirse (auto-limpieza) y el widget muestra la UI de error real.
async function getMiuvCache(cacheKey) {
  try {
    const data = await chrome.storage.local.get([cacheKey]);
    const cached = data[cacheKey];
    if (cached && cached.html && (Date.now() - cached.ts) < 24*60*60*1000) {
      if (looksMiuvCacheable(cached.html)) return cached;
      console.warn('[EP] Caché MiUV corrupto, limpiando:', cacheKey);
      try { await chrome.storage.local.remove([cacheKey]); } catch {}
    }
  } catch {}
  return null;
}
async function setMiuvCache(cacheKey, html) {
  // FIX 503: nunca cachear basura. Antes se guardaba CUALQUIER html "exitoso" (200),
  // incluidas páginas de error del portal y las que llegan vía Worker — quedaban 24h
  // "pintadas" y recargar no cambiaba nada. Solo HTML con marcadores internos del
  // portal y sin firmas de login/homepage/página de error entra en caché.
  if (!looksMiuvCacheable(html)) {
    console.warn('[EP] setMiuvCache rechazado (contenido no válido del portal):', cacheKey);
    return;
  }
  try {
    const periodMatch = html.match(/span-periodo[^>]*>([^<]+)</i) || html.match(/lblPeri[^>]*>([^<]+)</i);
    const period = periodMatch ? periodMatch[1].trim() : '';
    await chrome.storage.local.set({ [cacheKey]: { html, period, ts: Date.now() } });
  } catch {}
}
// Validador de caché: igual que looksMiuvContent PERO sin el comodín 'MiUV'
// (una página de error/login del portal menciona MiUV) y exige markers reales.
function looksMiuvCacheable(html) {
  if (!html || html.length < 500) return false;
  if (looksLoginMiuv(html, '')) return false;
  if (looksUvHomepage(html, '')) return false;
  const core = 'divTile|span-periodo|lblMateria|wucCali|wucAvan|lblBgPor|dlAvance|lblTituArea';
  if (!new RegExp(core, 'i').test(html)) return false;
  // firmas típicas de página de error ASP.NET/IIS/app-pool, nunca son contenido válido
  if (/Excepci[oó]n no controlada|Runtime Error|Service Unavailable|Servicio no disponible|No se puede mostrar la p[aá]gina|temporariamente no disponible/i.test(html)) return false;
  return true;
}
// FIX: Extrae opciones de periodo de calificaciones (value -> label) — dinámico para N periodos
function extractPeriodOptions(html) {
  const opts = [];
  const selMatch = html.match(/<select[^>]*id="content_wucCali_ddlPeriodo"[^>]*>([\s\S]*?)<\/select>/i);
  if (!selMatch) return opts;
  const inner = selMatch[1];
  const re = /<option[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const val = m[1].trim();
    const label = m[2].trim().replace(/\s+/g,' ');
    if (val) opts.push({ value: val, label });
  }
  return opts;
}
// Genera candidatos para descubrir periodos ocultos (si el select solo trae 2 recientes) — cubre intersemestrales 01/02/51/52/53
function generatePeriodCandidates(existing) {
  const existingSet = new Set(existing.map(o=>o.value));
  const candidates = [];
  const now = new Date();
  const currentYear = now.getFullYear() + 1;
  const suffixes = ['01','02','51','52','53','54'];
  for (let y = currentYear; y >= 2015; y--) {
    for (const suffix of suffixes) {
      const val = `${y}${suffix}`;
      if (!existingSet.has(val)) candidates.push(val);
    }
  }
  return candidates;
}
// FIX: POST periodo para calificaciones — replica __doPostBack exacta del portal
async function fetchGradesForPeriod(htmlBase, periodValue) {
  await epEnsureUrls();
  const hidden = extractHiddenFields(htmlBase);
  const params = new URLSearchParams();
  Object.entries(hidden).forEach(([k,v]) => params.append(k, v));
  params.set('__EVENTTARGET', 'ctl00$content$wucCali$ddlPeriodo');
  params.set('__EVENTARGUMENT', '');
  params.set('__LASTFOCUS', '');
  // ctl00$content$wucCali$ddlPeriodo es el select
  params.set('ctl00$content$wucCali$ddlPeriodo', periodValue);
  // Asegura hdnApp
  if (!params.has('ctl00$hdnApp')) params.set('ctl00$hdnApp', '_357uD14Nt35%');
  if (!params.has('ctl00$hdnAppConfig')) params.set('ctl00$hdnAppConfig', '_357uD14Nt35%');
  // Mismo host que entregó el HTML base (el ViewState solo vale ahí).
  // El timeout corre DENTRO del slot para no contar el tiempo en cola.
  const resp = await withMiuvSlot(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 7000);
    try {
      return await fetch(miuvBaseFor('calif') + EP_P('calif'), {
        method: 'POST',
        credentials: 'include',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal
      });
    } finally { clearTimeout(t); }
  });
  if (resp.url && resp.url.toLowerCase().includes('login')) throw new Error('No hay sesión activa en MiUV');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const html = await resp.text();
  if (html.includes('txtUser') && html.includes('txtPassword')) throw new Error('No hay sesión activa en MiUV');
  return html;
}

// Listen for tab updates to detect URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('eminus.uv.mx')) {
    chrome.tabs.sendMessage(tabId, { action: 'urlChange' }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Eminus Tareas Pendientes extension installed v2.1.4');
});

// Keep the service worker alive + credential + schedule handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ action: 'pong' });
    return true;
  }

  if (message.action === 'storeCredentials') {
    const { username, password } = message;
    if (username && password) {
      storeCreds(username, password).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    } else {
      sendResponse({ error: 'Credenciales vacías' });
    }
    return true;
  }

  if (message.action === 'clearCredentials') {
    clearStoredCreds().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'getCredentials') {
    getStoredCreds().then(c => sendResponse({ creds: c })).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'miuvAutoLogin') {
    const { username, password } = message;
    miuvAutoLogin(username, password)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message, code: classifyMiuvError(e.message) }));
    return true;
  }
  // Precalienta sesión MiUV al capturar credenciales / al abrir widgets: asegura 1 login único.
  if (message.action === 'ensureMiuvSession') {
    (async () => {
      try {
        if (message.username && message.password) {
          await miuvAutoLogin(message.username, message.password);
        } else {
          await ensureMiuvSession();
        }
        sendResponse({ ok: true, fresh: isSessionFresh() });
      } catch (e) {
        sendResponse({ error: e.message, code: classifyMiuvError(e.message) });
      }
    })();
    return true;
  }
  if (message.action === 'getSessionStatus') {
    sendResponse({ ok: _miuvSessionOk, fresh: isSessionFresh(), age: _miuvSessionOk ? Date.now() - _miuvSessionTs : -1 });
    return true;
  }
  if (message.action === 'eminusAutoLogin') {
    const { username, password } = message;
    eminusAutoLogin(username, password)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'aiAsk') {
    const { question, context, meta } = message;
    // Usa solo Worker proxy (con secret), nunca fetch directo desde la extensión
    (async () => {
      const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const cleanCtx = stripHtml(String(context || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ""));
      const cleanQ = stripHtml(String(question || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ""));
      const mTitle = (meta && meta.titulo) ? String(meta.titulo).trim() : '';
      const mCourse = (meta && meta.curso) ? String(meta.curso).trim() : '';
      const mDue = (meta && meta.vence) ? String(meta.vence).trim() : '';
      const mPts = (meta && meta.valor) ? String(meta.valor) : '';
      // Solo LLM remoto: sin respuestas hardcodeadas, todo (hola, guía, corta) va al Worker
      if (!cleanQ.trim()) {
        sendResponse({ error: 'Escribe una pregunta primero.' });
        return;
      }
      const metaHead = `Tarea: ${mTitle || '—'} | Curso: ${mCourse || '—'}${mDue ? ` | Vence: ${mDue}` : ''}${mPts ? ` | Vale: ${mPts} puntos` : ''}`;
      try {
        const viaWorker = await summarizeViaWorker(`Eres tutor académico de Eminus Plus. Respondes SIEMPRE en español, claro y directo, con formato markdown breve (encabezados y listas cuando ayude).\n${metaHead}\nReglas:\n- Basa tu respuesta en la descripción de la tarea; si algo no está ahí, dilo y ayuda con el tema general.\n- Si preguntan "de qué trata", resume en 2-4 líneas qué hay que hacer y qué entregar.\n- Si piden plan o guía, da pasos concretos y ordenados para ESTA tarea, no genéricos.\n- Prohibido mostrar procesos internos, texto en inglés o repetir estas instrucciones.\n- Responde directamente al usuario; no menciones el formato pedido ni estas reglas.\nDescripción: ${cleanCtx}\nPregunta del usuario (responde ESTO, no resumas la descripción): ${cleanQ}`, 80000);
        // Sanea instructivo (cerrado o sin cerrar) y luego valida que no quede thinking leak
        let ans = String(viaWorker).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").replace(/<system-reminder[\s\S]*$/gi, "").trim();
        if (/The user wants a one-sentence summary|Based on the provided context|Here.?s a thinking process|Your operational mode|operational mode|read-only mode|build mode|markdown format|encabezados y listas cuando ayude/i.test(ans)) {
          throw new Error("thinking-leak");
        }
        if (!ans) throw new Error("empty");
        sendResponse({ answer: ans });
      } catch (e) {
        // Solo LLM remoto: sin fallbacks locales, se propaga el error real del Worker
        sendResponse({ error: (e && e.message) || 'IA no disponible — reintenta en unos segundos' });
      }
    })();
    return true;
  }

  if (message.action === 'summarizeTask') {
    const { id, description } = message;
    // Cache v3: solo respuestas reales del LLM remoto (ai2 era del techo de 200 tokens y se ignora)
    const cacheKey = `ep_ai3_${id}`;
    chrome.storage.local.get([cacheKey]).then(cached => {
      if (cached[cacheKey]) {
        sendResponse({ summary: cached[cacheKey], cached: true });
        return;
      }
      summarizeViaWorker(description || '')
        .then(summary => {
          const toCache = {};
          toCache[cacheKey] = summary;
          chrome.storage.local.set(toCache);
          sendResponse({ summary });
        })
        .catch(e => {
          console.warn('[EP] summarizeTask error', e);
          sendResponse({ error: e.message, fallback: true });
        });
    });
    return true;
  }

  // Buzón de sugerencias vía background: todo el tráfico al servidor sale
  // del service worker con el origen de la extensión (nada directo desde página).
  if (message.action === 'submitSuggest') {
    (async () => {
      try {
        const p = message.payload || {};
        const body = {
          type: String(p.type || ''),
          message: String(p.message || '').slice(0, 1000),
          page: String(p.page || '').slice(0, 300),
          hp: '',
          ts: Date.now()
        };
        if (p.email) body.email = String(p.email).slice(0, 120);
        const r = await fetch(WORKER_URL + '/api/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) sendResponse({ error: j.error || ('HTTP ' + r.status) });
        else sendResponse({ ok: true, id: j.id });
      } catch (e) { sendResponse({ error: (e && e.message) || 'error' }); }
    })();
    return true;
  }

  // ROBUSTO: fetchMiuv interno ya asegura sesión una vez. Aquí NO hay segundo login ni contadores.
  // Si falla: INVALID → limpiar + pedir re-login; NEEDS_MANUAL → abrir MiUV; resto → caché offline.
  if (message.action === 'fetchSchedule') {
    (async () => {
      const CACHE_KEY = 'ep_schedule_cache';
      try {
        const html = await fetchScheduleHtmlInternal();
        await setMiuvCache(CACHE_KEY, html);
        sendResponse({ html });
      } catch (err) {
        const msg = err.message || '';
        const code = classifyMiuvError(msg);
        if (code === 'INVALID_CREDS') {
          await clearStoredCreds();
          sendResponse({ error: 'Credenciales inválidas en MiUV — vuelve a iniciar sesión en Eminus', code });
          return;
        }
        const cached = await getMiuvCache(CACHE_KEY);
        if (cached) {
          console.log('[EP] Horario con caché offline (age ' + Math.round((Date.now()-cached.ts)/60000) + 'm) causa: ' + code);
          sendResponse({ html: cached.html, cached: true, cacheAge: Date.now() - cached.ts, error: msg, code });
          return;
        }
        console.error('Schedule fetch error:', code, msg);
        sendResponse({ error: msg, code });
      }
    })();
    return true;
  }

  // ROBUSTO: idéntico a fetchSchedule — el login único vive dentro de fetchMiuvHtmlInternal.
  async function handleMiuvFetch(path, cacheKey, label, sendResponse) {
    try {
      const html = await fetchMiuvHtmlInternal(path);
      await setMiuvCache(cacheKey, html);
      sendResponse({ html });
    } catch (err) {
      const msg = err.message || '';
      const code = classifyMiuvError(msg);
      if (code === 'INVALID_CREDS') {
        await clearStoredCreds();
        sendResponse({ error: 'Credenciales inválidas en MiUV — vuelve a iniciar sesión en Eminus', code });
        return;
      }
      const cached = await getMiuvCache(cacheKey);
      if (cached) {
        console.log(`[EP] ${label} con caché offline (age ${Math.round((Date.now()-cached.ts)/60000)}m) causa: ${code}`);
        sendResponse({ html: cached.html, cached: true, cacheAge: Date.now() - cached.ts, error: msg, code });
        return;
      }
      console.error(`${label} fetch error:`, code, msg);
      sendResponse({ error: msg, code });
    }
  }

  if (message.action === 'fetchGrades') {
    (async () => {
      // Si piden all periods, devuelve todos; si no, mantiene compat con html único
      if (message.all) {
        const CACHE_ALL = 'ep_grades_all';
        // FIX: getMiuvCache exige .html, pero CACHE_ALL se guarda como {periods, ts} —
        // el cache-first nunca llegó a funcionar (dead code) y cada apertura del widget
        // hacía la cadena completa GET+POSTs al portal. Lectura dedicada + SWR en fondo.
        async function readGradesAllCache() {
          try {
            const rawAll = await chrome.storage.local.get([CACHE_ALL]);
            const c = rawAll && rawAll[CACHE_ALL];
            if (c && c.periods && c.ts && (Date.now() - c.ts) < 24*60*60*1000) return c;
          } catch {}
          return null;
        }
        // FIX SWR: revalida ep_grades_all en fondo tras servir el caché — la próxima
        // apertura del widget ve datos frescos sin que "recargar" sea un noop.
        let _gradesAllReval = false;
        async function revalidateGradesAll(PATCHED) {
          if (_gradesAllReval) return;
          _gradesAllReval = true;
          try {
            const c = PATCHED;
            const baseHtml = await fetchMiuvHtmlInternal('calif');
            if (!baseHtml || !looksMiuvCacheable(baseHtml)) return;
            const opts = extractPeriodOptions(baseHtml);
            if (!opts || !opts.length) return;
            const selectedMatch = baseHtml.match(/<option[^>]*selected[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/i);
            const selectedVal = selectedMatch ? selectedMatch[1] : opts[0].value;
            let changed = false;
            // 1) Refresca el periodo seleccionado (el que ve el usuario)
            const haveSel = c.periods.find(p => p.value === selectedVal);
            if (haveSel) {
              try {
                const fresh = await fetchGradesForPeriod(baseHtml, selectedVal);
                if (fresh && fresh.length > 1000 && fresh !== haveSel.html) {
                  haveSel.html = fresh; haveSel.selected = true; changed = true;
                  try { await chrome.storage.local.set({ ['ep_grades_'+selectedVal]: { html: fresh, label: haveSel.label, ts: Date.now() } }); } catch {}
                }
              } catch {}
            }
            // 2) Completa periodos que faltan en un payload parcial anterior (máx 3: sin storm)
            const missing = opts.filter(o => !c.periods.find(p => p.value === o.value)).slice(0, 3);
            for (const o of missing) {
              try {
                // ViewState per-POST: base fresca cada vez (el inflight dedup abarata los GET)
                const fb = await fetchMiuvHtmlInternal('calif');
                const fresh = await fetchGradesForPeriod(fb, o.value);
                if (fresh && fresh.length > 1000) {
                  c.periods.push({ value: o.value, label: o.label || ('Periodo ' + o.value), html: fresh });
                  try { await chrome.storage.local.set({ ['ep_grades_'+o.value]: { html: fresh, label: o.label, ts: Date.now() } }); } catch {}
                  changed = true;
                }
              } catch {}
            }
            if (changed) {
              c.periods.sort((a,b)=> parseInt(b.value,10) - parseInt(a.value,10));
              await chrome.storage.local.set({ [CACHE_ALL]: { periods: c.periods, ts: Date.now() } });
              console.log('[EP] ep_grades_all revalidado en fondo');
            }
          } catch (e) {
            console.warn('[EP] revalidación ep_grades_all falló (se conserva caché)', e && e.message);
          } finally { _gradesAllReval = false; }
        }
        try {
          // Intenta cache all (instantáneo) y revalida en fondo
          const cachedAll = await readGradesAllCache();
          if (cachedAll && cachedAll.periods) {
            sendResponse({ periods: cachedAll.periods, cached: true, cacheAge: Date.now() - cachedAll.ts });
            try { revalidateGradesAll(cachedAll); } catch {}
            return;
          }
        } catch {}
        try {
          let baseHtml = await fetchMiuvHtmlInternal('calif');
          await setMiuvCache('ep_grades_cache', baseHtml);
          const opts = extractPeriodOptions(baseHtml);
          if (opts.length === 0) {
            // fallback a single
            sendResponse({ html: baseHtml, periods: [{ value: '', label: 'Actual', html: baseHtml }] });
            return;
          }
          // Identifica selected
          const selectedMatch = baseHtml.match(/<option[^>]*selected[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/i);
          const selectedVal = selectedMatch ? selectedMatch[1] : opts[0].value;
          const periods = [];
          // Agrega base como selected
          const selOpt = opts.find(o=>o.value===selectedVal) || opts[0];
          periods.push({ value: selOpt.value, label: selOpt.label, html: baseHtml, selected: true });
          // Para los demás del select, POST en paralelo con base propia (cadenas independientes)
          // FIX velocidad: antes era serial (N periodos × POST lento = decenas de segundos sin respuesta)
          const restOpts = opts.filter(o => o.value !== selectedVal);
          let chainBase = baseHtml;
          // RÁPIDO: responde con seleccionado + 2 recientes de inmediato; el resto se completa en fondo y queda en caché.
          const fastOpts = restOpts.slice(0, 2);
          const slowOpts = restOpts.slice(2);
          for (let ck = 0; ck < fastOpts.length; ck += 2) {
            const chunk = fastOpts.slice(ck, ck + 2);
            const settled = await Promise.allSettled(chunk.map(async (o) => {
              const freshBase = await fetchMiuvHtmlInternal('calif');
              const html = await fetchGradesForPeriod(freshBase, o.value);
              return { html };
            }));
            for (let k = 0; k < chunk.length; k++) {
              const o = chunk[k];
              const r = settled[k];
              if (r.status === 'fulfilled' && r.value && r.value.html && r.value.html.length > 1000) {
                periods.push({ value: o.value, label: o.label, html: r.value.html });
                chainBase = r.value.html;
                try { await chrome.storage.local.set({ ['ep_grades_'+o.value]: { html: r.value.html, label: o.label, ts: Date.now() } }); } catch {}
              } else {
                try {
                  const html = await fetchGradesForPeriod(chainBase, o.value);
                  periods.push({ value: o.value, label: o.label, html });
                  chainBase = html;
                  await chrome.storage.local.set({ ['ep_grades_'+o.value]: { html, label: o.label, ts: Date.now() } });
                } catch (e) {
                  console.warn('[EP] fetchGrades period', o.value, 'failed', e.message);
                  try {
                    const c = await chrome.storage.local.get(['ep_grades_'+o.value]);
                    if (c['ep_grades_'+o.value]) periods.push({ value: o.value, label: o.label, html: c['ep_grades_'+o.value].html, cached:true });
                  } catch {}
                }
              }
            }
          }
          baseHtml = chainBase;
          periods.sort((a,b)=> parseInt(b.value,10) - parseInt(a.value,10));
          // Respuesta inmediata con los visibles (Test A: rápido)
          try { await chrome.storage.local.set({ [CACHE_ALL]: { periods, ts: Date.now() } }); } catch {}
          sendResponse({ periods, partial: true, hasMore: slowOpts.length > 0 });
          // Completa el resto sin bloquear (actualiza caché para la próxima apertura)
          if (slowOpts.length) {
            (async () => {
              try {
                for (const o of slowOpts) {
                  try {
                    const freshBase = await fetchMiuvHtmlInternal('calif');
                    const html = await fetchGradesForPeriod(freshBase, o.value);
                    if (html && html.length > 1000) {
                      periods.push({ value: o.value, label: o.label, html });
                      try { await chrome.storage.local.set({ ['ep_grades_'+o.value]: { html, label: o.label, ts: Date.now() } }); } catch {}
                    }
                  } catch {}
                }
                periods.sort((a,b)=> parseInt(b.value,10) - parseInt(a.value,10));
                try { await chrome.storage.local.set({ [CACHE_ALL]: { periods, ts: Date.now() } }); } catch {}
              } catch {}
            })();
          }
          // Descubrimiento en background sin bloquear (no retrasa la UI)
          // FIX velocidad: solo si el select trae pocos periodos; topa hallazgos e intentos
          if (opts.length < 3) {
            (async () => {
            try {
              const candidates = generatePeriodCandidates(opts);
              let discovered = 0, fails = 0;
              let bgBase = baseHtml;
              for (const candVal of candidates) {
                if (discovered >= 4 || fails >= 10) break;
                if (periods.find(p=>p.value===candVal)) continue;
                try {
                  let freshBase;
                  try { freshBase = await fetchMiuvHtmlInternal('calif'); } catch { freshBase = bgBase; }
                  const html = await fetchGradesForPeriod(freshBase, candVal);
                  const selMatch = html.match(/<option[^>]*selected[^>]*value="([^"]+)"/i);
                  const returnedVal = selMatch ? selMatch[1] : null;
                  const hasTiles = html.includes('divTile') || html.includes('lblMateria');
                  if (returnedVal !== candVal) continue;
                  if (!hasTiles) continue;
                  const labelMatch = html.match(/<span[^>]*id="content_wucCali_lblPeri"[^>]*>([^<]+)<\/span>/i) || html.match(/span-periodo[^>]*>([^<]+)</i);
                  const label = labelMatch ? labelMatch[1].trim() : `Periodo ${candVal}`;
                  if (label && label.length > 5) {
                    periods.push({ value: candVal, label, html });
                    bgBase = html;
                    await chrome.storage.local.set({ ['ep_grades_'+candVal]: { html, label, ts: Date.now() } });
                    discovered++;
                  }
                } catch { fails++; }
              }
              if (discovered) {
                periods.sort((a,b)=> parseInt(b.value,10) - parseInt(a.value,10));
                try { await chrome.storage.local.set({ [CACHE_ALL]: { periods, ts: Date.now() } }); } catch {}
                console.log(`[EP] Periodos ocultos descubiertos en background: +${discovered} (total ${periods.length})`);
              }
            } catch {}
          })();
          }
        } catch (err) {
          const msg = err.message || '';
          const code = classifyMiuvError(msg);
          if (code === 'INVALID_CREDS') {
            await clearStoredCreds();
            sendResponse({ error: 'Credenciales inválidas en MiUV — vuelve a iniciar sesión en Eminus', code });
            return;
          }
          // Fallback cache (el login único ya ocurrió dentro de fetchMiuv; aquí no se reintenta)
          try {
            // FIX: CACHE_ALL es {periods, ts} — usar la lectura dedicada (getMiuvCache exigía .html y nunca servía)
            const cachedAll = await readGradesAllCache();
            if (cachedAll && cachedAll.periods) { sendResponse({ periods: cachedAll.periods, cached:true, cacheAge: Date.now()-cachedAll.ts, error: msg, code }); return; }
            const c = await getMiuvCache('ep_grades_cache');
            if (c) { sendResponse({ html: c.html, cached:true, cacheAge: Date.now()-c.ts, error: msg, code }); return; }
          } catch {}
          sendResponse({ error: msg, code });
        }
      } else {
        await handleMiuvFetch('calif', 'ep_grades_cache', 'Calificaciones', sendResponse);
      }
    })();
    return true;
  }
  if (message.action === 'fetchAvance') {
    (async () => { await handleMiuvFetch('avance', 'ep_avance_cache', 'Avance', sendResponse); })();
    return true;
  }
  if (message.action === 'fetchExams') {
    (async () => { await handleMiuvFetch('examen', 'ep_exams_cache', 'Exámenes', sendResponse); })();
    return true;
  }

  // FIX SISTÉMICO: Detalle de avance por área — POST __doPostBack con ViewState (mismo patrón sin login extra)
  const AVANCE_DETAIL_MAP = {
    'BG': 'ctl00$content$wucAvan$lblBgPor',
    'ID': 'ctl00$content$wucAvan$lblIdPor',
    'FD': 'ctl00$content$wucAvan$lblFdPor',
    'FT': 'ctl00$content$wucAvan$lblFtPor',
    'EL': 'ctl00$content$wucAvan$lblElPor',
    // Aliases por nombre visible
    'GENERAL': 'ctl00$content$wucAvan$lblBgPor',
    'INICIACION': 'ctl00$content$wucAvan$lblIdPor',
    'INICIACION A LA DISCIPLINA': 'ctl00$content$wucAvan$lblIdPor',
    'DISCIPLINARIA': 'ctl00$content$wucAvan$lblFdPor',
    'TERMINAL': 'ctl00$content$wucAvan$lblFtPor',
    'ELECCION LIBRE': 'ctl00$content$wucAvan$lblElPor'
  };
  async function fetchAvanceDetailHtml(area) {
    const key = String(area || '').trim().toUpperCase();
    const eventTarget = AVANCE_DETAIL_MAP[key] || AVANCE_DETAIL_MAP[key.replace(/[^A-Z]/g,'')] || null;
    if (!eventTarget) throw new Error('Área no reconocida: ' + area);
    // 1. Base SIEMPRE fresca: el ViewState cacheado (hasta 24h) muere por validación
    // MAC en ASP.NET y el POST falla. fetchMiuvHtmlInternal ya asegura sesión + GET fresco.
    const baseHtml = await fetchMiuvHtmlInternal('avance');
    if (baseHtml && ((baseHtml.includes('txtUser') && baseHtml.includes('txtPassword')) || baseHtml.includes('id="txtUser"') || baseHtml.includes('name="txtUser"'))) throw new Error('No hay sesión activa en MiUV');
    const hidden = extractHiddenFields(baseHtml);
    if (!hidden['__VIEWSTATE']) throw new Error('MiUV no entregó formulario — abre MiUV una vez en el navegador');
    const params = new URLSearchParams();
    Object.entries(hidden).forEach(([k,v]) => params.append(k, v));
    params.set('__EVENTTARGET', eventTarget);
    params.set('__EVENTARGUMENT', '');
    // 2. POST de avance — sigue redirect a detalle (?a= -> ?c=ticket).
    // Timeout dentro del slot; mismo host que entregó el HTML base.
    const resp = await withMiuvSlot(async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 7000);
      try {
        return await fetch(miuvBaseFor('avance') + EP_P('avance'), {
          method: 'POST',
          credentials: 'include',
          redirect: 'follow',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: controller.signal
        });
      } finally { clearTimeout(t); }
    });
    {
      if (resp.url && resp.url.toLowerCase().includes('login')) throw new Error('No hay sesión activa en MiUV');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let html = await resp.text();
      // Si POST devolvió aún avance sin detalle (sin dlAvanceCubierto), intenta detectar c en respuesta y GET directo
      if (!html.includes('dlAvanceCubierto') && !html.includes('lblTituArea')) {
        // Busca link de detalle en la respuesta
        const m = html.match(new RegExp(EP_P('detalle').replace(/\./g, '\\.') + '\\?c=([^"\'&]+)', 'i'));
        if (m) {
          const detailUrl = `${miuvBaseFor('avance')}${EP_P('detalle')}?c=${m[1]}`;
          html = await withMiuvSlot(async () => {
            const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), 8000);
            try {
              const r2 = await fetch(detailUrl, { method: 'GET', credentials: 'include', redirect: 'follow', signal: c2.signal });
              if (r2.ok) return await r2.text();
              return html;
            } finally { clearTimeout(t2); }
          });
        }
      }
      if (html.includes('txtUser') && html.includes('txtPassword')) throw new Error('No hay sesión activa en MiUV');
      return html;
    }
  }
  if (message.action === 'fetchAvanceDetail') {
    (async () => {
      const area = message.area || 'BG';
      const cacheKey = 'ep_avance_detail_' + String(area).toUpperCase().replace(/[^A-Z]/g,'').slice(0,2);
      // Intenta cache corto (6h) para detalle
      try {
        const data = await chrome.storage.local.get([cacheKey]);
        const cached = data[cacheKey];
        if (cached && cached.html && cached.ts && (Date.now() - cached.ts) < 6*60*60*1000) {
          sendResponse({ html: cached.html, cached: true, cacheAge: Date.now() - cached.ts });
          return;
        }
      } catch {}
      try {
        const html = await fetchAvanceDetailHtml(area);
        try { await chrome.storage.local.set({ [cacheKey]: { html, ts: Date.now() } }); } catch {}
        sendResponse({ html });
      } catch (err) {
        const msg = err.message || '';
        const code = classifyMiuvError(msg);
        if (code === 'INVALID_CREDS') {
          await clearStoredCreds();
          sendResponse({ error: 'Credenciales inválidas en MiUV — vuelve a iniciar sesión en Eminus', code });
          return;
        }
        // Fallback cache aunque expirado (sin segundo login: ya ocurrió dentro del fetch)
        try {
          const data = await chrome.storage.local.get([cacheKey]);
          const cached = data[cacheKey];
          if (cached && cached.html) {
            sendResponse({ html: cached.html, cached: true, cacheAge: Date.now() - cached.ts, error: msg, code });
            return;
          }
        } catch {}
        sendResponse({ error: msg, code });
      }
    })();
    return true;
  }

  if (message.action === 'fetchProfile') {
    const { url, token } = message;
    (async () => {
      const ctrlP = new AbortController(); const tP=setTimeout(()=>ctrlP.abort(), 10000);
      try {
        if (!url || !url.includes('eminusapi/profiles')) throw new Error('URL inválida');
        const endpoint = url.replace('https://eminus.uv.mx','');
        const res = await fetch(url, {
          headers: {
            'Authorization': 'Bearer ' + (token || ''),
            'referer': 'https://eminus.uv.mx/eminus4/page/messages/0',
            'path': endpoint,
            'accept': 'image/*,*/*'
          },
          credentials: 'include',
          signal: ctrlP.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (!blob.type.startsWith('image/')) throw new Error('No es imagen: ' + blob.type);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        // chunk to avoid call stack overflow for large images
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        const base64 = btoa(binary);
        const dataUrl = `data:${blob.type};base64,${base64}`;
        sendResponse({ dataUrl });
      } catch (e) {
        console.warn('[EP] fetchProfile error', e);
        sendResponse({ error: e.message });
      } finally { clearTimeout(tP); }
    })();
    return true;
  }

  return true;
});
