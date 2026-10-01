// Health collector: HTTP checks for links flagged check_health.
import { config } from '../config.js';
import { q } from '../db.js';

/** Inside the container "localhost" is the container itself; route to the Docker host instead. */
export function resolveTarget(url) {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) u.hostname = 'host.docker.internal';
    return u.toString();
  } catch {
    return url;
  }
}

const get = (target) =>
  fetch(target, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(config.healthTimeoutMs),
    headers: { 'user-agent': 'dev-desktop-healthcheck' },
  });

export async function checkUrl(url) {
  const started = Date.now();
  try {
    const target = resolveTarget(url);
    let res;
    try {
      res = await get(target);
    } catch (e) {
      // Not running under Docker (host.docker.internal doesn't resolve): use the URL as written.
      if (target !== url && e.cause?.code === 'ENOTFOUND') res = await get(url);
      else throw e;
    }
    res.body?.cancel().catch(() => {});
    const ok = (res.status >= 200 && res.status < 400) || res.status === 401 || res.status === 403;
    return { ok, status: res.status, latency: Date.now() - started };
  } catch (e) {
    return { ok: false, status: null, latency: null, error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message };
  }
}

export function record(linkId, r) {
  const ts = Date.now();
  q.run('INSERT INTO health_checks (link_id, ts, ok, status, latency_ms) VALUES (?,?,?,?,?)', linkId, ts, r.ok ? 1 : 0, r.status ?? null, r.latency ?? null);
  // keep the table small: newest 500 rows per link
  q.run('DELETE FROM health_checks WHERE link_id = ? AND ts < (SELECT MIN(ts) FROM (SELECT ts FROM health_checks WHERE link_id = ? ORDER BY ts DESC LIMIT 500))', linkId, linkId);
  return ts;
}

/** Summary for one link: latest result, 24h uptime, and a short latency sparkline. */
export function summarize(linkId) {
  const recent = q.all('SELECT ts, ok, status, latency_ms FROM health_checks WHERE link_id = ? ORDER BY ts DESC LIMIT 30', linkId);
  if (!recent.length) return null;
  const day = q.get('SELECT COUNT(*) n, SUM(ok) up FROM health_checks WHERE link_id = ? AND ts > ?', linkId, Date.now() - 86400000);
  const [last] = recent;
  return {
    ok: !!last.ok,
    status: last.status,
    latency: last.latency_ms,
    ts: last.ts,
    uptime24h: day.n ? Math.round(((day.up || 0) / day.n) * 1000) / 10 : null,
    spark: recent.reverse().map((r) => (r.ok ? r.latency_ms : -1)),
  };
}
