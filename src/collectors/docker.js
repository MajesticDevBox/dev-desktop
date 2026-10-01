// Docker collector: talks to the Docker Engine API over the mounted unix socket.
import http from 'node:http';
import fs from 'node:fs';
import { config } from '../config.js';

function request(method, path, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.dockerSocket, path, method, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = body.toString();
          try {
            msg = JSON.parse(msg).message || msg;
          } catch {}
          return reject(Object.assign(new Error(msg || `docker ${res.statusCode}`), { status: res.statusCode }));
        }
        if (raw) return resolve(body);
        if (!body.length) return resolve(null);
        try {
          resolve(JSON.parse(body.toString()));
        } catch {
          resolve(body.toString());
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
    req.on('error', reject);
    req.end();
  });
}

export const dockerAvailable = () => fs.existsSync(config.dockerSocket);

/** Normalise a compose working dir (may be a Windows path) to its lowercase basename. */
export function workdirKey(dir) {
  if (!dir) return null;
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1].toLowerCase();
}

export async function listContainers() {
  const list = await request('GET', '/containers/json?all=1');
  return list.map((c) => {
    const labels = c.Labels || {};
    const ports = [...new Map((c.Ports || []).filter((p) => p.PublicPort).map((p) => [p.PublicPort, p])).values()].map((p) => ({
      public: p.PublicPort,
      private: p.PrivatePort,
      type: p.Type,
    }));
    return {
      id: c.Id.slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State, // running | exited | paused | restarting | created
      status: c.Status, // "Up 3 hours (healthy)"
      health: /\(healthy\)/.test(c.Status) ? 'healthy' : /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : /health: starting/.test(c.Status) ? 'starting' : null,
      ports,
      composeProject: labels['com.docker.compose.project'] || null,
      composeService: labels['com.docker.compose.service'] || null,
      workdirKey: workdirKey(labels['com.docker.compose.project.working_dir']),
      createdAt: c.Created * 1000,
    };
  });
}

export const containerAction = (id, action) => {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('bad action');
  if (!/^[a-f0-9]{6,64}$/.test(id)) throw new Error('bad container id');
  return request('POST', `/containers/${id}/${action}`);
};

/** Demultiplex the Docker log stream (8-byte frame headers) when the container has no TTY. */
export function demux(buf) {
  let out = '';
  let i = 0;
  const looksFramed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString('utf8');
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out;
}

export async function containerLogs(id, tail = 200) {
  if (!/^[a-f0-9]{6,64}$/.test(id)) throw new Error('bad container id');
  const buf = await request('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${Math.min(+tail || 200, 1000)}`, { raw: true });
  return demux(buf);
}

/** Group containers by project slug. Returns { byProject: {slug: [...]}, other: [...] } */
export function matchContainers(containers, slugs) {
  const bySlugLower = new Map(slugs.map((s) => [s.toLowerCase().replace(/[^a-z0-9_-]/g, ''), s]));
  const byProject = {};
  const other = [];
  for (const c of containers) {
    const key = c.workdirKey && (bySlugLower.get(c.workdirKey.replace(/[^a-z0-9_-]/g, '')) || null);
    const key2 = !key && c.composeProject ? bySlugLower.get(c.composeProject) : null;
    const slug = key || key2;
    if (slug) (byProject[slug] ||= []).push(c);
    else other.push(c);
  }
  return { byProject, other };
}
