// Git collector: shells out to the git CLI (read-only, no optional locks, never prompts).
import { execFile } from 'node:child_process';
import { config } from '../config.js';

function git(cwd, args, timeout = config.gitTimeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args],
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export function parseGithubRemote(url) {
  if (!url) return null;
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parseStatus(out) {
  const s = { branch: null, upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicted: 0, detached: false };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      s.branch = line.slice(14);
      if (s.branch === '(detached)') s.detached = true;
    } else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        s.ahead = +m[1];
        s.behind = +m[2];
      }
    } else if (line[0] === '1' || line[0] === '2') s.changed++;
    else if (line[0] === 'u') s.conflicted++;
    else if (line[0] === '?') s.untracked++;
  }
  return s;
}

export function parseLog(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, at, subject] = l.split('\x1f');
      return { hash: hash.slice(0, 7), author, at: Number(at) * 1000, subject };
    });
}

export async function collectGit(repoPath) {
  const info = { ts: Date.now(), error: null };
  try {
    const [status, log, remote] = await Promise.all([
      git(repoPath, ['status', '--porcelain=v2', '--branch']),
      git(repoPath, ['log', '-8', '--format=%H%x1f%an%x1f%at%x1f%s']).catch(() => ''),
      git(repoPath, ['remote', 'get-url', 'origin']).catch(() => ''),
    ]);
    Object.assign(info, parseStatus(status));
    info.commits = parseLog(log);
    info.lastCommitAt = info.commits[0]?.at ?? null;
    info.remote = remote.trim() || null;
    info.githubRepo = parseGithubRemote(info.remote);
    info.dirty = info.changed + info.untracked + info.conflicted > 0;
  } catch (e) {
    info.error = e.killed ? 'git timed out' : String(e.message || e).split('\n')[0];
  }
  return info;
}

export async function lastCommitTime(repoPath) {
  try {
    const out = await git(repoPath, ['log', '-1', '--format=%at'], 8000);
    const n = Number(out.trim());
    return n ? n * 1000 : null;
  } catch {
    return null;
  }
}
