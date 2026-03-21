$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$buildDir = $PSScriptRoot
$sourcePath = Join-Path $buildDir 'icon.png'
$croppedPngPath = Join-Path $buildDir 'icon-win.png'
$icoPath = Join-Path $buildDir 'icon.ico'

if (!(Test-Path $sourcePath)) {
  throw "Source icon not found: $sourcePath"
}

function New-HighQualityBitmap {
  param(
    [int]$Width,
    [int]$Height
  )

  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

  return [PSCustomObject]@{
    Bitmap = $bitmap
    Graphics = $graphics
  }
}

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  $canvas = New-HighQualityBitmap -Width 1024 -Height 1024
  try {
    $canvas.Graphics.Clear([System.Drawing.Color]::Transparent)

    # Windows small-size icons need a tighter crop than the full-body marketing artwork.
    $sourceRect = New-Object System.Drawing.Rectangle 120, 40, 780, 780
    $targetRect = New-Object System.Drawing.Rectangle 0, 0, 1024, 1024
    $canvas.Graphics.DrawImage($sourceImage, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    $canvas.Bitmap.Save($croppedPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Dispose()
  }

  $iconSource = [System.Drawing.Image]::FromFile($croppedPngPath)
  try {
    $entries = @()
    $sizes = @(16, 24, 32, 48, 64, 128, 256)

    foreach ($size in $sizes) {
      $frame = New-HighQualityBitmap -Width $size -Height $size
      try {
        $frame.Graphics.Clear([System.Drawing.Color]::Transparent)
        $frame.Graphics.DrawImage(
          $iconSource,
          (New-Object System.Drawing.Rectangle 0, 0, $size, $size),
          (New-Object System.Drawing.Rectangle 0, 0, $iconSource.Width, $iconSource.Height),
          [System.Drawing.GraphicsUnit]::Pixel
        )

        $stream = New-Object System.IO.MemoryStream
        try {
          $frame.Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
          $entries += [PSCustomObject]@{
            Size = $size
            Bytes = $stream.ToArray()
          }
        } finally {
          $stream.Dispose()
        }
      } finally {
        $frame.Graphics.Dispose()
        $frame.Bitmap.Dispose()
      }
    }

    $fileStream = [System.IO.File]::Create($icoPath)
    $writer = New-Object System.IO.BinaryWriter $fileStream
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$entries.Count)

      $offset = 6 + (16 * $entries.Count)

      foreach ($entry in $entries) {
        $dimension = if ($entry.Size -ge 256) { 0 } else { [byte]$entry.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$entry.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $entry.Bytes.Length
      }

      foreach ($entry in $entries) {
        $writer.Write($entry.Bytes)
      }
    } finally {
      $writer.Dispose()
      $fileStream.Dispose()
    }
  } finally {
    $iconSource.Dispose()
  }
} finally {
  $sourceImage.Dispose()
}

Write-Output "Generated Windows icon assets:"
Write-Output " - $croppedPngPath"
Write-Output " - $icoPath"
