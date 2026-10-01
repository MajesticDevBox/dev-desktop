# One-shot setup: creates .env if missing, builds and starts the container, waits until it is healthy.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker not found - start Docker Desktop first.' }
docker info *> $null; if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is not running - start Docker Desktop.' }
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host 'Created .env (edit REPOS_PATH / GITHUB_TOKEN if needed)' }
docker compose up -d --build
$port = (Select-String -Path .env -Pattern '^PORT=(\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1); if (-not $port) { $port = 7070 }
for ($i = 0; $i -lt 30; $i++) {
  try { if ((Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { Write-Host "Dev Desktop is up: http://localhost:$port"; Start-Process "http://localhost:$port"; exit 0 } } catch { Start-Sleep 1 }
}
docker compose logs --tail 40; throw 'Dev Desktop did not become healthy in 30s.'
