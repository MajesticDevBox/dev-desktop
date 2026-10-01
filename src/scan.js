// Repo discovery: finds git repos directly under REPOS_DIR, detects their stack, seeds commands.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q, tx } from './db.js';
import { live, bus } from './live.js';
import { lastCommitTime } from './collectors/git.js';

const exists = (...p) => fs.existsSync(path.join(...p));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function detectStack(dir) {
  const stack = [];
  let scripts = {};
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    stack.push('node');
    scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, tag] of [['next', 'next.js'], ['react', 'react'], ['vue', 'vue'], ['astro', 'astro'], ['vite', 'vite'], ['express', 'express'], ['fastify', 'fastify'], ['discord.js', 'discord.js'], ['prisma', 'prisma'], ['typescript', 'typescript']]) {
      if (deps[dep]) stack.push(tag);
    }
  }
  if (exists(dir, 'Dockerfile')) stack.push('docker');
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((f) => exists(dir, f));
  if (compose) stack.push('compose');
  if (exists(dir, 'requirements.txt') || exists(dir, 'pyproject.toml')) stack.push('python');
  if (exists(dir, 'composer.json')) stack.push('php');
  if (exists(dir, 'go.mod')) stack.push('go');
  if (exists(dir, 'Cargo.toml')) stack.push('rust');
  if (exists(dir, 'fxmanifest.lua') || exists(dir, '__resource.lua')) stack.push('fivem');
  if (exists(dir, 'mod.cpp') || exists(dir, 'config.cpp')) stack.push('arma');
  return { stack: [...new Set(stack)], scripts, compose };
}

function seedCommands(projectId, { scripts, compose, stack }) {
  const add = (label, command) => q.run('INSERT INTO commands (project_id, label, command) VALUES (?,?,?)', projectId, label, command);
  if (stack.includes('node')) {
    add('Install', 'npm install');
    for (const s of ['dev', 'start', 'build', 'test', 'lint']) if (scripts[s]) add(s[0].toUpperCase() + s.slice(1), `npm run ${s}`);
  }
  if (compose) {
    add('Compose up', 'docker compose up -d');
    add('Compose logs', 'docker compose logs -f --tail 100');
  }
}

export async function scanRepos() {
  let entries = [];
  try {
    entries = fs.readdirSync(config.reposDir, { withFileTypes: true });
  } catch (e) {
    console.error(`[scan] cannot read ${config.reposDir}: ${e.message}`);
    return { added: 0, total: 0, error: e.message };
  }
  let added = 0;
  let total = 0;
  const cutoff = Date.now() - config.activeWindowDays * 86400000;

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const dir = path.join(config.reposDir, ent.name);
    if (!exists(dir, '.git')) continue;
    total++;

    const detected = detectStack(dir);
    live.meta.set(ent.name, { stack: detected.stack, scripts: detected.scripts });

    const existing = q.get('SELECT id, path FROM projects WHERE slug = ?', ent.name);
    if (existing) {
      if (existing.path !== dir) q.run('UPDATE projects SET path = ? WHERE id = ?', dir, existing.id);
      continue;
    }
    // New repo: auto-activate if it has a recent commit.
    const last = await lastCommitTime(dir);
    const active = last && last >= cutoff ? 1 : 0;
    tx(() => {
      const r = q.run('INSERT INTO projects (slug, name, path, active) VALUES (?,?,?,?)', ent.name, ent.name, dir, active);
      seedCommands(Number(r.lastInsertRowid), detected);
    });
    added++;
  }

  // Manual projects that point at a real folder still get stack detection.
  for (const p of q.all('SELECT slug, path FROM projects WHERE path IS NOT NULL')) {
    if (!live.meta.has(p.slug) && fs.existsSync(p.path)) {
      const d = detectStack(p.path);
      live.meta.set(p.slug, { stack: d.stack, scripts: d.scripts });
    }
  }

  if (added) bus.emit('event', { t: 'structure' });
  console.log(`[scan] ${total} repos found under ${config.reposDir}, ${added} new`);
  return { added, total };
}
