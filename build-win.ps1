$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

$distDir = Join-Path $PSScriptRoot 'dist'
$winUnpackedDir = Join-Path $distDir 'win-unpacked'

if (Test-Path $winUnpackedDir) {
  Remove-Item -Path $winUnpackedDir -Recurse -Force
}

if (Test-Path $distDir) {
  Get-ChildItem -Path $distDir -Filter 'leduo-wow-*-setup.exe' -ErrorAction SilentlyContinue |
    Remove-Item -Force

  Get-ChildItem -Path $distDir -Filter 'leduo-wow-*-setup.nsis.7z' -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

npm run build:native
npm run build
npm run pack:win
