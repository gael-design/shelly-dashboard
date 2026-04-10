Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 64, 128, 256)
$pngs = @()

foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [double]$size
  $pts = @(
    (New-Object System.Drawing.PointF(($s * 0.58), ($s * 0.04))),
    (New-Object System.Drawing.PointF(($s * 0.18), ($s * 0.58))),
    (New-Object System.Drawing.PointF(($s * 0.44), ($s * 0.58))),
    (New-Object System.Drawing.PointF(($s * 0.30), ($s * 0.96))),
    (New-Object System.Drawing.PointF(($s * 0.82), ($s * 0.42))),
    (New-Object System.Drawing.PointF(($s * 0.52), ($s * 0.42))),
    (New-Object System.Drawing.PointF(($s * 0.68), ($s * 0.04)))
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddPolygon($pts)

  # Outer glow (cyan halo) for larger icons
  if ($size -ge 48) {
    $layers = [int]($size / 16)
    for ($i = $layers; $i -gt 0; $i--) {
      $alpha = [int](70 - ($layers - $i) * 10)
      if ($alpha -lt 6) { $alpha = 6 }
      $glowW = [double]($i * 2.2)
      $glowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($alpha, 0, 255, 200), $glowW)
      $glowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawPath($glowPen, $path)
      $glowPen.Dispose()
    }
  }

  # Gradient fill: cyan core -> lighter top
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 150, 255, 235),
    [System.Drawing.Color]::FromArgb(255, 0, 230, 180),
    90.0
  )
  $g.FillPath($grad, $path)
  $grad.Dispose()

  # White outline
  $strokeW = [Math]::Max(1.0, $s / 64)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 255, 255), $strokeW)
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $path)
  $pen.Dispose()

  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,@{ size = $size; data = $ms.ToArray() }
  $ms.Dispose()
  $bmp.Dispose()
}

# Build ICO container with multiple embedded PNGs
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)

# ICONDIR (6 bytes)
$bw.Write([uint16]0)                 # reserved
$bw.Write([uint16]1)                 # type = ICO
$bw.Write([uint16]$pngs.Count)       # count

# ICONDIRENTRYs (16 bytes each)
$offset = 6 + ($pngs.Count * 16)
foreach ($p in $pngs) {
  $dispW = if ($p.size -ge 256) { [byte]0 } else { [byte]$p.size }
  $bw.Write($dispW)                  # width
  $bw.Write($dispW)                  # height
  $bw.Write([byte]0)                 # colors
  $bw.Write([byte]0)                 # reserved
  $bw.Write([uint16]1)               # planes
  $bw.Write([uint16]32)              # bits per pixel
  $bw.Write([uint32]$p.data.Length)  # image size
  $bw.Write([uint32]$offset)         # offset
  $offset += $p.data.Length
}

# Image data
foreach ($p in $pngs) { $bw.Write($p.data) }

$bw.Flush()
$icoBytes = $ico.ToArray()
$bw.Dispose()
$ico.Dispose()

$outDir = Split-Path -Parent $PSCommandPath
$outPath = Join-Path $outDir "icon.ico"
[System.IO.File]::WriteAllBytes($outPath, $icoBytes)
Write-Host "Icon written: $outPath ($($icoBytes.Length) bytes, $($pngs.Count) sizes)"
