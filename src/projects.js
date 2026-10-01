// Project data access + snapshot builder (merges persisted config with live state).
import fs from 'node:fs';
import { config } from './config.js';
import { q, tx } from './db.js';
import { live } from './live.js';
import { summarize } from './collectors/health.js';

const SAFE_URL = /^(https?:|vscode:|vscode-insiders:|obsidian:|mailto:|ssh:|git:)/i;

export function cleanUrl(url) {
  const u = String(url || '').trim();
  if (!SAFE_URL.test(u)) throw Object.assign(new Error('URL must start with http(s):// (or vscode://, ssh://, mailto:)'), { status: 400 });
  return u;
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const mapLink = (l) => ({
  id: l.id,
  label: l.label,
  url: l.url,
  kind: l.kind,
  checkHealth: !!l.check_health,
  health: l.check_health ? summarize(l.id) : null,
});

export function globalLinks() {
  return q.all('SELECT * FROM links WHERE project_id IS NULL ORDER BY sort, id').map(mapLink);
}

export function hostPathFor(row) {
  if (!row.path) return null;
  if (!config.hostReposPath) return null;
  const rel = row.path.slice(config.reposDir.length).replace(/^\/+/, '');
  return `${config.hostReposPath}/${rel}`;
}

export function buildProject(row) {
  const git = live.git.get(row.slug) || null;
  const meta = live.meta.get(row.slug) || { stack: [], scripts: {} };
  const githubRepo = row.github_repo || git?.githubRepo || null;
  const hostPath = hostPathFor(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    notes: row.notes,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    active: !!row.active,
    pinned: !!row.pinned,
    manual: !row.path,
    missing: !!row.path && !fs.existsSync(row.path),
    hostPath,
    vscodeUrl: hostPath ? `vscode://file/${encodeURI(hostPath)}` : null,
    githubRepo,
    stack: meta.stack,
    links: q.all('SELECT * FROM links WHERE project_id = ? ORDER BY sort, id', row.id).map(mapLink),
    commands: q.all('SELECT id, label, command FROM commands WHERE project_id = ? ORDER BY id', row.id),
    git,
    github: live.github.get(row.slug) || null,
    docker: live.docker.byProject[row.slug] || [],
  };
}

export const listProjects = () => q.all('SELECT * FROM projects ORDER BY pinned DESC, name COLLATE NOCASE').map(buildProject);

export function snapshot() {
  return {
    projects: listProjects(),
    globalLinks: globalLinks(),
    docker: { available: live.docker.available, error: live.docker.error, other: live.docker.other },
    meta: { githubToken: !!config.githubToken || Object.keys(config.githubTokens).length > 0, hostReposPath: config.hostReposPath, now: Date.now(), startedAt: live.startedAt },
  };
}

// ---------- mutations ----------
const slugify = (s) => str(s, 60).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function createManualProject(body) {
  const name = str(body.name, 80);
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  let slug = slugify(body.slug || name) || 'project';
  if (q.get('SELECT 1 FROM projects WHERE slug = ?', slug)) slug += `-${Date.now().toString(36).slice(-4)}`;
  const r = q.run('INSERT INTO projects (slug, name, description, active, github_repo) VALUES (?,?,?,1,?)', slug, name, str(body.description, 500), str(body.githubRepo, 100) || null);
  return Number(r.lastInsertRowid);
}

const PROJECT_FIELDS = {
  name: (v) => str(v, 80),
  description: (v) => str(v, 500),
  notes: (v) => str(v, 5000),
  tags: (v) => (Array.isArray(v) ? v : String(v).split(',')).map((t) => str(t, 30)).filter(Boolean).join(','),
  active: (v) => (v ? 1 : 0),
  pinned: (v) => (v ? 1 : 0),
  github_repo: (v) => {
    const s = str(v, 100);
    if (s && !/^[\w.-]+\/[\w.-]+$/.test(s)) throw Object.assign(new Error('GitHub repo must look like owner/name'), { status: 400 });
    return s || null;
  },
};

export function patchProject(id, body) {
  const sets = [];
  const vals = [];
  for (const [k, fn] of Object.entries(PROJECT_FIELDS)) {
    const key = k === 'github_repo' && 'githubRepo' in body ? 'githubRepo' : k;
    if (key in body) {
      sets.push(`${k} = ?`);
      vals.push(fn(body[key]));
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  const r = q.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  if (!r.changes) throw Object.assign(new Error('project not found'), { status: 404 });
}

export function deleteProject(id) {
  const p = q.get('SELECT path FROM projects WHERE id = ?', id);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  if (p.path) throw Object.assign(new Error('Discovered repos cannot be deleted (they would be re-discovered). Archive it instead.'), { status: 400 });
  q.run('DELETE FROM projects WHERE id = ?', id);
}

export function addLink(projectId, body) {
  const label = str(body.label, 60);
  if (!label) throw Object.assign(new Error('label is required'), { status: 400 });
  const url = cleanUrl(body.url);
  const kind = ['link', 'tool', 'env'].includes(body.kind) ? body.kind : 'link';
  const sort = (q.get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM links WHERE project_id IS ?', projectId ?? null)).n;
  const r = q.run('INSERT INTO links (project_id, label, url, kind, check_health, sort) VALUES (?,?,?,?,?,?)', projectId ?? null, label, url, kind, body.checkHealth ? 1 : 0, sort);
  return q.get('SELECT * FROM links WHERE id = ?', Number(r.lastInsertRowid));
}

export function patchLink(id, body) {
  const cur = q.get('SELECT * FROM links WHERE id = ?', id);
  if (!cur) throw Object.assign(new Error('link not found'), { status: 404 });
  const next = {
    label: 'label' in body ? str(body.label, 60) : cur.label,
    url: 'url' in body ? cleanUrl(body.url) : cur.url,
    kind: ['link', 'tool', 'env'].includes(body.kind) ? body.kind : cur.kind,
    check_health: 'checkHealth' in body ? (body.checkHealth ? 1 : 0) : cur.check_health,
  };
  if (!next.label) throw Object.assign(new Error('label is required'), { status: 400 });
  q.run('UPDATE links SET label=?, url=?, kind=?, check_health=? WHERE id=?', next.label, next.url, next.kind, next.check_health, id);
  return q.get('SELECT * FROM links WHERE id = ?', id);
}

export const deleteLink = (id) => q.run('DELETE FROM links WHERE id = ?', id);

export function addCommand(projectId, body) {
  const label = str(body.label, 60);
  const command = str(body.command, 500);
  if (!label || !command) throw Object.assign(new Error('label and command are required'), { status: 400 });
  q.run('INSERT INTO commands (project_id, label, command) VALUES (?,?,?)', projectId, label, command);
}

export const deleteCommand = (id) => q.run('DELETE FROM commands WHERE id = ?', id);

/** First-run defaults so the top bar isn't empty. Only ever seeds once. */
export function seedDefaults() {
  if (q.get("SELECT 1 FROM settings WHERE key = 'seeded'")) return;
  tx(() => {
    const defaults = [
      ['GitHub', 'https://github.com'],
      ['My Pull Requests', 'https://github.com/pulls'],
      ['My Issues', 'https://github.com/issues'],
      ['Docker Hub', 'https://hub.docker.com'],
      ['MDN', 'https://developer.mozilla.org'],
    ];
    defaults.forEach(([label, url], i) => q.run('INSERT INTO links (project_id, label, url, kind, sort) VALUES (NULL,?,?,?,?)', label, url, 'link', i));
    q.run("INSERT INTO settings (key, value) VALUES ('seeded', '1')");
  });
}
