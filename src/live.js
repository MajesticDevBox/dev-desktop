// Live state (in-memory) + background pollers. Every change is announced on `bus` and pushed to browsers via SSE.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { config } from './config.js';
import { q } from './db.js';
import { collectGit } from './collectors/git.js';
import { dockerAvailable, listContainers, matchContainers } from './collectors/docker.js';
import { collectGithub, githubPaused } from './collectors/github.js';
import { checkUrl, record, summarize } from './collectors/health.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const live = {
  git: new Map(), // slug -> git info
  github: new Map(), // slug -> github info
  meta: new Map(), // slug -> { stack: [], scripts: {} } (from scanner)
  docker: { available: false, error: null, ts: 0, byProject: {}, other: [] },
  startedAt: Date.now(),
};

const emit = (evt) => bus.emit('event', evt);

// ---------- helpers ----------
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch (e) {
          console.error('[poll]', e.message);
        }
      }
    }),
  );
}

function every(name, ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, e.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, ms).unref?.() ?? undefined;
}

const projectRows = () => q.all('SELECT id, slug, path, active, github_repo FROM projects');

// ---------- git ----------
export async function refreshGit(row) {
  if (!row.path || !fs.existsSync(row.path)) return;
  const data = await collectGit(row.path);
  live.git.set(row.slug, data);
  emit({ t: 'git', slug: row.slug, data });
}

async function gitTick() {
  const now = Date.now();
  const due = projectRows().filter((r) => {
    if (!r.path) return false;
    const last = live.git.get(r.slug)?.ts ?? 0;
    return now - last >= (r.active ? config.intervals.gitMs : config.intervals.gitMs * 10) - 1000;
  });
  // active first
  due.sort((a, b) => b.active - a.active);
  await pool(due, config.gitConcurrency, refreshGit);
}

// ---------- docker ----------
async function dockerTick() {
  if (!dockerAvailable()) {
    if (live.docker.available) {
      live.docker = { available: false, error: 'Docker socket not mounted', ts: Date.now(), byProject: {}, other: [] };
      emit({ t: 'docker', data: live.docker });
    }
    live.docker.error ||= 'Docker socket not mounted';
    return;
  }
  try {
    const containers = await listContainers();
    const { byProject, other } = matchContainers(containers, projectRows().map((r) => r.slug));
    const next = { available: true, error: null, ts: Date.now(), byProject, other };
    const changed = JSON.stringify([next.byProject, next.other, next.available]) !== JSON.stringify([live.docker.byProject, live.docker.other, live.docker.available]);
    live.docker = next;
    if (changed) emit({ t: 'docker', data: next });
  } catch (e) {
    if (live.docker.error !== e.message) {
      live.docker = { ...live.docker, available: false, error: e.message, ts: Date.now() };
      emit({ t: 'docker', data: live.docker });
    }
  }
}

// ---------- health ----------
export async function runHealthCheck(link) {
  const r = await checkUrl(link.url);
  record(link.id, r);
  emit({ t: 'health', linkId: link.id, data: summarize(link.id) });
}

async function healthTick() {
  // active projects' links + global links
  const links = q.all(
    `SELECT l.id, l.url FROM links l LEFT JOIN projects p ON p.id = l.project_id
     WHERE l.check_health = 1 AND (l.project_id IS NULL OR p.active = 1)`,
  );
  await pool(links, 5, runHealthCheck);
}

// ---------- github ----------
export async function refreshGithub(slug, repo) {
  const data = await collectGithub(repo);
  live.github.set(slug, data);
  emit({ t: 'github', slug, data });
}

async function githubTick() {
  if (githubPaused()) return;
  const now = Date.now();
  for (const r of projectRows()) {
    if (!r.active) continue;
    const repo = r.github_repo || live.git.get(r.slug)?.githubRepo;
    if (!repo) continue;
    const last = live.github.get(r.slug)?.ts ?? 0;
    if (now - last < config.intervals.githubMs - 1000) continue;
    await refreshGithub(r.slug, repo);
    if (githubPaused()) break;
    await new Promise((res) => setTimeout(res, 500)); // be gentle
  }
}

// ---------- lifecycle ----------
export function startPollers() {
  every('git', 15000, gitTick); // ticks often, but each repo only refreshes when stale
  every('docker', config.intervals.dockerMs, dockerTick);
  every('health', config.intervals.healthMs, healthTick);
  every('github', 30000, githubTick);
}

/** Force-refresh everything for one project (used by the refresh button and after edits). */
export async function refreshProject(id) {
  const row = q.get('SELECT id, slug, path, active, github_repo FROM projects WHERE id = ?', id);
  if (!row) return;
  await refreshGit(row);
  const repo = row.github_repo || live.git.get(row.slug)?.githubRepo;
  if (repo) await refreshGithub(row.slug, repo);
  const links = q.all('SELECT id, url FROM links WHERE project_id = ? AND check_health = 1', id);
  await pool(links, 5, runHealthCheck);
  await dockerTick();
}
