// Dev Desktop front-end. Vanilla ES modules, no build step.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SAFE = /^(https?:|vscode:|vscode-insiders:|obsidian:|mailto:|ssh:|git:)/i;
const href = (u) => (SAFE.test(u) ? esc(u) : '#');

let state = null;
const ui = { tab: 'active', sort: 'recent', q: '', drawerId: null, editLinks: false, logs: {} };
try {
  Object.assign(ui, JSON.parse(localStorage.getItem('devdesktop.ui') || '{}'), { q: '', drawerId: null, editLinks: false, logs: {} });
} catch {}
const saveUi = () => {
  try {
    localStorage.setItem('devdesktop.ui', JSON.stringify({ tab: ui.tab, sort: ui.sort }));
  } catch {}
};

// ---------- utils ----------
function rel(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const units = [[60, 'm', 60], [3600, 'h', 24], [86400, 'd', 30], [2592000, 'mo', 12], [31536000, 'y', 1e9]];
  let out = '1m';
  for (let i = 0; i < units.length; i++) {
    const [base, label] = units[i];
    if (s < (units[i + 1]?.[0] ?? Infinity)) {
      out = `${Math.floor(s / base)}${label}`;
      break;
    }
  }
  return `${out} ago`;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), bad ? 5000 : 2200);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

const cdCommand = (p) => {
  const path = p.hostPath || `./${p.slug}`;
  return `cd "${/^[a-z]:/i.test(path) ? path.replace(/\//g, '\\') : path}"`;
};

function spark(values) {
  if (!values?.length) return '';
  const ok = values.filter((v) => v >= 0);
  const max = Math.max(...ok, 1);
  const w = 3, gap = 1, h = 16;
  const bars = values
    .map((v, i) => {
      const x = i * (w + gap);
      if (v < 0) return `<rect x="${x}" y="0" width="${w}" height="${h}" fill="var(--bad)" rx="1"/>`;
      const bh = Math.max(2, Math.round((v / max) * h));
      return `<rect x="${x}" y="${h - bh}" width="${w}" height="${bh}" fill="var(--ok)" opacity=".75" rx="1"/>`;
    })
    .join('');
  return `<svg class="spark" width="${values.length * (w + gap)}" height="${h}" role="img" aria-label="recent response times">${bars}</svg>`;
}

// ---------- derived data ----------
const running = (p) => p.docker.filter((c) => c.state === 'running').length;
const healthDown = (p) => p.links.filter((l) => l.checkHealth && l.health && !l.health.ok).length;
const ciFailing = (p) => p.github?.ci?.conclusion === 'failure';
const attention = (p) => (healthDown(p) ? 4 : 0) + (ciFailing(p) ? 3 : 0) + (p.git?.behind ? 1 : 0) + (p.git?.ahead ? 1 : 0) + (p.git?.dirty ? 1 : 0) + (p.docker.some((c) => c.health === 'unhealthy') ? 4 : 0);

function visibleProjects() {
  const q = ui.q.trim().toLowerCase();
  let list = state.projects.filter((p) => (ui.tab === 'all' ? true : ui.tab === 'active' ? p.active : !p.active));
  if (q) list = list.filter((p) => [p.name, p.slug, p.description, p.tags.join(' '), p.stack.join(' '), p.githubRepo].join(' ').toLowerCase().includes(q));
  const sorters = {
    recent: (a, b) => (b.git?.lastCommitAt ?? 0) - (a.git?.lastCommitAt ?? 0),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    dirty: (a, b) => (b.git?.changed ?? 0) + (b.git?.untracked ?? 0) - ((a.git?.changed ?? 0) + (a.git?.untracked ?? 0)),
    attention: (a, b) => attention(b) - attention(a),
  };
  return list.sort((a, b) => b.pinned - a.pinned || sorters[ui.sort](a, b) || a.name.localeCompare(b.name));
}

// ---------- rendering: cards ----------
function healthLine(l) {
  const h = l.health;
  const dot = !h ? '<i class="dot"></i>' : `<i class="dot ${h.ok ? 'ok' : 'bad'}"></i>`;
  const meta = !h ? 'checking…' : h.ok ? `${h.latency ?? '?'} ms${h.uptime24h != null ? ` · ${h.uptime24h}%` : ''}` : `down${h.status ? ` (${h.status})` : ''}`;
  return `<div class="health-line" title="${esc(l.url)}">${dot}<a class="name" href="${href(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a><span class="muted">${meta}</span>${h ? spark(h.spark) : ''}</div>`;
}

function containerLine(c, full = false) {
  const cls = c.state === 'running' ? (c.health === 'unhealthy' ? 'bad' : 'ok') : c.state === 'exited' ? '' : 'warn';
  const ports = c.ports.map((p) => `<a class="badge mono" href="http://localhost:${p.public}" target="_blank" rel="noopener" title="Open localhost:${p.public}">:${p.public}</a>`).join('');
  const controls = full
    ? `<span class="row" style="margin-left:auto">
        ${c.state === 'running' ? `<button class="btn sm" data-action="container" data-id="${c.id}" data-act="restart">Restart</button><button class="btn sm" data-action="container" data-id="${c.id}" data-act="stop">Stop</button>` : `<button class="btn sm" data-action="container" data-id="${c.id}" data-act="start">Start</button>`}
        <button class="btn sm" data-action="logs" data-id="${c.id}">Logs</button></span>`
    : '';
  return `<div class="container"><i class="dot ${cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : ''}"></i><span class="cname">${esc(c.composeService || c.name)}</span><span class="muted">${esc(c.status)}</span>${ports}${controls}</div>${full && ui.logs[c.id] != null ? `<pre class="logs">${esc(ui.logs[c.id])}</pre>` : ''}`;
}

function githubBadges(p) {
  if (!p.githubRepo) return '';
  const g = p.github;
  const base = `https://github.com/${p.githubRepo}`;
  const bits = [`<a class="badge" href="${base}" target="_blank" rel="noopener" title="Open on GitHub">GitHub</a>`];
  if (g && !g.error) {
    bits.push(`<a class="badge ${g.openPRs ? 'info' : ''}" href="${base}/pulls" target="_blank" rel="noopener">${g.openPRs}${g.prsCapped ? '+' : ''} PR${g.openPRs === 1 ? '' : 's'}</a>`);
    bits.push(`<a class="badge" href="${base}/issues" target="_blank" rel="noopener">${g.openIssues} issue${g.openIssues === 1 ? '' : 's'}</a>`);
    if (g.ci) {
      const c = g.ci;
      const cls = c.status !== 'completed' ? 'warn' : c.conclusion === 'success' ? 'ok' : c.conclusion === 'failure' ? 'bad' : '';
      const txt = c.status !== 'completed' ? 'CI running' : `CI ${c.conclusion}`;
      bits.push(`<a class="badge ${cls}" href="${href(c.url)}" target="_blank" rel="noopener" title="${esc(c.name)} · ${rel(c.at)}">${txt}</a>`);
    }
  } else if (g?.error) bits.push(`<span class="badge warn" title="${esc(g.error)}">GitHub: ${esc(g.error.slice(0, 32))}</span>`);
  return bits.join('');
}

function gitRow(p) {
  const g = p.git;
  if (p.missing) return '<div class="err">Folder not found on disk</div>';
  if (!g) return p.manual ? '' : '<div class="muted">reading git…</div>';
  if (g.error) return `<div class="err">git: ${esc(g.error)}</div>`;
  const parts = [`<span class="badge mono" title="${g.upstream ? `tracking ${esc(g.upstream)}` : 'no upstream'}">⎇ ${esc(g.branch)}</span>`];
  if (g.dirty) parts.push(`<span class="badge warn" title="${g.changed} changed, ${g.untracked} untracked">● ${g.changed + g.untracked + g.conflicted} uncommitted</span>`);
  else parts.push('<span class="badge ok">clean</span>');
  if (g.ahead) parts.push(`<span class="badge info" title="commits to push">↑${g.ahead}</span>`);
  if (g.behind) parts.push(`<span class="badge warn" title="commits to pull">↓${g.behind}</span>`);
  if (g.conflicted) parts.push(`<span class="badge bad">${g.conflicted} conflicts</span>`);
  return `<div class="row">${parts.join('')}</div>`;
}

function cardHtml(p) {
  const c0 = p.git?.commits?.[0];
  const health = p.links.filter((l) => l.checkHealth);
  const plain = p.links.filter((l) => !l.checkHealth);
  const shown = plain.slice(0, 5);
  const links = shown.map((l) => `<a class="badge ${l.kind === 'tool' ? 'info' : ''}" href="${href(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('') + (plain.length > shown.length ? `<button class="badge" data-action="open" data-id="${p.id}">+${plain.length - shown.length} more</button>` : '');
  return `
  <article class="card ${p.active ? '' : 'inactive'}" data-id="${p.id}">
    <div class="card-head">
      <div style="min-width:0">
        <h3 class="card-title"><button data-action="open" data-id="${p.id}">${esc(p.name)}</button></h3>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      </div>
      <button class="star ${p.pinned ? 'on' : ''}" data-action="toggle-pin" data-id="${p.id}" title="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-label="Pin">${p.pinned ? '★' : '☆'}</button>
    </div>
    ${p.stack.length || p.tags.length ? `<div class="row">${p.tags.map((t) => `<span class="badge tag">#${esc(t)}</span>`).join('')}<span class="stack">${p.stack.map(esc).join(' · ')}</span></div>` : ''}
    ${gitRow(p)}
    ${c0 ? `<div class="commit"><code>${esc(c0.hash)}</code><span class="msg" title="${esc(c0.subject)}">${esc(c0.subject)}</span><span class="when">${rel(c0.at)}</span></div>` : ''}
    ${p.githubRepo ? `<div class="row">${githubBadges(p)}</div>` : ''}
    ${p.docker.length ? `<div>${p.docker.map((c) => containerLine(c)).join('')}</div>` : ''}
    ${health.length ? `<div>${health.map(healthLine).join('')}</div>` : ''}
    ${links ? `<div class="row">${links}</div>` : ''}
    <div class="card-actions">
      ${p.vscodeUrl ? `<a class="btn" href="${esc(p.vscodeUrl)}" title="Open in VS Code">VS Code</a>` : ''}
      ${p.manual ? '' : `<button class="btn" data-action="copy" data-text="${esc(cdCommand(p))}" title="Copy a cd command">Copy cd</button>`}
      <button class="btn" data-action="open" data-id="${p.id}">Details</button>
      <button class="btn" data-action="refresh" data-id="${p.id}" title="Refresh live data">↻</button>
      <button class="btn" style="margin-left:auto" data-action="toggle-active" data-id="${p.id}">${p.active ? 'Archive' : 'Activate'}</button>
    </div>
  </article>`;
}

function renderCard(p) {
  const el = $(`.card[data-id="${p.id}"]`);
  if (!el) return;
  const t = document.createElement('template');
  t.innerHTML = cardHtml(p).trim();
  el.replaceWith(t.content.firstChild);
}

// ---------- rendering: page ----------
function renderStats() {
  const act = state.projects.filter((p) => p.active);
  const dirty = act.filter((p) => p.git?.dirty).length;
  const unpushed = act.filter((p) => p.git?.ahead).length;
  const containers = state.projects.flatMap((p) => p.docker);
  const up = containers.filter((c) => c.state === 'running').length;
  const down = act.reduce((n, p) => n + healthDown(p), 0);
  const prs = act.reduce((n, p) => n + (p.github?.openPRs ?? 0), 0);
  const ci = act.filter(ciFailing).length;
  const tile = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('#stats').innerHTML =
    tile(act.length, 'active projects') +
    tile(dirty, 'with uncommitted changes', dirty ? 'warn' : 'ok') +
    tile(unpushed, 'with unpushed commits', unpushed ? 'warn' : '') +
    tile(state.docker.available ? `${up}<small style="font-size:14px;color:var(--muted)"> / ${containers.length}</small>` : '—', 'project containers running') +
    tile(down, 'health checks failing', down ? 'bad' : 'ok') +
    tile(prs, 'open pull requests') +
    tile(ci, 'CI failing', ci ? 'bad' : '');
}

function renderQuickLinks() {
  const links = state.globalLinks
    .map((l) => `<a class="chip-link" href="${href(l.url)}" target="_blank" rel="noopener">${l.health ? `<i class="dot ${l.health.ok ? 'ok' : 'bad'}"></i>` : ''}${esc(l.label)}<button class="x" data-action="del-qlink" data-id="${l.id}" aria-label="Remove ${esc(l.label)}" title="Remove">✕</button></a>`)
    .join('');
  $('#quicklinks').className = `quicklinks${ui.editLinks ? ' editing' : ''}`;
  $('#quicklinks').innerHTML = `<span class="ql-label">Quick links</span>${links}<button class="link-btn" data-action="add-qlink">+ add</button><button class="link-btn" data-action="edit-qlinks">${ui.editLinks ? 'done' : 'edit'}</button>`;
}

function renderPills() {
  const d = state.docker;
  const el = $('#docker-pill');
  el.querySelector('.dot').className = `dot ${d.available ? 'ok' : 'warn'}`;
  el.querySelector('span').textContent = d.available ? 'docker' : 'docker off';
  el.title = d.available ? 'Docker socket connected' : d.error || 'Docker not available';
}

function renderTabs() {
  const a = state.projects.filter((p) => p.active).length;
  $('#n-active').textContent = a;
  $('#n-other').textContent = state.projects.length - a;
  $('#n-all').textContent = state.projects.length;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#sort').value = ui.sort;
}

function renderOtherContainers() {
  const list = state.docker.other;
  $('#other-containers').hidden = !list.length;
  $('#n-other-containers').textContent = list.length ? `(${list.length})` : '';
  $('#other-containers-list').innerHTML = list.map((c) => containerLine(c, true)).join('');
}

function renderGrid() {
  const list = visibleProjects();
  $('#grid').innerHTML = list.map(cardHtml).join('');
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.textContent = state.projects.length ? 'No projects match this view.' : 'No projects yet. Mount your repos folder (see README) or add one with “+ Project”.';
  }
}

function renderAll() {
  if (!state) return;
  renderPills();
  renderTabs();
  renderQuickLinks();
  renderStats();
  renderGrid();
  renderOtherContainers();
  if (ui.drawerId) renderDrawer();
}

// ---------- drawer ----------
const findProject = (id) => state?.projects.find((p) => p.id === Number(id));

function liveSection(p) {
  const g = p.git;
  const gh = p.github;
  return `
  <h3>Git</h3>
  ${p.missing ? '<div class="err">Folder not found on disk.</div>' : ''}
  ${p.manual ? '<div class="muted">Manual project (no local folder).</div>' : gitRow(p) || ''}
  ${g?.commits?.length ? `<div class="list" style="margin-top:8px">${g.commits.map((c) => `<div class="commit"><code>${esc(c.hash)}</code><span class="msg" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="when">${esc(c.author)} · ${rel(c.at)}</span></div>`).join('')}</div>` : ''}
  ${p.githubRepo ? `<h3>GitHub · ${esc(p.githubRepo)}</h3><div class="row">${githubBadges(p)}</div>${gh?.prs?.length ? `<div class="list" style="margin-top:8px">${gh.prs.map((r) => `<a class="item" href="${href(r.url)}" target="_blank" rel="noopener"><span class="badge ${r.draft ? '' : 'info'}">#${r.number}${r.draft ? ' draft' : ''}</span><span class="grow">${esc(r.title)}</span><span class="muted">${esc(r.user)}</span></a>`).join('')}</div>` : ''}${!state.meta.githubToken ? '<p class="muted">Add a GitHub token in Settings for private repos and higher rate limits.</p>' : ''}` : ''}
  <h3>Containers</h3>
  ${p.docker.length ? p.docker.map((c) => containerLine(c, true)).join('') : `<div class="muted">${state.docker.available ? 'No containers matched this project. Containers started with docker compose from this folder show up automatically.' : 'Docker socket not connected.'}</div>`}`;
}

function drawerHtml(p) {
  const linkItem = (l) => `<div class="item"><span class="badge ${l.kind === 'tool' ? 'info' : ''}">${esc(l.kind)}</span><a class="grow" href="${href(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">${esc(l.label)} <span class="muted">${esc(l.url)}</span></a>${l.checkHealth ? `<span class="badge ${l.health ? (l.health.ok ? 'ok' : 'bad') : ''}">${l.health ? (l.health.ok ? `up ${l.health.latency ?? ''}ms` : 'down') : 'health'}</span>` : ''}<button class="btn sm danger" data-action="del-link" data-id="${l.id}" aria-label="Remove link">✕</button></div>`;
  return `
  <div class="row" style="justify-content:space-between">
    <h2>${esc(p.name)}</h2>
    <button class="btn" data-action="close-drawer">Close ✕</button>
  </div>
  <div class="row" style="margin:8px 0">
    ${p.vscodeUrl ? `<a class="btn" href="${esc(p.vscodeUrl)}">Open in VS Code</a>` : ''}
    ${p.manual ? '' : `<button class="btn" data-action="copy" data-text="${esc(cdCommand(p))}">Copy cd</button><button class="btn" data-action="copy" data-text="${esc(p.hostPath || p.slug)}">Copy path</button>`}
    <button class="btn" data-action="refresh" data-id="${p.id}">Refresh ↻</button>
    <button class="btn" data-action="toggle-active" data-id="${p.id}">${p.active ? 'Archive' : 'Mark active'}</button>
  </div>

  <h3>Details</h3>
  <div class="field"><label>Name</label><input type="text" data-field="name" value="${esc(p.name)}"></div>
  <div class="field"><label>Description</label><input type="text" data-field="description" value="${esc(p.description)}" placeholder="One line about what this is"></div>
  <div class="field"><label>Tags (comma separated)</label><input type="text" data-field="tags" value="${esc(p.tags.join(', '))}" placeholder="client, wip, fivem…"></div>
  <div class="field"><label>GitHub repo (owner/name) — auto-detected from origin${p.githubRepo && !p.manual ? `: ${esc(p.githubRepo)}` : ''}</label><input type="text" data-field="githubRepo" value="${esc(p.githubRepo || '')}" placeholder="owner/name"></div>
  <div class="field"><label>Notes</label><textarea data-field="notes" placeholder="Next steps, credentials location, gotchas…">${esc(p.notes)}</textarea></div>

  <div id="d-live">${liveSection(p)}</div>

  <h3>Links & tools</h3>
  <div class="list">${p.links.length ? p.links.map(linkItem).join('') : '<div class="muted">No links yet — add staging/prod URLs, dashboards, docs, boards.</div>'}</div>
  <form class="add-form" data-form="link">
    <input type="text" name="label" placeholder="Label (e.g. Staging)" required>
    <input type="url" name="url" placeholder="https://…" required>
    <button class="btn primary" type="submit">Add</button>
    <div class="opt">
      <label>Type <select name="kind"><option value="link">Link</option><option value="env">Environment</option><option value="tool">Tool</option></select></label>
      <label class="switch"><input type="checkbox" name="checkHealth"> Monitor uptime</label>
    </div>
  </form>

  <h3>Commands</h3>
  <div class="list">${p.commands.length ? p.commands.map((c) => `<div class="item"><span class="badge">${esc(c.label)}</span><code class="grow">${esc(c.command)}</code><button class="btn sm" data-action="copy" data-text="${esc(c.command)}">Copy</button><button class="btn sm" data-action="copy" data-text="${esc(`${cdCommand(p)} && ${c.command}`)}" title="Copy with cd">cd+</button><button class="btn sm danger" data-action="del-cmd" data-id="${c.id}" aria-label="Remove command">✕</button></div>`).join('') : '<div class="muted">No commands saved.</div>'}</div>
  <form class="add-form cmd" data-form="command">
    <input type="text" name="label" placeholder="Label" required>
    <input type="text" name="command" placeholder="npm run dev" required>
    <button class="btn primary" type="submit">Add</button>
  </form>

  ${p.manual ? `<h3>Danger zone</h3><button class="btn danger" data-action="delete-project" data-id="${p.id}">Delete project</button>` : ''}`;
}

function renderDrawer() {
  const p = findProject(ui.drawerId);
  const drawer = $('#drawer');
  if (!p) {
    drawer.hidden = true;
    ui.drawerId = null;
    return;
  }
  drawer.hidden = false;
  const focused = document.activeElement;
  if (drawer.contains(focused) && /INPUT|TEXTAREA|SELECT/.test(focused.tagName)) {
    $('#d-live').innerHTML = liveSection(p); // don't clobber what the user is typing
    return;
  }
  const scroller = $('.drawer-panel');
  const top = scroller.scrollTop;
  $('#drawer-content').innerHTML = drawerHtml(p);
  scroller.scrollTop = top;
}

function openDrawer(id) {
  ui.drawerId = Number(id);
  renderDrawer();
  $('.drawer-panel').scrollTop = 0;
}
function closeDrawer() {
  ui.drawerId = null;
  $('#drawer').hidden = true;
}

// ---------- dialogs ----------
function dialog(title, fields, onSubmit, submitLabel = 'Save') {
  const d = $('#dialog');
  d.className = '';
  d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${fields}<div class="dialog-actions"><button class="btn" type="button" data-action="dialog-cancel">Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div></form>`;
  d.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await onSubmit(fd);
      d.close();
    } catch {}
  };
  d.showModal();
  d.querySelector('input')?.focus();
}

// ---------- settings: GitHub access ----------
const SRC = { saved: 'saved here', env: 'from .env', 'saved-default': 'saved default', 'env-default': '.env default' };
const ownerLabel = (o) => (o === '*' ? 'Default (any other owner)' : o);

async function openSettings() {
  const d = $('#dialog');
  d.className = 'wide';
  const gh = await api('GET', '/api/settings/github');
  const owners = gh.owners
    .map(
      (o) => `<div class="set-row"><b>${esc(o.owner)}</b><span class="muted grow">${o.repos} repo${o.repos === 1 ? '' : 's'}</span>
        <span class="badge ${o.tokenFrom ? 'info' : 'warn'}">${o.tokenFrom ? esc(SRC[o.tokenFrom]) : 'no token'}</span>
        <button class="btn" type="button" data-action="set-fill" data-owner="${esc(o.owner)}">${o.tokenFrom ? 'Replace' : 'Add token'}</button></div>`,
    )
    .join('');
  const creds = gh.credentials
    .map(
      (c) => `<div class="set-row"><b>${esc(ownerLabel(c.owner))}</b><code class="muted grow">${esc(c.hint)}</code>
        <span class="badge ${c.overridden ? 'warn' : ''}" title="${c.overridden ? 'A token saved here takes priority over this one' : ''}">${c.source === 'saved' ? 'saved here' : c.overridden ? '.env (overridden)' : 'from .env'}</span>
        <button class="btn" type="button" data-action="set-test" data-owner="${esc(c.owner)}">Test</button>
        ${c.source === 'saved' ? `<button class="btn" type="button" data-action="set-remove" data-owner="${esc(c.owner)}">Remove</button>` : ''}</div>`,
    )
    .join('');
  d.innerHTML = `<h2>Settings · GitHub access</h2>
    <p class="muted">Add one token per GitHub org or user. Each repo uses the token matching its owner; the <b>*</b> default covers everything else. Tokens are stored in this app's data volume and are never sent back to the browser.</p>
    <h3>Owners in your projects</h3>${owners || '<p class="muted">No GitHub repos detected yet.</p>'}
    <h3>Configured tokens</h3>${creds || '<p class="muted">None yet.</p>'}
    <h3>Add or replace a token</h3>
    <form id="set-form" autocomplete="off">
      <div class="set-add">
        <input type="text" name="owner" list="set-owners" placeholder="org or user  (or * for default)" required spellcheck="false">
        <input type="password" name="token" placeholder="ghp_… or github_pat_…" required spellcheck="false" autocomplete="new-password">
      </div>
      <datalist id="set-owners">${gh.owners.map((o) => `<option value="${esc(o.owner)}">`).join('')}<option value="*"></datalist>
      <p class="muted set-note">Needs read access to repository contents/metadata, pull requests, issues and Actions. Fine-grained tokens are limited to one owner, so add one per org.</p>
      <p id="set-result" class="set-note set-result" role="status"></p>
      <div class="dialog-actions"><button class="btn" type="button" data-action="dialog-cancel">Close</button><button class="btn primary">Test &amp; save</button></div>
    </form>`;
  d.querySelector('#set-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const owner = fd.owner.trim().toLowerCase();
    const out = $('#set-result');
    out.className = 'set-note set-result';
    out.textContent = 'Testing…';
    let t;
    try {
      t = await api('POST', '/api/settings/github/test', { owner, token: fd.token });
    } catch {
      out.textContent = '';
      return;
    }
    if (!t.ok) {
      out.className = 'set-note set-result bad';
      out.textContent = t.error;
      return;
    }
    await api('PUT', `/api/settings/github/${encodeURIComponent(owner)}`, { token: fd.token });
    toast(t.warning ? `Saved for ${owner} (see warning)` : `Saved token for ${owner}`);
    await openSettings();
    if (t.warning) {
      const r = $('#set-result');
      r.className = 'set-note set-result bad';
      r.textContent = t.warning;
    }
  };
  if (!d.open) d.showModal();
}

async function testStored(owner) {
  const out = $('#set-result');
  out.className = 'set-note set-result';
  out.textContent = `Testing ${owner}…`;
  const t = await api('POST', '/api/settings/github/test', { owner });
  out.className = `set-note set-result ${t.ok && !t.warning ? 'ok' : 'bad'}`;
  out.textContent = !t.ok ? t.error : t.warning || `OK — authenticated as ${t.login}${t.repo ? `, can read ${t.repo}` : ''}`;
}

// ---------- data loading / live updates ----------
async function load() {
  state = await (await fetch('/api/state')).json();
  renderAll();
}

function connect() {
  const pill = $('#live-pill');
  const set = (cls, txt) => {
    pill.querySelector('.dot').className = `dot ${cls}`;
    pill.querySelector('span').textContent = txt;
  };
  const es = new EventSource('/api/events');
  es.onopen = () => {
    set('ok', 'live');
    load().catch(() => {});
  };
  es.onerror = () => set('bad', 'reconnecting…');
  es.onmessage = (m) => {
    if (!state) return;
    const e = JSON.parse(m.data);
    const bySlug = (slug) => state.projects.find((p) => p.slug === slug);
    switch (e.t) {
      case 'structure':
        clearTimeout(connect.t);
        connect.t = setTimeout(() => load().catch(() => {}), 150);
        break;
      case 'git': {
        const p = bySlug(e.slug);
        if (!p) return;
        p.git = e.data;
        if (!p.githubRepo && e.data.githubRepo) p.githubRepo = e.data.githubRepo;
        renderCard(p);
        renderStats();
        if (ui.drawerId === p.id) renderDrawer();
        break;
      }
      case 'github': {
        const p = bySlug(e.slug);
        if (!p) return;
        p.github = e.data;
        renderCard(p);
        renderStats();
        if (ui.drawerId === p.id) renderDrawer();
        break;
      }
      case 'health': {
        for (const p of state.projects) {
          const l = p.links.find((x) => x.id === e.linkId);
          if (l) {
            l.health = e.data;
            renderCard(p);
            renderStats();
            if (ui.drawerId === p.id) renderDrawer();
            return;
          }
        }
        const gl = state.globalLinks.find((x) => x.id === e.linkId);
        if (gl) {
          gl.health = e.data;
          renderQuickLinks();
        }
        break;
      }
      case 'docker': {
        state.docker = { available: e.data.available, error: e.data.error, other: e.data.other };
        for (const p of state.projects) p.docker = e.data.byProject[p.slug] || [];
        renderPills();
        renderStats();
        renderGrid();
        renderOtherContainers();
        if (ui.drawerId) renderDrawer();
        break;
      }
    }
  };
}

// ---------- actions ----------
const actions = {
  async 'refresh-all'(btn) {
    btn.classList.add('spin');
    await api('POST', '/api/refresh', {}).finally(() => setTimeout(() => btn.classList.remove('spin'), 800));
    toast('Refreshing…');
  },
  async rescan(btn) {
    btn.classList.add('spin');
    try {
      const r = await api('POST', '/api/rescan');
      toast(`Found ${r.total} repos${r.added ? `, ${r.added} new` : ''}`);
    } finally {
      btn.classList.remove('spin');
    }
  },
  'add-project'() {
    dialog(
      'Add project',
      `<div class="field"><label>Name</label><input type="text" name="name" required></div>
       <div class="field"><label>Description</label><input type="text" name="description"></div>
       <div class="field"><label>GitHub repo (optional)</label><input type="text" name="githubRepo" placeholder="owner/name"></div>
       <p class="muted">Repos found in your mounted folder are added automatically; use this for anything else.</p>`,
      async (fd) => {
        const { id } = await api('POST', '/api/projects', fd);
        await load();
        openDrawer(id);
      },
      'Add',
    );
  },
  'add-qlink'() {
    dialog(
      'Add quick link',
      `<div class="field"><label>Label</label><input type="text" name="label" required></div>
       <div class="field"><label>URL</label><input type="url" name="url" placeholder="https://…" required></div>
       <label class="switch"><input type="checkbox" name="checkHealth"> Monitor uptime</label>`,
      (fd) => api('POST', '/api/links', { ...fd, checkHealth: !!fd.checkHealth }),
      'Add',
    );
  },
  'edit-qlinks'() {
    ui.editLinks = !ui.editLinks;
    renderQuickLinks();
  },
  async 'del-qlink'(_b, e) {
    e.preventDefault();
    await api('DELETE', `/api/links/${_b.dataset.id}`);
  },
  settings: () => openSettings(),
  'set-fill'(b) {
    const f = $('#set-form');
    f.owner.value = b.dataset.owner;
    f.token.focus();
  },
  'set-test': (b) => testStored(b.dataset.owner),
  async 'set-remove'(b) {
    if (!confirm(`Remove the saved token for ${b.dataset.owner}?`)) return;
    await api('DELETE', `/api/settings/github/${encodeURIComponent(b.dataset.owner)}`);
    await openSettings();
  },
  'dialog-cancel'() {
    $('#dialog').close();
  },
  open: (b) => openDrawer(b.dataset.id),
  'close-drawer': closeDrawer,
  async 'toggle-active'(b) {
    const p = findProject(b.dataset.id);
    await api('PATCH', `/api/projects/${p.id}`, { active: !p.active });
    toast(p.active ? `${p.name} archived` : `${p.name} is now active`);
  },
  async 'toggle-pin'(b) {
    const p = findProject(b.dataset.id);
    await api('PATCH', `/api/projects/${p.id}`, { pinned: !p.pinned });
  },
  copy: (b) => copy(b.dataset.text),
  async refresh(b) {
    b.classList.add('spin');
    await api('POST', '/api/refresh', { id: Number(b.dataset.id) }).finally(() => b.classList.remove('spin'));
  },
  async 'del-link'(b) {
    await api('DELETE', `/api/links/${b.dataset.id}`);
  },
  async 'del-cmd'(b) {
    await api('DELETE', `/api/commands/${b.dataset.id}`);
  },
  async 'delete-project'(b) {
    if (!confirm('Delete this project and its links?')) return;
    await api('DELETE', `/api/projects/${b.dataset.id}`);
    closeDrawer();
  },
  async container(b) {
    b.disabled = true;
    try {
      await api('POST', `/api/docker/${b.dataset.id}/${b.dataset.act}`);
      toast(`Container ${b.dataset.act}${b.dataset.act === 'stop' ? 'ped' : 'ed'}`);
    } finally {
      b.disabled = false;
    }
  },
  async logs(b) {
    const id = b.dataset.id;
    if (ui.logs[id] != null) {
      delete ui.logs[id];
    } else {
      ui.logs[id] = 'loading…';
      renderDrawerOrOther();
      ui.logs[id] = (await api('GET', `/api/docker/${id}/logs?tail=200`)).logs || '(no output)';
    }
    renderDrawerOrOther();
  },
};

function renderDrawerOrOther() {
  if (ui.drawerId) $('#d-live').innerHTML = liveSection(findProject(ui.drawerId));
  renderOtherContainers();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !ui.drawerId) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  if (form.dataset.form === 'link') await api('POST', `/api/projects/${ui.drawerId}/links`, { ...fd, checkHealth: !!fd.checkHealth });
  else await api('POST', `/api/projects/${ui.drawerId}/commands`, fd);
  form.reset();
});

document.addEventListener('change', (e) => {
  const f = e.target.dataset?.field;
  if (f && ui.drawerId) api('PATCH', `/api/projects/${ui.drawerId}`, { [f]: e.target.value }).then(() => toast('Saved'));
});

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')?.dataset.tab;
  if (!t) return;
  ui.tab = t;
  saveUi();
  renderTabs();
  renderGrid();
});
$('#sort').addEventListener('change', (e) => {
  ui.sort = e.target.value;
  saveUi();
  renderGrid();
});
$('#search').addEventListener('input', (e) => {
  ui.q = e.target.value;
  renderGrid();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('#search').focus();
  } else if (e.key === 'Escape') {
    if ($('#dialog').open) return;
    if (document.activeElement === $('#search')) $('#search').blur();
    else closeDrawer();
  }
});

// keep "5m ago" fresh
setInterval(() => {
  if (state && !document.hidden && !$('#dialog').open) renderGrid();
}, 30000);

connect();
load().catch((e) => toast(`Cannot load: ${e.message}`, true));
