// GitHub credentials: tokens saved from the Settings page (SQLite) plus the env vars.
// Lookup order for a repo "owner/name": saved[owner] > env GITHUB_TOKENS[owner] > saved['*'] > env GITHUB_TOKEN.
// Full tokens never leave the server; the API only exposes a masked hint.
import { config } from './config.js';
import { q } from './db.js';

const KEY = 'github_tokens';
export const DEFAULT_OWNER = '*';

export function cleanOwner(owner) {
  const o = String(owner ?? '').trim().toLowerCase();
  if (o === DEFAULT_OWNER || /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(o)) return o;
  throw Object.assign(new Error('Owner must be a GitHub user or org name (letters, digits, hyphens), or * for the default'), { status: 400 });
}

export function cleanToken(token) {
  const t = String(token ?? '').trim();
  if (!/^[A-Za-z0-9_\-.]{20,255}$/.test(t)) throw Object.assign(new Error('That does not look like a GitHub token'), { status: 400 });
  return t;
}

function saved() {
  try {
    const row = q.get('SELECT value FROM settings WHERE key = ?', KEY);
    const obj = row ? JSON.parse(row.value) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
const persist = (obj) => q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(obj));

export const mask = (t) => `${t.slice(0, 4)}…${t.slice(-4)}`;

/** Resolve the token for a repo (or "owner"), reporting where it came from. */
export function resolveToken(repoOrOwner) {
  const owner = String(repoOrOwner).split('/')[0].toLowerCase();
  const s = saved();
  if (s[owner]) return { token: s[owner], source: 'saved' };
  if (config.githubTokens[owner]) return { token: config.githubTokens[owner], source: 'env' };
  if (s[DEFAULT_OWNER]) return { token: s[DEFAULT_OWNER], source: 'saved-default' };
  if (config.githubToken) return { token: config.githubToken, source: 'env-default' };
  return { token: '', source: null };
}

export const tokenFor = (repo) => resolveToken(repo).token;
export const anyToken = () => !!config.githubToken || Object.keys(config.githubTokens).length > 0 || Object.keys(saved()).length > 0;

export function saveToken(owner, token) {
  const s = saved();
  s[cleanOwner(owner)] = cleanToken(token);
  persist(s);
}

export function removeToken(owner) {
  const s = saved();
  delete s[cleanOwner(owner)];
  persist(s);
}

/** Masked list of every configured credential. */
export function listCredentials() {
  const s = saved();
  const out = Object.entries(s).map(([owner, t]) => ({ owner, source: 'saved', hint: mask(t) }));
  for (const [owner, t] of Object.entries(config.githubTokens)) out.push({ owner, source: 'env', hint: mask(t), overridden: owner in s });
  if (config.githubToken) out.push({ owner: DEFAULT_OWNER, source: 'env', hint: mask(config.githubToken), overridden: DEFAULT_OWNER in s });
  return out;
}

/** Check a token against GitHub; with `repo`, also confirm it can actually see that repository. */
export async function testToken(token, repo) {
  const call = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dev-desktop', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  const me = await call('/user');
  if (me.status === 401) return { ok: false, error: 'GitHub rejected this token (invalid or expired)' };
  if (!me.ok) return { ok: false, error: `GitHub answered ${me.status}` };
  const out = { ok: true, login: (await me.json()).login, rateRemaining: Number(me.headers.get('x-ratelimit-remaining')) };
  if (repo) {
    const r = await call(`/repos/${repo}`);
    out.repo = repo;
    out.repoAccess = r.ok;
    if (!r.ok) out.warning = `Token is valid but cannot see ${repo} (${r.status}). Check it covers this org and has repository read access.`;
  }
  return out;
}
