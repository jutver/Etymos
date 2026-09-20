# Loads backend env vars into the process environment, then runs uvicorn.
# Usage (from anywhere):  .\backend\run_api.ps1   [-Port 8001]
#
# Env file: backend/.env if present, else the repo-root .env.backend (the same
# file docker-compose.yml uses), so local and Docker runs share one config.
#
# Docker publishes port 8000, so running both on 8000 makes the local server
# shadow the container on 127.0.0.1:8000. Stop Docker first (`docker compose
# down`) or pass a different -Port and point VITE_API_BASE_URL at it.
param(
    [int]$Port = 8000
)

$repoRoot = Split-Path $PSScriptRoot -Parent

$envFile = @(
    (Join-Path $PSScriptRoot ".env"),
    (Join-Path $repoRoot ".env.backend")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($envFile) {
    Write-Host "Loading env from $envFile"
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $key, $value = $line.Split("=", 2)
            Set-Item -Path "Env:$($key.Trim())" -Value $value.Trim().Trim('"').Trim("'")
        }
    }
} else {
    Write-Warning "No backend/.env or .env.backend found - running with whatever env vars are already set."
}

$python = @(
    (Join-Path $PSScriptRoot ".venv\Scripts\python.exe"),
    (Join-Path $repoRoot ".venv\Scripts\python.exe"),
    (Join-Path (Split-Path $repoRoot -Parent) ".venv\Scripts\python.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $python) {
    Write-Warning "No .venv found (backend/, repo root or its parent) - falling back to python on PATH."
    $python = "python"
}

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Error "Port $Port is already in use (Docker etymos-api or another uvicorn?). Free it or run with -Port <other>."
    exit 1
}

Push-Location $PSScriptRoot
try {
    & $python -m uvicorn api.app:app --reload --port $Port
} finally {
    Pop-Location
}
