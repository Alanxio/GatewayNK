const dns = require('node:dns').promises;
const express = require('express');
const { createProxyServer } = require('http-proxy');

const app = express();
app.disable('x-powered-by');
const port = Number(process.env.GATEWAY_PORT || 8080);

const nokiaMsnTarget = process.env.NOKIA_MSN_URL || 'http://nokia-msn:3001';
const galleryTarget = process.env.GALLERY_URL || 'http://gallery:3002';
const playmeTarget = process.env.PLAYME_URL || 'http://playme:4000';
const discordProxyTarget = process.env.DISCORD_PROXY_URL || 'http://discord-proxy:3000';
// Contenedor que termina el TLS 1.0 del Nokia: el único que puede marcar una petición
// como cifrada con «X-Nokia-TLS: 1».
const nokiaTlsHost = process.env.NOKIA_TLS_HOST || 'nokia-tls';

const proxy = createProxyServer({ changeOrigin: true, secure: false, xfwd: true });

proxy.on('error', (err, req, res) => {
  console.error(`[gateway] ${req.method} ${req.originalUrl || req.url}: ${err.message}`);
  // En un upgrade (WebSocket) "res" es el socket, no una respuesta HTTP.
  if (typeof res.writeHead !== 'function') {
    res.destroy?.();
    return;
  }
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway');
  } else {
    // La respuesta ya había empezado: cortarla en vez de dejarla colgada.
    res.destroy();
  }
});

const normalizeIp = (ip) => (ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip);

// ── Registro de peticiones y métricas ──────────────────────────────────────
// Línea por petición:  HH:MM:SS TLS  81.40.1.2  GET /usuario/… → 200 35ms 4.1KB
// Nunca se registran cookies, cabeceras, cuerpos ni query strings (pueden llevar tokens);
// los segmentos que son tokens (URLs firmadas de audio, códigos largos) se ocultan.
const TZ = process.env.GATEWAY_TZ || 'Europe/Madrid';
const QUIET_PATHS = new Set(['/health']);
const MINUTES = 60;
const metrics = {
  startedAt: Date.now(),
  minutes: [],      // [{ t, count, tls, http, s2, s3, s4, s5, totalMs }]
  recent: [],       // últimas peticiones (ya ocultadas)
  errors: [],       // últimas respuestas 5xx
};

function hhmmss(date = new Date()) {
  return date.toLocaleTimeString('es-ES', { timeZone: TZ, hour12: false });
}

function redactPath(url) {
  const [pathname, query] = String(url || '').split('?');
  const safe = pathname
    // /audio/:id/:token/:fichero → el token fuera
    .replace(/^(\/audio\/[^/]+\/)[^/]+/, '$1…')
    // cualquier segmento con pinta de token (largo y alfanumérico)
    .split('/').map((seg) => (/^[A-Za-z0-9_-]{24,}$/.test(seg) ? '…' : seg)).join('/');
  return query !== undefined ? `${safe}?…` : safe;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return normalizeIp(forwarded || req.socket.remoteAddress) || '?';
}

function minuteBucket(now) {
  const t = Math.floor(now / 60_000) * 60_000;
  let bucket = metrics.minutes[metrics.minutes.length - 1];
  if (!bucket || bucket.t !== t) {
    bucket = { t, count: 0, tls: 0, http: 0, s2: 0, s3: 0, s4: 0, s5: 0, totalMs: 0 };
    metrics.minutes.push(bucket);
    while (metrics.minutes.length > MINUTES) metrics.minutes.shift();
  }
  return bucket;
}

function pushCapped(list, item, max) {
  list.push(item);
  if (list.length > max) list.shift();
}

function accessLog(req, res, next) {
  if (QUIET_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  const via = req.headers['x-nokia-tls'] === '1' ? 'TLS' : 'HTTP';
  const ip = clientIp(req);
  const path = redactPath(req.originalUrl);
  let bytes = 0;
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, ...rest) { if (chunk) bytes += Buffer.byteLength(chunk); return write.call(this, chunk, ...rest); };
  res.end = function (chunk, ...rest) { if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk); return end.call(this, chunk, ...rest); };

  res.on('close', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.headersSent ? res.statusCode : 0;   // 0 = el cliente cortó antes
    const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
    console.log(`${hhmmss()} ${via.padEnd(4)} ${ip.padEnd(15)} ${req.method} ${path} → ${status || 'cortada'} ${Math.round(ms)}ms ${size}`);

    const now = Date.now();
    const bucket = minuteBucket(now);
    bucket.count += 1;
    bucket[via === 'TLS' ? 'tls' : 'http'] += 1;
    const cls = Math.floor(status / 100);
    if (cls >= 2 && cls <= 5) bucket[`s${cls}`] += 1;
    bucket.totalMs += ms;
    const entry = { at: now, via, ip, method: req.method, path, status, ms: Math.round(ms), bytes };
    pushCapped(metrics.recent, entry, 40);
    if (status >= 500 || status === 0) pushCapped(metrics.errors, entry, 20);
  });
  next();
}

// Métricas en un puerto aparte que NO se publica: solo lo ve el watchdog dentro de la red
// de Docker, nunca Internet (el puerto público del Gateway no las sirve).
const metricsPort = Number(process.env.GATEWAY_METRICS_PORT || 9100);
require('node:http').createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...metrics, now: Date.now() }));
}).listen(metricsPort);

// ¿Viene esta conexión del contenedor nokia-tls? Se resuelve en cada petición marcada
// (solo las del Nokia por HTTPS, y el DNS interno de Docker responde al momento) porque
// expose.sh reinicia nokia-tls y su IP puede cambiar.
async function isFromNokiaTls(req) {
  try {
    const addresses = await dns.lookup(nokiaTlsHost, { all: true });
    const remote = normalizeIp(req.socket.remoteAddress);
    return addresses.some(({ address }) => normalizeIp(address) === remote);
  } catch {
    return false;
  }
}

// X-Nokia-TLS solo la puede poner nokia-tls. Por la entrada HTTP en claro (ngrok) un
// cliente podría mandarla para hacerse pasar por HTTPS: se descarta.
app.use(async (req, _res, next) => {
  if (req.headers['x-nokia-tls'] !== undefined && !(await isFromNokiaTls(req))) {
    delete req.headers['x-nokia-tls'];
  }
  next();
});

// Registro de peticiones (una línea cada una) y métricas para el watchdog.
app.use(accessLog);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Gallery endpoints
// Express strips '/gallery' from req.url automatically here.
// e.g. /gallery/list becomes /list for the target
app.use('/gallery', (req, res) => {
  proxy.web(req, res, { target: galleryTarget });
});

// Discord J2ME proxy endpoints (HTTP API proxy for the discord-j2me client).
// Express strips '/discord' from req.url automatically here, e.g.
// /discord/api/v9/... becomes /api/v9/... for the target, matching what the
// proxy expects on its own root. Configure the J2ME client's proxy URL as
// https://<this-gateway>/discord — the client appends /api/v9/... itself.
// Note: the proxy's own bundled web pages (download/guide, static assets)
// use root-absolute paths (e.g. /style.css), so those will render broken
// when browsed through this prefix; only the API surface is guaranteed to work.
app.use('/discord', (req, res) => {
  proxy.web(req, res, { target: discordProxyTarget });
});

// PlayME endpoints
// Routes under /playme should work both as the homepage (/playme)
// and as a prefixed namespace (/playme/admin, /playme/catalog, etc.).
const playmePaths = [
  '/admin', '/uploads', '/tmp-covers', '/vendor',
  '/catalog', '/song', '/cover', '/stream', '/css', '/js'
];

app.use((req, res, next) => {
  const path = req.path;

  // Keep the PlayME landing page available at /playme
  if (path === '/playme' || path === '/playme/') {
    return proxy.web(req, res, { target: playmeTarget });
  }

  // Allow /playme/* to map to the backend root paths
  if (path.startsWith('/playme/')) {
    req.url = req.url.replace(/^\/playme/, '');
    return proxy.web(req, res, { target: playmeTarget });
  }

  if (playmePaths.some(p => path === p || path.startsWith(p + '/'))) {
    return proxy.web(req, res, { target: playmeTarget });
  }

  next();
});

// All other requests go to NokiaMSN
// NokiaMSN uses absolute paths (e.g. href="/usuario") so it MUST be mounted at the root.
// X-Forwarded-Proto se fuerza a https (NokiaMSN NO lo usa para decidir el esquema; para
// eso mira X-Nokia-TLS).
app.use('/', (req, res) => {
  proxy.web(req, res, {
    target: nokiaMsnTarget,
    headers: {
      'X-Forwarded-Proto': 'https'
    }
  });
});

const server = app.listen(port, () => {
  console.log(`[gateway] listening on port ${port}`);
  console.log(`[gateway] /gallery -> ${galleryTarget}`);
  console.log(`[gateway] /playme, /admin, /catalog... -> ${playmeTarget}`);
  console.log(`[gateway] /discord -> ${discordProxyTarget}`);
  console.log(`[gateway] /* -> ${nokiaMsnTarget}`);
  console.log(`[gateway] X-Nokia-TLS solo se acepta desde ${nokiaTlsHost}`);
});

// Docker manda SIGTERM al parar/reiniciar: cerrar ya en vez de esperar los 10 s del SIGKILL.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[gateway] ${signal}: cerrando`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
