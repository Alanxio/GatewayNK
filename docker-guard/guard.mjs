// docker-guard — el único contenedor con el socket de Docker. Reenvía a Docker solo las
// llamadas que necesita el watchdog y rechaza todo lo demás (crear contenedores, exec,
// montar volúmenes, imágenes…), que con el socket completo equivaldría a ser root en el PC.
//
// Permitido (con o sin prefijo de versión /v1.xx):
//   GET  /_ping, /version
//   GET  /containers/json                 listar
//   GET  /containers/{id}/json            inspeccionar
//   GET  /containers/{id}/logs            logs (también en streaming)
//   GET  /containers/{id}/stats           CPU / memoria
//   GET  /events                          eventos (streaming)
//   POST /containers/{id}/restart         solo contenedores de ESTE proyecto de Compose
// Escucha solo dentro de la red de Docker (sin puerto publicado).
import http from 'node:http';
import os from 'node:os';

const SOCKET = '/var/run/docker.sock';
const PORT = Number(process.env.GUARD_PORT || 2375);
let PROJECT = '';

const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}';
const ALLOWED = [
  ['GET', /^\/_ping$/],
  ['GET', /^\/version$/],
  ['GET', /^\/containers\/json$/],
  ['GET', new RegExp(`^/containers/${ID}/(json|logs|stats)$`)],
  ['GET', /^\/events$/],
  ['POST', new RegExp(`^/containers/(${ID})/restart$`)],
];

function log(...parts) {
  console.log(`[docker-guard] ${parts.join(' ')}`);
}

function docker(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path, timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Solo se reinician contenedores con la etiqueta del proyecto de Compose del propio guard.
async function belongsToProject(id) {
  const res = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
  if (res.status !== 200) return false;
  const labels = JSON.parse(res.body).Config?.Labels || {};
  // config-hash: solo lo llevan los contenedores creados por Compose (no los lanzados a
  // mano desde una imagen del proyecto, que heredan project/service de la imagen).
  return Boolean(PROJECT) && labels['com.docker.compose.project'] === PROJECT
    && Boolean(labels['com.docker.compose.config-hash']);
}

function deny(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://guard');
  const path = url.pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, '');
  const rule = ALLOWED.find(([method, re]) => method === req.method && re.test(path));
  if (!rule) {
    log(`DENEGADO ${req.method} ${url.pathname}`);
    return deny(res, 403, 'docker-guard: operación no permitida');
  }
  if (req.method === 'POST') {
    const id = path.match(rule[1])[1];
    if (!(await belongsToProject(id).catch(() => false))) {
      log(`DENEGADO reinicio de ${id}: no es del proyecto ${PROJECT}`);
      return deny(res, 403, 'docker-guard: el contenedor no es de este proyecto');
    }
    log(`reinicio de ${id}`);
  }
  // Reenvío en streaming (logs -f, events): la respuesta de Docker pasa tal cual.
  const upstream = http.request({
    socketPath: SOCKET, method: req.method, path: `${path}${url.search}`,
    headers: { Host: 'docker' },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) deny(res, 502, `docker-guard: ${err.message}`);
    else res.destroy();
  });
  // Si el cliente se va (p. ej. deja de seguir los logs), cortar también con Docker.
  res.on('close', () => upstream.destroy());
  upstream.end();
});

// El proyecto se saca de las etiquetas del propio contenedor (lo pone Docker Compose).
try {
  const self = await docker('GET', `/containers/${os.hostname()}/json`);
  PROJECT = JSON.parse(self.body).Config?.Labels?.['com.docker.compose.project'] || '';
} catch (err) {
  log(`No se pudo leer el proyecto propio: ${err.message}`);
}
server.listen(PORT, () => log(`escuchando en :${PORT}; reinicios solo del proyecto «${PROJECT || '(sin definir: ninguno)'}»`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
