// watchdog — vigila los contenedores de este proyecto de Docker Compose y sirve el estado.
//
//   · Caída (el proceso muere): Docker ya lo reinicia solo (restart: unless-stopped);
//     aquí se avisa, con las últimas líneas de log del contenedor.
//   · Congelado (healthcheck «unhealthy»): Docker NO hace nada fuera de Swarm, así que lo
//     reinicia el watchdog y avisa. Con límite para no entrar en bucle.
//   · ngrok: si pierde un túnel, se reinicia. Si cambia la dirección TCP del HTTPS del
//     Nokia (proveedor ngrok), actualiza public-address, reinicia nokia-tls y manda SMS.
//   · Entradas públicas, WhatsApp, disco, certificados y copias de seguridad: avisa si algo
//     deja de ir bien, y otra vez cuando se recupera.
//   · Página de estado en tiempo real (http://127.0.0.1:8090) y /api/status (JSON) para la
//     página /estado de NokiaMSN.
//
// Habla con Docker a través de docker-guard (solo listar/inspeccionar/logs/eventos/stats y
// reiniciar contenedores de este proyecto), nunca con el socket completo.
//
// Avisos: salida estándar (los muestra scripts/expose.sh), historial en /state/events.jsonl,
// la página de estado y SMS con Twilio (con límites). Formato de cada línea de salida:
// «HH:MM:SS NIVEL mensaje» con NIVEL = ALERTA | OK | INFO; las líneas de log que acompañan
// a una alerta van debajo con el prefijo «    │ ».
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const env = process.env;
const DOCKER = new URL(env.DOCKER_API || 'http://docker-guard:2375');
const HTTP_PORT = num(env.WATCHDOG_HTTP_PORT, 8090);
const POLL_MS = num(env.WATCHDOG_POLL_SECONDS, 10) * 1000;
const PUBLIC_CHECK_MS = num(env.WATCHDOG_PUBLIC_CHECK_SECONDS, 120) * 1000;
const NGROK_CHECK_MS = 30_000;
const RESTART_GRACE_MS = 120_000;        // tras reiniciar, tiempo para volver a estar sano
const RECOVERY_STABLE_MS = 30_000;       // en marcha este tiempo seguido = recuperado
const MAX_RESTARTS_PER_HOUR = 4;          // a partir de aquí, un intento cada 15 min
const SLOW_RETRY_MS = 15 * 60_000;
const ALERT_REPEAT_MS = 120_000;          // la misma alerta no se repite antes de esto
const SMS_COOLDOWN_MS = num(env.WATCHDOG_SMS_COOLDOWN_MINUTES, 30) * 60_000;
const SMS_MAX_PER_DAY = num(env.WATCHDOG_SMS_MAX_PER_DAY, 8);
const WA_ALERT_MS = num(env.WATCHDOG_WHATSAPP_ALERT_MINUTES, 10) * 60_000;
const DISK_MIN_FREE_BYTES = num(env.WATCHDOG_DISK_MIN_FREE_GB, 2) * 1024 ** 3;
const CERT_WARN_DAYS = num(env.WATCHDOG_CERT_WARN_DAYS, 30);
const BACKUP_MAX_AGE_MS = num(env.WATCHDOG_BACKUP_MAX_AGE_HOURS, 30) * 3600_000;
const TZ = env.WATCHDOG_TZ || 'Europe/Madrid';
const TLS_DIR = '/tls';
const NGROK_CONFIG = '/ngrok/ngrok.yml';
const STATE_DIR = '/state';
const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');
const BACKUP_STATUS = '/backups/last-status.json';
const MEDIA_DIR = '/media';
const HEARTBEAT = '/tmp/heartbeat';
const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── Estado compartido (lo que sirve /api/status) ───────────────────────────
const state = {
  startedAt: Date.now(),
  project: '',
  services: [],         // ver collectServices()
  whatsapp: null,       // { status, since, ok }
  ngrok: null,          // { running, http, tcp }
  publicChecks: {},     // nombre → { url, ok, checkedAt, since }
  gateway: null,        // métricas del Gateway
  disk: null,           // { freeBytes, totalBytes }
  media: null,          // { bytes, files }
  certs: [],            // [{ name, validTo, daysLeft }]
  backup: null,         // último estado de las copias
  events: [],           // últimos avisos
};

// ── Salida, historial y tiempo real ────────────────────────────────────────
const sseClients = new Set();

function time(ms = Date.now()) {
  return new Date(ms).toLocaleTimeString('es-ES', { timeZone: TZ, hour12: false });
}

function emit(level, message, logLines = []) {
  console.log(`${time()} ${level} ${message}`);
  for (const line of logLines) console.log(`    │ ${line}`);
  const event = { at: Date.now(), level, message, logs: logLines.slice(-15) };
  state.events.push(event);
  if (state.events.length > 200) state.events.shift();
  persistEvent(event);
  broadcast('event', event);
}

let eventsWritten = 0;
function persistEvent(event) {
  try {
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`);
    if (++eventsWritten % 100 === 0) trimEventsFile();
  } catch { /* sin volumen de estado: solo en memoria */ }
}

function trimEventsFile() {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 1000) fs.writeFileSync(EVENTS_FILE, `${lines.slice(-500).join('\n')}\n`);
  } catch { /* nada que recortar */ }
}

function loadEvents() {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).slice(-200);
    state.events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    trimEventsFile();
  } catch { /* primer arranque */ }
}

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ── SMS (Twilio) ───────────────────────────────────────────────────────────
const twilio = {
  sid: (env.TWILIO_ACCOUNT_SID || '').trim(),
  token: (env.TWILIO_AUTH_TOKEN || '').trim(),
  from: (env.TWILIO_FROM_NUMBER || '').trim(),
  to: (env.TWILIO_TO_NUMBER || '').trim(),
};
const smsEnabled = (env.WATCHDOG_SMS || 'true').toLowerCase() !== 'false'
  && Boolean(twilio.sid && twilio.token && twilio.from && twilio.to);
const smsLastByKey = new Map();
let smsSentToday = [];

// Sin tildes ni símbolos raros: el SMS va a un Nokia y así cabe en GSM-7.
function ascii(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '');
}

async function sendSms(key, text) {
  if (!smsEnabled) return false;
  const now = Date.now();
  smsSentToday = smsSentToday.filter((t) => now - t < 24 * 3600_000);
  if (now - (smsLastByKey.get(key) || 0) < SMS_COOLDOWN_MS) return false;
  if (smsSentToday.length >= SMS_MAX_PER_DAY) {
    emit('INFO', `SMS no enviado: alcanzado el máximo de ${SMS_MAX_PER_DAY} al día.`);
    return false;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: twilio.to, From: twilio.from, Body: ascii(`GateWayNK: ${text}`) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
    smsLastByKey.set(key, now);
    smsSentToday.push(now);
    emit('INFO', 'SMS de aviso enviado.');
    return true;
  } catch (err) {
    emit('INFO', `No se pudo enviar el SMS de aviso: ${err.message}`);
    return false;
  }
}

// ── Alertas con anti-repetición ────────────────────────────────────────────
const alertState = new Map(); // key → { last, suppressed }

async function alert(key, message, { logs = [], sms = null } = {}) {
  const now = Date.now();
  const st = alertState.get(key) || { last: 0, suppressed: 0 };
  if (now - st.last < ALERT_REPEAT_MS) {
    st.suppressed += 1;
    alertState.set(key, st);
    return false;
  }
  const repeated = st.suppressed ? ` (se ha repetido ${st.suppressed} veces más)` : '';
  alertState.set(key, { last: now, suppressed: 0 });
  emit('ALERTA', message + repeated, logs);
  return sms ? sendSms(key, sms) : false;
}

// Condición que puede estar «mal» durante un tiempo: avisa al entrar y al salir.
const conditions = new Map(); // key → { bad, sms }
async function condition(key, bad, { alertText, smsText = null, okText }) {
  const c = conditions.get(key) || { bad: false, sms: false };
  if (bad && !c.bad) {
    c.bad = true;
    c.sms = await alert(key, alertText, { sms: smsText });
  } else if (!bad && c.bad) {
    c.bad = false;
    emit('OK', okText);
    if (c.sms) await sendSms(`ok:${key}`, okText);
    c.sms = false;
  }
  conditions.set(key, c);
}

// ── API de Docker (a través de docker-guard) ───────────────────────────────
function dockerRequest(method, apiPath, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: DOCKER.hostname, port: DOCKER.port || 80, method, path: apiPath, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout en ${method} ${apiPath}`)));
    req.on('error', reject);
    req.end();
  });
}

async function dockerJson(method, apiPath) {
  const res = await dockerRequest(method, apiPath);
  if (res.status >= 400) throw new Error(`${method} ${apiPath}: HTTP ${res.status} ${res.body.toString().trim()}`);
  return res.body.length ? JSON.parse(res.body) : null;
}

// Logs sin TTY: tramas de 8 bytes de cabecera (stream, 0, 0, 0, tamaño BE) + datos.
function demux(buf) {
  if (buf.length < 8 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0 || buf[0] > 2) return buf.toString('utf8');
  let out = '';
  for (let i = 0; i + 8 <= buf.length;) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.toString('utf8', i + 8, i + 8 + size);
    i += 8 + size;
  }
  return out;
}

async function tailLogs(id, lines = 20) {
  try {
    const res = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${lines}`);
    return demux(res.body).split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// ── Contenedores ───────────────────────────────────────────────────────────
let selfId = '';
const services = new Map(); // nombre → { restarts: [], lastRestart, down, downSms }
const intentionalKill = new Map(); // id → instante del último «kill» (stop/restart voluntario)
const oomSeen = new Map();
const cpuPrev = new Map();         // id → { total, system }

function svc(name) {
  if (!services.has(name)) services.set(name, { restarts: [], lastRestart: 0, down: false, downSms: false });
  return services.get(name);
}

function serviceName(c) {
  return c.Labels?.['com.docker.compose.service'] || c.Names?.[0]?.slice(1) || c.Id.slice(0, 12);
}

// Un contenedor es «de verdad» del proyecto si lo creó Docker Compose: lleva config-hash.
// Uno lanzado a mano desde una imagen del proyecto (docker run gatewaynk-…) hereda las
// etiquetas project/service de la imagen, pero no esa.
function isProjectContainer(labels = {}) {
  return labels['com.docker.compose.project'] === state.project
    && Boolean(labels['com.docker.compose.config-hash'])
    && labels['gatewaynk.watchdog'] !== 'off';
}

async function listContainers() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${state.project}`] }));
  const list = await dockerJson('GET', `/containers/json?all=1&filters=${filters}`);
  return list.filter((c) => isProjectContainer(c.Labels));
}

async function findContainer(service) {
  return (await listContainers()).find((c) => c.Labels?.['com.docker.compose.service'] === service) || null;
}

function healthOf(c) {
  if (/\(unhealthy\)/.test(c.Status)) return 'unhealthy';
  if (/\(healthy\)/.test(c.Status)) return 'healthy';
  if (/health: starting/.test(c.Status)) return 'starting';
  return null; // sin healthcheck
}

async function restartContainer(id, name) {
  intentionalKill.set(id, Date.now());
  try {
    await dockerRequest('POST', `/containers/${id}/restart?t=10`, 60_000);
  } catch (err) {
    emit('INFO', `No se pudo reiniciar ${name}: ${err.message}`);
  }
}

// Solo se da por recuperado si lleva un rato seguido en marcha: un servicio que se cae en
// bucle no debe anunciar «vuelve a funcionar» en cada reinicio.
function upFor(info) {
  return info?.State?.StartedAt ? Date.now() - Date.parse(info.State.StartedAt) : 0;
}

// Congelado: el contenedor sigue vivo pero no pasa su healthcheck.
async function handleUnhealthy(c, name) {
  const s = svc(name);
  const now = Date.now();
  if (now - s.lastRestart < RESTART_GRACE_MS) return;
  s.restarts = s.restarts.filter((t) => now - t < 3600_000);
  const looping = s.restarts.length >= MAX_RESTARTS_PER_HOUR;
  if (looping && now - s.lastRestart < SLOW_RETRY_MS) return;

  const logs = await tailLogs(c.Id);
  s.lastRestart = now;
  s.restarts.push(now);
  s.down = true;
  const msg = looping
    ? `${name} sigue sin responder tras ${s.restarts.length - 1} reinicios en la última hora. Nuevo intento (cada ${SLOW_RETRY_MS / 60_000} min). Revisa sus logs.`
    : `${name} no responde (congelado o sin pasar su healthcheck). Reiniciándolo…`;
  s.downSms = await alert(`svc:${name}`, msg, { logs, sms: `${name} no respondia y se ha reiniciado.` }) || s.downSms;
  await restartContainer(c.Id, name);
}

// CPU % a partir de dos muestras consecutivas (stats one-shot no trae la anterior).
async function containerStats(id) {
  try {
    const s = await dockerJson('GET', `/containers/${id}/stats?stream=false&one-shot=true`);
    const total = s.cpu_stats?.cpu_usage?.total_usage || 0;
    const system = s.cpu_stats?.system_cpu_usage || 0;
    const cpus = s.cpu_stats?.online_cpus || 1;
    const prev = cpuPrev.get(id);
    cpuPrev.set(id, { total, system });
    let cpu = null;
    if (prev && system > prev.system) cpu = ((total - prev.total) / (system - prev.system)) * cpus * 100;
    const cache = s.memory_stats?.stats?.inactive_file || 0;
    return {
      cpu: cpu === null ? null : Math.max(0, Math.round(cpu * 10) / 10),
      memBytes: Math.max(0, (s.memory_stats?.usage || 0) - cache),
      memLimit: s.memory_stats?.limit || 0,
    };
  } catch {
    return { cpu: null, memBytes: null, memLimit: null };
  }
}

async function poll() {
  const list = await listContainers();
  const snapshot = [];
  for (const c of list) {
    const name = serviceName(c);
    const health = healthOf(c);
    const info = await dockerJson('GET', `/containers/${c.Id}/json`).catch(() => null);
    const stats = c.State === 'running' ? await containerStats(c.Id) : { cpu: null, memBytes: null, memLimit: null };
    snapshot.push({
      name, state: c.State, health, status: c.Status,
      upMs: c.State === 'running' ? upFor(info) : 0,
      restartCount: info?.RestartCount ?? 0,
      ...stats,
    });
    if (c.Id === selfId) continue;
    const s = svc(name);
    if (c.State === 'running' && health === 'unhealthy') {
      await handleUnhealthy(c, name);
    } else if (s.down && c.State === 'running' && (health === 'healthy' || health === null)
               && upFor(info) >= RECOVERY_STABLE_MS) {
      s.down = false;
      emit('OK', `${name} vuelve a funcionar.`);
      if (s.downSms) await sendSms(`ok:${name}`, `${name} vuelve a funcionar.`);
      s.downSms = false;
    }
  }
  state.services = snapshot.sort((a, b) => a.name.localeCompare(b.name));
  await collectGatewayMetrics();
  fs.writeFileSync(HEARTBEAT, String(Date.now()));
  broadcast('status', publicStatus());
}

// ── Eventos: caídas en tiempo real ─────────────────────────────────────────
async function onEvent(ev) {
  const id = ev.Actor?.ID || ev.id;
  if (!id || id === selfId) return;
  const attrs = ev.Actor?.Attributes || {};   // incluye las etiquetas del contenedor
  if (!isProjectContainer(attrs)) return;
  const name = attrs['com.docker.compose.service'] || attrs.name || '?';
  const now = Date.now();
  switch (ev.Action || ev.status) {
    case 'kill':
      // docker stop / restart / compose down mandan «kill» antes de «die»: no es una caída.
      intentionalKill.set(id, now);
      break;
    case 'oom':
      oomSeen.set(id, now);
      break;
    case 'die': {
      if (now - (intentionalKill.get(id) || 0) < 30_000) return;
      const oom = now - (oomSeen.get(id) || 0) < 30_000;
      const code = attrs.exitCode ?? '?';
      const s = svc(name);
      s.down = true;
      const logs = await tailLogs(id);
      const why = oom ? `sin memoria (OOM), código ${code}` : `código ${code}`;
      s.downSms = await alert(`svc:${name}`, `${name} se ha caído (${why}). Docker lo está reiniciando…`, {
        logs,
        sms: `${name} se ha caido (${why}). Reiniciando automaticamente.`,
      }) || s.downSms;
      break;
    }
    default:
      break;
  }
}

function watchEvents() {
  const filters = encodeURIComponent(JSON.stringify({
    type: ['container'],
    event: ['die', 'kill', 'oom'],
    label: [`com.docker.compose.project=${state.project}`],
  }));
  const req = http.request({ host: DOCKER.hostname, port: DOCKER.port || 80, path: `/events?filters=${filters}` }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line)).catch((err) => emit('INFO', `Error procesando evento: ${err.message}`));
        } catch { /* línea incompleta o no JSON */ }
      }
    });
    res.on('end', () => setTimeout(watchEvents, 2000));
  });
  req.on('error', () => setTimeout(watchEvents, 5000));
  req.end();
}

// ── Gateway: peticiones por minuto, últimas peticiones y errores ──────────
async function collectGatewayMetrics() {
  try {
    const res = await fetch('http://gateway:9100/metrics', { signal: AbortSignal.timeout(3000) });
    state.gateway = await res.json();
  } catch {
    state.gateway = null;
  }
}

// ── ngrok ──────────────────────────────────────────────────────────────────
let ngrokMisses = 0;

function expectedNgrokTunnels() {
  try {
    const cfg = fs.readFileSync(NGROK_CONFIG, 'utf8');
    return { http: /proto:\s*http\b/.test(cfg), tcp: /proto:\s*tcp\b/.test(cfg) };
  } catch {
    return { http: false, tcp: false };
  }
}

async function checkNgrok() {
  const ngrok = await findContainer('ngrok');
  if (!ngrok || ngrok.State !== 'running') { ngrokMisses = 0; state.ngrok = { running: false }; return; }
  const expected = expectedNgrokTunnels();
  let tunnels = [];
  try {
    const res = await fetch('http://ngrok:4040/api/tunnels', { signal: AbortSignal.timeout(5000) });
    tunnels = (await res.json()).tunnels || [];
  } catch { /* API caída: cuenta como fallo */ }
  // Con schemes http+https hay dos URLs: la http:// es la del Nokia.
  const urls = tunnels.map((t) => t.public_url || '');
  const httpUrl = urls.find((u) => u.startsWith('http://')) || urls.find((u) => u.startsWith('https://')) || null;
  const tcp = tunnels.find((t) => (t.public_url || '').startsWith('tcp://'));
  state.ngrok = { running: true, http: httpUrl, tcp: tcp?.public_url || null };
  const missing = (expected.http && !httpUrl) || (expected.tcp && !tcp);

  if (missing) {
    ngrokMisses += 1;
    if (ngrokMisses >= 3) {
      ngrokMisses = 0;
      const logs = await tailLogs(ngrok.Id);
      const s = svc('ngrok');
      s.down = true;
      s.downSms = await alert('ngrok:tunnels', 'ngrok está en marcha pero le faltan túneles. Reiniciándolo…', {
        logs, sms: 'ngrok perdio sus tuneles y se ha reiniciado.',
      }) || s.downSms;
      await restartContainer(ngrok.Id, 'ngrok');
    }
    return;
  }
  ngrokMisses = 0;

  // HTTPS del Nokia por ngrok TCP: la dirección cambia cada vez que ngrok se reinicia.
  if (tcp && (env.NOKIA_TLS_PROVIDER || 'ngrok') === 'ngrok') await syncNgrokTlsAddress(tcp.public_url);
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

async function syncNgrokTlsAddress(publicUrl) {
  const address = publicUrl.replace(/^tcp:\/\//, '');
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(address)) return;
  if (readFile(`${TLS_DIR}/public-address`) === address) return;
  fs.writeFileSync(`${TLS_DIR}/public-address`, `${address}\n`);
  emit('INFO', `Nueva dirección TCP de ngrok para el Nokia: ${address}. Reiniciando nokia-tls…`);
  const tlsContainer = await findContainer('nokia-tls');
  if (tlsContainer) await restartContainer(tlsContainer.Id, 'nokia-tls');
  if (readFile(`${TLS_DIR}/last-notified-address`) !== address) {
    const sent = await sendSms(`tls-address:${address}`,
      `nueva direccion segura https://${address}/ . Actualiza el marcador del Nokia.`);
    if (sent) fs.writeFileSync(`${TLS_DIR}/last-notified-address`, `${address}\n`);
  }
}

// ── Entradas públicas (prueba desde fuera) ─────────────────────────────────
const publicFails = new Map();

async function probe(url, check) {
  try {
    const res = await fetch(url, {
      headers: { 'ngrok-skip-browser-warning': '1', 'User-Agent': 'GateWayNK-watchdog' },
      signal: AbortSignal.timeout(15_000),
    });
    return check(res, await res.text());
  } catch {
    return false;
  }
}

async function checkPublic(name, url, check, hint) {
  const ok = await probe(url, check);
  const prev = state.publicChecks[name];
  const now = Date.now();
  state.publicChecks[name] = {
    url, ok, checkedAt: now,
    since: prev && prev.ok === ok ? prev.since : now,
  };
  const fails = ok ? 0 : (publicFails.get(name) || 0) + 1;
  publicFails.set(name, fails);
  // Dos fallos seguidos para avisar (un corte de un segundo no es una caída).
  if (ok || fails >= 2) {
    await condition(`public:${name}`, !ok, {
      alertText: `${name} no responde desde Internet (${url}). ${hint}`,
      smsText: `${name} no responde desde Internet.`,
      okText: `${name} vuelve a responder desde Internet.`,
    });
  }
}

async function checkPublicEntrances() {
  const ngrok = await findContainer('ngrok');
  const httpUrl = (env.NGROK_HTTP_URL || '').replace(/\/$/, '');
  if (ngrok?.State === 'running' && httpUrl && expectedNgrokTunnels().http) {
    await checkPublic('La entrada HTTP (ngrok)', `${httpUrl}/health`,
      (res, body) => res.ok && body.includes('"ok"'), 'Revisa: expose.sh logs ngrok');
  } else {
    delete state.publicChecks['La entrada HTTP (ngrok)'];
  }
  const tlsAddress = readFile(`${TLS_DIR}/public-address`);
  if (/^[A-Za-z0-9.-]+:\d{1,5}$/.test(tlsAddress)) {
    // nokia-tls responde en claro por el mismo puerto (página que remite a https://):
    // si llega, el túnel TCP y nokia-tls funcionan.
    const provider = env.NOKIA_TLS_PROVIDER || 'ngrok';
    await checkPublic(`El HTTPS del Nokia (${provider})`, `http://${tlsAddress}/`,
      (_res, body) => body.includes('NokiaMSN'),
      provider === 'playit' ? 'Revisa el agente de playit: systemctl status playit' : 'Revisa: expose.sh logs ngrok');
  }
}

// ── WhatsApp ───────────────────────────────────────────────────────────────
async function checkWhatsapp() {
  let info = null;
  try {
    const res = await fetch('http://nokia-msn:3001/healthz', { signal: AbortSignal.timeout(5000) });
    info = await res.json();
  } catch { /* nokia-msn caído: de eso ya avisa el resto */ }
  if (!info) { state.whatsapp = null; return; }
  const since = info.lastChange ? Date.parse(info.lastChange) : Date.now();
  const connected = info.status === 'connected';
  state.whatsapp = { status: info.status, since, ok: connected };
  await condition('whatsapp', !connected && Date.now() - since > WA_ALERT_MS, {
    alertText: `WhatsApp lleva más de ${WA_ALERT_MS / 60_000} min sin conexión (estado: ${info.status}). Si pide QR: /whatsapp/qr`,
    smsText: `WhatsApp lleva mas de ${WA_ALERT_MS / 60_000} min desconectado (${info.status}).`,
    okText: 'WhatsApp vuelve a estar conectado.',
  });
}

// ── Disco, media, certificados y copias ────────────────────────────────────
async function checkDisk() {
  try {
    const s = fs.statfsSync(STATE_DIR);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    state.disk = { freeBytes: free, totalBytes: total };
    const gb = (free / 1024 ** 3).toFixed(1);
    await condition('disk', free < DISK_MIN_FREE_BYTES || free / total < 0.05, {
      alertText: `Queda poco disco en el PC: ${gb} GB libres.`,
      smsText: `Queda poco disco en el PC (${gb} GB libres).`,
      okText: `Vuelve a haber espacio en disco (${gb} GB libres).`,
    });
  } catch { state.disk = null; }
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; files += 1; } catch { /* borrado */ } }
    }
  }
  return { bytes, files };
}

function checkMedia() {
  state.media = fs.existsSync(MEDIA_DIR) ? dirSize(MEDIA_DIR) : null;
}

async function checkCerts() {
  const certs = [];
  const address = readFile(`${TLS_DIR}/public-address`);
  const files = [['Raíz instalada en el Nokia', `${TLS_DIR}/ca.pem`]];
  if (address) files.push([`Servidor ${address.split(':')[0]}`, `${TLS_DIR}/server-${address.split(':')[0]}.pem`]);
  for (const [name, file] of files) {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(file));
      const validTo = Date.parse(x.validTo);
      const daysLeft = Math.floor((validTo - Date.now()) / 86_400_000);
      certs.push({ name, validTo, daysLeft });
      await condition(`cert:${name}`, daysLeft < CERT_WARN_DAYS, {
        alertText: `El certificado «${name}» caduca en ${daysLeft} días (${new Date(validTo).toLocaleDateString('es-ES')}).`,
        smsText: `El certificado ${name} caduca en ${daysLeft} dias.`,
        okText: `El certificado «${name}» ya no está a punto de caducar.`,
      });
    } catch { /* fichero aún no generado */ }
  }
  state.certs = certs;
}

async function checkBackup() {
  const backupContainer = await findContainer('backup');
  if (!backupContainer) { state.backup = null; return; }
  let st = null;
  try { st = JSON.parse(fs.readFileSync(BACKUP_STATUS, 'utf8')); } catch { /* aún ninguna */ }
  state.backup = st ? { ...st, atMs: Date.parse(st.at) } : { ok: null };
  if (!st) return;
  await condition('backup:failed', st.ok === false, {
    alertText: `La última copia de seguridad ha fallado: ${st.error}`,
    smsText: 'La copia de seguridad ha fallado.',
    okText: 'Las copias de seguridad vuelven a funcionar.',
  });
  const lastOk = st.ok ? Date.parse(st.at) : null;
  // Solo cuenta la antigüedad si la última fue correcta (si falló, ya avisa lo anterior).
  if (lastOk) {
    await condition('backup:old', Date.now() - lastOk > BACKUP_MAX_AGE_MS, {
      alertText: `No hay copia de seguridad nueva desde hace más de ${BACKUP_MAX_AGE_MS / 3600_000} h.`,
      smsText: 'No hay copia de seguridad reciente.',
      okText: 'Vuelve a haber una copia de seguridad reciente.',
    });
  }
}

// ── Servidor de estado ─────────────────────────────────────────────────────
function publicStatus() {
  return {
    now: Date.now(),
    startedAt: state.startedAt,
    project: state.project,
    sms: smsEnabled,
    tlsProvider: env.NOKIA_TLS_PROVIDER || 'ngrok',
    tlsAddress: readFile(`${TLS_DIR}/public-address`) || null,
    services: state.services,
    whatsapp: state.whatsapp,
    ngrok: state.ngrok,
    publicChecks: state.publicChecks,
    gateway: state.gateway,
    disk: state.disk,
    media: state.media,
    certs: state.certs,
    backup: state.backup,
    problems: [...conditions.entries()].filter(([, c]) => c.bad).map(([k]) => k),
    events: state.events.slice(-60),
  };
}

function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://watchdog');
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(publicStatus()));
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(publicStatus())}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return undefined;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(DASHBOARD).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('No encontrado');
  });
  server.listen(HTTP_PORT, () => emit('INFO', `Página de estado en el puerto ${HTTP_PORT}.`));
}

// ── Arranque ───────────────────────────────────────────────────────────────
function every(ms, fn, label, firstDelay = ms) {
  if (!ms) return;
  const run = async () => {
    try { await fn(); } catch (err) { emit('INFO', `Error en ${label}: ${err.message}`); }
    setTimeout(run, ms);
  };
  setTimeout(run, firstDelay);
}

async function main() {
  loadEvents();
  // El propio contenedor (su id corto es el hostname) da el proyecto de Compose.
  const self = await dockerJson('GET', `/containers/${os.hostname()}/json`);
  selfId = self.Id;
  state.project = self.Config?.Labels?.['com.docker.compose.project'];
  if (!state.project) throw new Error('el watchdog debe arrancarse con Docker Compose');
  const names = (await listContainers()).filter((c) => c.Id !== selfId).map(serviceName);
  emit('INFO', `Vigilando ${names.join(', ')} (proyecto ${state.project}). SMS de aviso: ${smsEnabled ? 'sí' : 'no'}.`);
  startHttpServer();
  watchEvents();
  every(POLL_MS, poll, 'la comprobación', 1000);
  every(NGROK_CHECK_MS, checkNgrok, 'la comprobación de ngrok', 5000);
  every(PUBLIC_CHECK_MS, checkPublicEntrances, 'la prueba de las entradas públicas', 30_000);
  every(30_000, checkWhatsapp, 'la comprobación de WhatsApp', 5000);
  every(5 * 60_000, checkDisk, 'la comprobación del disco', 3000);
  every(10 * 60_000, checkMedia, 'el tamaño de media', 4000);
  every(6 * 3600_000, checkCerts, 'la comprobación de certificados', 6000);
  every(10 * 60_000, checkBackup, 'la comprobación de copias', 7000);
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));

// Retrying: docker-guard puede tardar un poco más en arrancar.
(async function boot(attempt = 1) {
  try {
    await main();
  } catch (err) {
    if (attempt < 10) {
      setTimeout(() => boot(attempt + 1), 3000);
      return;
    }
    emit('ALERTA', `El watchdog no puede arrancar: ${err.message}`);
    process.exit(1);
  }
}());
