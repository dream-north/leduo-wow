$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

$distDir = Join-Path $PSScriptRoot 'dist'
$winUnpackedDir = Join-Path $distDir 'win-unpacked'
$generateWinIconScript = Join-Path $PSScriptRoot 'build\generate-win-icon.ps1'
$packageJsonPath = Join-Path $PSScriptRoot 'package.json'

function Test-NpmPackageInstalled {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $packagePath = Join-Path $PSScriptRoot 'node_modules'
  foreach ($segment in ($PackageName -split '/')) {
    $packagePath = Join-Path $packagePath $segment
  }

  return Test-Path $packagePath
}

$packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
$runtimeDependencies = @($packageJson.dependencies.PSObject.Properties.Name)
$missingRuntimeDependencies = @(
  $runtimeDependencies | Where-Object { -not (Test-NpmPackageInstalled -PackageName $_) }
)

if ($missingRuntimeDependencies.Count -gt 0) {
  Write-Host "[Leduo Wow] Missing runtime dependencies: $($missingRuntimeDependencies -join ', ')" -ForegroundColor Yellow
  Write-Host "[Leduo Wow] Running npm install before packaging..." -ForegroundColor Yellow
  npm install

  $missingRuntimeDependencies = @(
    $runtimeDependencies | Where-Object { -not (Test-NpmPackageInstalled -PackageName $_) }
  )

  if ($missingRuntimeDependencies.Count -gt 0) {
    throw "Missing runtime dependencies after npm install: $($missingRuntimeDependencies -join ', ')"
  }
}

if (Test-Path $winUnpackedDir) {
  Remove-Item -Path $winUnpackedDir -Recurse -Force
}

if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Filter 'leduo-wow-*-setup.exe' -ErrorAction SilentlyContinue |
    Remove-Item -Force

  Get-ChildItem -Path $distDir -Filter 'leduo-wow-*-setup.nsis.7z' -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

if (Test-Path $generateWinIconScript) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $generateWinIconScript
}

npm run build:native
npm run build
npm run pack:win
