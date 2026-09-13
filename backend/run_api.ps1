# Loads backend/.env into the process environment, then runs uvicorn.
# Usage (from backend/, venv activated):  .\run_api.ps1

$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $key, $value = $line.Split("=", 2)
            Set-Item -Path "Env:$($key.Trim())" -Value $value.Trim()
        }
    }
} else {
    Write-Warning "backend/.env not found - running with whatever env vars are already set."
}

& "F:\New folder\.venv\Scripts\python.exe" -m uvicorn api.app:app --reload
