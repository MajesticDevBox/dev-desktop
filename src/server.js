// Dev Desktop server: static UI + JSON API + Server-Sent Events for live updates.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import './db.js';
import { bus, startPollers, refreshProject, refreshGit, refreshGithubOwner, runHealthCheck } from './live.js';
import { scanRepos } from './scan.js';
import * as P from './projects.js';
import { q } from './db.js';
import * as GH from './githubAuth.js';
import { containerAction, containerLogs } from './collectors/docker.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const send = (res, code, body, type = 'application/json') => {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

// ---------- SSE ----------
const clients = new Set();
bus.on('event', (evt) => {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
});
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

const structure = () => bus.emit('event', { t: 'structure' });

// Settings writes carry credentials: refuse cross-site requests (CSRF) by requiring a same-origin Origin and a JSON body.
function guardSettings(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw Object.assign(new Error('cross-origin request refused'), { status: 403 });
  if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('expected application/json'), { status: 415 });
}

const githubSettings = () => ({ credentials: GH.listCredentials(), owners: P.githubOwners() });

// ---------- routes ----------
// [method, regex, handler(match, body, req, res)]
const routes = [
  ['GET', /^\/healthz$/, () => ({ ok: true })],
  ['GET', /^\/api\/state$/, () => P.snapshot()],

  ['GET', /^\/api\/settings\/github$/, () => githubSettings()],
  ['PUT', /^\/api\/settings\/github\/([^/]+)$/, (m, body, req) => {
    guardSettings(req);
    const owner = GH.cleanOwner(m[1]);
    GH.saveToken(owner, body.token);
    refreshGithubOwner(owner).catch(() => {});
    return githubSettings();
  }],
  ['DELETE', /^\/api\/settings\/github\/([^/]+)$/, (m, _b, req) => {
    guardSettings(req);
    const owner = GH.cleanOwner(m[1]);
    GH.removeToken(owner);
    refreshGithubOwner(owner).catch(() => {});
    return githubSettings();
  }],
  // Test a token typed into the form (body.token) or the one already stored for body.owner.
  ['POST', /^\/api\/settings\/github\/test$/, async (_m, body, req) => {
    guardSettings(req);
    const owner = GH.cleanOwner(body.owner);
    const token = body.token ? GH.cleanToken(body.token) : GH.resolveToken(owner).token;
    if (!token) throw Object.assign(new Error('No token to test'), { status: 400 });
    const sample = P.githubOwners().find((o) => o.owner === owner)?.sample;
    return GH.testToken(token, sample);
  }],

  ['POST', /^\/api\/rescan$/, async () => {
    const r = await scanRepos();
    structure();
    return r;
  }],
  ['POST', /^\/api\/refresh$/, async (_m, body) => {
    if (body.id) await refreshProject(Number(body.id));
    else for (const r of q.all('SELECT id FROM projects WHERE active = 1')) refreshProject(r.id).catch(() => {});
    return { ok: true };
  }],

  ['POST', /^\/api\/projects$/, (_m, body) => {
    const id = P.createManualProject(body);
    structure();
    return { id };
  }],
  ['PATCH', /^\/api\/projects\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    P.patchProject(id, body);
    structure();
    if ('active' in body || 'githubRepo' in body) refreshProject(id).catch(() => {}); // fetch fresh data right away
    return { ok: true };
  }],
  ['DELETE', /^\/api\/projects\/(\d+)$/, (m) => {
    P.deleteProject(Number(m[1]));
    structure();
    return { ok: true };
  }],

  ['POST', /^\/api\/projects\/(\d+)\/links$/, async (m, body) => {
    const link = P.addLink(Number(m[1]), body);
    structure();
    if (link.check_health) runHealthCheck(link).catch(() => {});
    return { id: link.id };
  }],
  ['POST', /^\/api\/links$/, async (_m, body) => {
    const link = P.addLink(null, body);
    structure();
    if (link.check_health) runHealthCheck(link).catch(() => {});
    return { id: link.id };
  }],
  ['PATCH', /^\/api\/links\/(\d+)$/, (m, body) => {
    const link = P.patchLink(Number(m[1]), body);
    structure();
    if (link.check_health) runHealthCheck(link).catch(() => {});
    return { ok: true };
  }],
  ['DELETE', /^\/api\/links\/(\d+)$/, (m) => {
    P.deleteLink(Number(m[1]));
    structure();
    return { ok: true };
  }],

  ['POST', /^\/api\/projects\/(\d+)\/commands$/, (m, body) => {
    P.addCommand(Number(m[1]), body);
    structure();
    return { ok: true };
  }],
  ['DELETE', /^\/api\/commands\/(\d+)$/, (m) => {
    P.deleteCommand(Number(m[1]));
    structure();
    return { ok: true };
  }],

  ['POST', /^\/api\/docker\/([a-f0-9]+)\/(start|stop|restart)$/, async (m) => {
    await containerAction(m[1], m[2]);
    return { ok: true };
  }],
  ['GET', /^\/api\/docker\/([a-f0-9]+)\/logs$/, async (m, _b, req) => {
    const tail = new URL(req.url, 'http://x').searchParams.get('tail');
    return { logs: await containerLogs(m[1], tail) };
  }],
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/events') return sse(req, res);

  if (pathname.startsWith('/api/') || pathname === '/healthz') {
    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = pathname.match(re);
      if (!m) continue;
      try {
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
        return send(res, 200, await fn(m, body, req, res));
      } catch (e) {
        if (!e.status) console.error('[api]', req.method, pathname, e);
        return send(res, e.status || 500, { error: e.message });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  // static files
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[server]', e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.end();
  });
});

P.seedDefaults();
await scanRepos();
startPollers();
setInterval(() => scanRepos().catch((e) => console.error('[scan]', e.message)), config.intervals.rescanMs);

server.listen(config.port, '0.0.0.0', () => console.log(`Dev Desktop listening on :${config.port}  (data: ${config.dataDir}, repos: ${config.reposDir})`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
