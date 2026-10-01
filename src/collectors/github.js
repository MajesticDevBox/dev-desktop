// GitHub collector: open PRs, open issues and latest CI run per repo.
// Works unauthenticated for public repos (60 req/h) but a token is strongly recommended.
import { config } from '../config.js';

let pausedUntil = 0;
export const githubPaused = () => (pausedUntil > Date.now() ? pausedUntil : 0);

// Per-owner token (GITHUB_TOKENS) with GITHUB_TOKEN as the fallback.
const tokenFor = (repo) => config.githubTokens[repo.split('/')[0].toLowerCase()] || config.githubToken;

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dev-desktop',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  if (res.status === 403 || res.status === 429) {
    if (remaining === 0) {
      pausedUntil = Number(res.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 15 * 60 * 1000;
      throw Object.assign(new Error('GitHub rate limit reached'), { rateLimited: true });
    }
  }
  if (!res.ok) throw Object.assign(new Error(res.status === 404 ? 'repo not found (private? add a token)' : `GitHub ${res.status}`), { status: res.status });
  return res.json();
}

export async function collectGithub(repo) {
  const out = { ts: Date.now(), repo, error: null };
  const token = tokenFor(repo);
  try {
    const [info, pulls, runs] = await Promise.all([
      gh(`/repos/${repo}`, token),
      gh(`/repos/${repo}/pulls?state=open&per_page=10`, token),
      gh(`/repos/${repo}/actions/runs?per_page=1`, token).catch(() => null),
    ]);
    out.private = info.private;
    out.defaultBranch = info.default_branch;
    out.stars = info.stargazers_count;
    out.pushedAt = info.pushed_at ? Date.parse(info.pushed_at) : null;
    out.openPRs = pulls.length; // capped at 10 by the page size (shown as "10+")
    out.prsCapped = pulls.length >= 10;
    out.prs = pulls.slice(0, 5).map((p) => ({ number: p.number, title: p.title, url: p.html_url, user: p.user?.login, draft: p.draft }));
    // open_issues_count includes PRs
    out.openIssues = Math.max(0, info.open_issues_count - pulls.length);
    const run = runs?.workflow_runs?.[0];
    out.ci = run
      ? { name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, at: Date.parse(run.updated_at), branch: run.head_branch }
      : null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
