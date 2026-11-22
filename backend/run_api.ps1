# Loads backend env vars into the process environment, then runs uvicorn.
# Usage (from anywhere):  .\backend\run_api.ps1   [-Port 8001]
#
# Env file: backend/.env if present, else the repo-root .env.backend.
# Pass a different -Port if 8000 is already in use and point VITE_API_BASE_URL at it.
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

# CPU thread and ONNX model cache defaults for hybrid OCR & formula extraction.
# Respects values already set in backend/.env or the parent shell.
$ocrDefaults = @{
    OMP_NUM_THREADS   = "4"
    MKL_NUM_THREADS   = "4"
    ORT_NUM_THREADS   = "4"
    OCR_MODEL_DIR     = (Join-Path $PSScriptRoot "models\ocr")
    OCR_AUTO_DOWNLOAD = "true"
}
foreach ($kv in $ocrDefaults.GetEnumerator()) {
    $existing = Get-Item -Path "Env:$($kv.Key)" -ErrorAction SilentlyContinue
    if (-not $existing -or [string]::IsNullOrWhiteSpace($existing.Value)) {
        Set-Item -Path "Env:$($kv.Key)" -Value $kv.Value
    }
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
    Write-Error "Port $Port is already in use (another uvicorn instance?). Free it or run with -Port <other>."
    exit 1
}

Push-Location $PSScriptRoot
try {
    & $python -m uvicorn api.app:app --reload --port $Port
} finally {
    Pop-Location
}
