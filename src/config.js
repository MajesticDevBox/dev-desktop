// Central configuration, all overridable through environment variables.
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = {
  port: int(process.env.PORT, 7070),
  dataDir: process.env.DATA_DIR || './data',
  // Where repos are mounted inside the container.
  reposDir: process.env.REPOS_DIR || '/repos',
  // The same folder as seen by the host (used to build vscode:// and file links).
  hostReposPath: (process.env.HOST_REPOS_PATH || '').replace(/\\/g, '/').replace(/\/$/, ''),
  githubToken: process.env.GITHUB_TOKEN || '',
  githubUser: process.env.GITHUB_USER || '',
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  // A repo with a commit newer than this many days is auto-marked active on first discovery.
  activeWindowDays: int(process.env.ACTIVE_WINDOW_DAYS, 30),
  intervals: {
    rescanMs: int(process.env.RESCAN_SECONDS, 300) * 1000,
    gitMs: int(process.env.GIT_REFRESH_SECONDS, 60) * 1000,
    dockerMs: int(process.env.DOCKER_REFRESH_SECONDS, 5) * 1000,
    healthMs: int(process.env.HEALTH_REFRESH_SECONDS, 30) * 1000,
    githubMs: int(process.env.GITHUB_REFRESH_SECONDS, 300) * 1000,
  },
  gitConcurrency: int(process.env.GIT_CONCURRENCY, 3),
  gitTimeoutMs: int(process.env.GIT_TIMEOUT_SECONDS, 20) * 1000,
  healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_SECONDS, 5) * 1000,
};
