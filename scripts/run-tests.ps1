$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path $env:TEMP ("MOVING-test-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  foreach ($folder in @('analysis', 'lib', 'services')) {
    Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -Filter '*.ts' -File | Copy-Item -Destination $stage
  }
  Get-ChildItem -LiteralPath (Join-Path $projectRoot 'analysis\questions') -Filter '*.ts' -File | Copy-Item -Destination $stage
  Copy-Item -LiteralPath (Join-Path $projectRoot 'types\index.ts') -Destination $stage
  Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -Filter 'test-*.ts' -File | Copy-Item -Destination $stage

  Get-ChildItem -LiteralPath $stage -Filter '*.ts' -File | ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName -Raw
    $content = $content -replace "'@/types'", "'./index.ts'"
    $content = $content -replace "'@/analysis/questions/([a-zA-Z-]+)'", './$1.ts'
    $content = $content -replace "'@/analysis/([a-zA-Z-]+)'", './$1.ts'
    $content = $content -replace "'@/lib/([a-zA-Z-]+)'", './$1.ts'
    $content = $content -replace "'@/services/([a-zA-Z-]+)'", './$1.ts'
    $content = $content -replace "(?m)^import 'server-only';\s*\r?\n", ''
    Set-Content -LiteralPath $_.FullName -Value $content -NoNewline
  }

  $allPassed = $true
  foreach ($name in @('test-analysis', 'test-resolution', 'test-integration', 'test-questions', 'test-market-feeds', 'test-dexscreener')) {
    Write-Host "`n--- $name ---" -ForegroundColor Cyan
    & node --experimental-strip-types (Join-Path $stage "$name.ts")
    if ($LASTEXITCODE -ne 0) { $allPassed = $false }
  }

  if (-not $allPassed) {
    Write-Host "`nAda test yang gagal." -ForegroundColor Red
    exit 1
  }
  Write-Host "`nLULUS: semua suite test berhasil." -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
