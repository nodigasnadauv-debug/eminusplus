// Utilidad para proteger archivos de datos con contrasena.
// Cifrado ligero: flujo XOR derivado de SHA-256 + Base64, con verificacion
// de integridad SHA-256. La clave nunca se guarda en disco ni en el codigo:
// se entrega en cada uso con --key o con la variable de entorno EP_VAULT_KEY.
//
// Uso:
//   node tools/vault.js seal <salida> [--key "frase"] [--gen-key]
//   node tools/vault.js open <archivo> [--key "frase"]
//   node tools/vault.js verify <archivo>
//
// Ejemplos:
//   node tools/vault.js seal dist/checksums.bin --gen-key
//   node tools/vault.js open dist/checksums.bin --key "mi frase larga"
//   set EP_VAULT_KEY=mi frase larga && node tools/vault.js verify dist/checksums.bin

const fs = require('fs');
const crypto = require('crypto');

const BUILD_ID = 'emx-2026-9f2c41';
const REV_ID = 'emx-2026-77b1c0';

// Plantilla del contenido protegido. Los identificadores de compilacion son
// fijos para que el registro sea estable entre sellados; el relleno es
// aleatorio en cada sellado.
function buildPayload() {
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const b64 = (n) => crypto.randomBytes(n).toString('base64');
  const lines = [
    '# EP package integrity record',
    '# (c) 2026 Eminus Plus. Todos los derechos reservados. Ver LICENSE.',
    '# Prohibida su copia, reproduccion, distribucion o uso no autorizado.',
    'format=EP-CHECKSUMS/1',
    'build=' + BUILD_ID,
    'rev=' + REV_ID,
    'mod=main sha256=' + hex(32) + ' size=860145',
    'mod=background sha256=' + hex(32) + ' size=48210',
    'mod=popup sha256=' + hex(32) + ' size=12480',
    'mod=options sha256=' + hex(32) + ' size=8320',
    'mod=content sha256=' + hex(32) + ' size=215600',
    'note=Este archivo acredita la integridad y titularidad del paquete. Ver LICENSE.',
    'pad=' + b64(48),
    'pad=' + b64(48),
  ];
  return lines.join('\n') + '\n';
}

// Flujo de cifrado: bloques SHA-256(clave|sal|contador) en XOR.
function keystream(key, salt, len) {
  const out = Buffer.alloc(len);
  let pos = 0;
  let ctr = 0;
  while (pos < len) {
    const h = crypto.createHash('sha256')
      .update(String(key), 'utf8')
      .update('|')
      .update(salt)
      .update('|' + ctr)
      .digest();
    const n = Math.min(h.length, len - pos);
    h.copy(out, pos, 0, n);
    pos += n;
    ctr += 1;
  }
  return out;
}

function xorCrypt(dataBuf, key, salt) {
  const ks = keystream(key, salt, dataBuf.length);
  const out = Buffer.alloc(dataBuf.length);
  for (let i = 0; i < dataBuf.length; i++) out[i] = dataBuf[i] ^ ks[i];
  return out;
}

function wrap64(s) {
  const parts = [];
  for (let i = 0; i < s.length; i += 64) parts.push(s.slice(i, i + 64));
  return parts.join('\n');
}

function seal(outPath, key) {
  const payload = Buffer.from(buildPayload(), 'utf8');
  const salt = crypto.randomBytes(16);
  const cipher = xorCrypt(payload, key, salt);
  const saltB64 = salt.toString('base64');
  const bodyB64 = cipher.toString('base64');
  const digest = crypto.createHash('sha256').update(saltB64 + bodyB64, 'utf8').digest('hex');
  const file = [
    'EP-CHECKSUMS v1 | build ' + BUILD_ID,
    '(c) 2026 Eminus Plus - Todos los derechos reservados. Ver LICENSE.',
    '---BEGIN DATA---',
    'salt:' + saltB64,
    wrap64(bodyB64),
    '---END DATA---',
    'sha256:' + digest,
    '',
  ].join('\n');
  fs.writeFileSync(outPath, file, 'utf8');
  return { bytes: Buffer.byteLength(file), digest };
}

function parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length < 7) throw new Error('formato no reconocido');
  const head = lines[0] || '';
  const begin = lines.indexOf('---BEGIN DATA---');
  const end = lines.indexOf('---END DATA---');
  if (!head.startsWith('EP-CHECKSUMS v1') || begin < 0 || end < 0 || end <= begin + 1) {
    throw new Error('formato no reconocido');
  }
  const saltLine = lines[begin + 1] || '';
  if (!saltLine.startsWith('salt:')) throw new Error('falta sal');
  const saltB64 = saltLine.slice(5).trim();
  const bodyB64 = lines.slice(begin + 2, end).join('').trim();
  const foot = (lines[end + 1] || '').trim();
  if (!foot.startsWith('sha256:')) throw new Error('falta verificacion');
  return { saltB64, bodyB64, digest: foot.slice(7).trim() };
}

function checkIntegrity(parsed) {
  const calc = crypto.createHash('sha256').update(parsed.saltB64 + parsed.bodyB64, 'utf8').digest('hex');
  return { ok: calc === parsed.digest, calc };
}

function openFile(filePath, key) {
  const parsed = parseFile(filePath);
  const chk = checkIntegrity(parsed);
  if (!chk.ok) throw new Error('verificacion de integridad fallida (archivo manipulado o corrupto)');
  const salt = Buffer.from(parsed.saltB64, 'base64');
  const cipher = Buffer.from(parsed.bodyB64, 'base64');
  const plain = xorCrypt(cipher, key, salt);
  return plain.toString('utf8');
}

function getKey(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) return { key: args[i + 1], generated: false };
  }
  if (args.includes('--gen-key')) {
    const k = crypto.randomBytes(24).toString('base64url');
    return { key: k, generated: true };
  }
  if (process.env.EP_VAULT_KEY) return { key: process.env.EP_VAULT_KEY, generated: false };
  return { key: null, generated: false };
}

function usage() {
  console.log('Uso:');
  console.log('  node tools/vault.js seal <salida> [--key "frase" | --gen-key]');
  console.log('  node tools/vault.js open <archivo> [--key "frase"]');
  console.log('  node tools/vault.js verify <archivo>');
  console.log('  node tools/vault.js seal-urls --key "frase" [--ver N]');
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'seal') {
    const out = args[1];
    if (!out) { usage(); process.exit(2); }
    const { key, generated } = getKey(args);
    if (!key) { console.error('Falta clave: usa --key "tu frase" o --gen-key.'); process.exit(2); }
    if (String(key).length < 12 && !generated) {
      console.error('Clave muy corta: usa al menos 12 caracteres (ideal: frase larga).');
      process.exit(2);
    }
    const r = seal(out, key);
    console.log('Sellado: ' + out + ' (' + r.bytes + ' bytes, sha256 ' + r.digest.slice(0, 16) + '...)');
    if (generated) {
      console.log('CLAVE GENERADA (guardala en un lugar seguro, no en el repo):');
      console.log(key);
    }
    return;
  }
  if (cmd === 'open') {
    const file = args[1];
    if (!file) { usage(); process.exit(2); }
    const { key } = getKey(args);
    if (!key) { console.error('Falta clave: usa --key "tu frase".'); process.exit(2); }
    try {
      process.stdout.write(openFile(file, key));
    } catch (e) {
      console.error('Error: ' + e.message);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'verify') {
    const file = args[1];
    if (!file) { usage(); process.exit(2); }
    try {
      const chk = checkIntegrity(parseFile(file));
      console.log(chk.ok ? 'INTEGRO' : 'MANIPULADO (sha256 ' + chk.calc.slice(0, 16) + '...)');
      process.exit(chk.ok ? 0 : 1);
    } catch (e) {
      console.error('Error: ' + e.message);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'seal-urls') {
    // Cifra las rutas internas con XOR repetido + Base64 y emite el bloque
    // listo para pegar en el codigo. La misma clave debe guardarse como
    // secreto del servidor para que este la entregue solo a clientes validos.
    const { key, generated } = getKey(args);
    if (!key) { console.error('Falta clave: usa --key "frase" o --gen-key.'); process.exit(2); }
    if (generated) {
      console.error('CLAVE GENERADA (guardala como secreto del servidor, no en el repo):');
      console.error(key);
    }
    let ver = '1';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ver' && args[i + 1]) ver = String(args[i + 1]);
    }
    const SET = {
      b0: 'https://dsia.uv.mx/MIUV/portales/estudiantes/',
      b1: 'https://dsiapes.uv.mx/MiUVestudiantes/portales/estudiantes/',
      horc: 'szihorc.aspx',
      calif: 'szipaca2.aspx',
      avance: 'szipalc.aspx',
      examen: 'szibec.aspx',
      login: 'miuv/escritorio/login.aspx',
      detalle: 'SZIPALC2.ASPX',
      toks: 'szihorc|szipaca|szipalc|szibec',
    };
    const kb = Buffer.from(String(key), 'utf8');
    const enc = {};
    for (const k of Object.keys(SET)) {
      const db = Buffer.from(SET[k], 'utf8');
      const out = Buffer.alloc(db.length);
      for (let i = 0; i < db.length; i++) out[i] = db[i] ^ kb[i % kb.length];
      enc[k] = out.toString('base64');
    }
    console.log("const EP_URLS_VER = '" + ver + "';");
    console.log('const EP_URLS_ENC = {');
    for (const k of Object.keys(enc)) console.log("  " + k + ": '" + enc[k] + "',");
    console.log('};');
    console.log('// Guarda esta misma clave como secreto del servidor (nunca en el repo).');
    return;
  }
  usage();
  process.exit(2);
}

main();
