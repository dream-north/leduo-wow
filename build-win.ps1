$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

$distDir = Join-Path $PSScriptRoot 'dist'
$winUnpackedDir = Join-Path $distDir 'win-unpacked'
$generateWinIconScript = Join-Path $PSScriptRoot 'build\generate-win-icon.ps1'

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
