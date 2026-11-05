# Splits an animated GIF into PNG frames (<Out>/f<n>.png) and writes <Out>/meta.json last:
# { w, h, delays: [ms per frame] }. herdr shows only a GIF's first frame reliably, so space-panel
# swaps these frames itself. GDI+ hands back each frame already composed.
param([Parameter(Mandatory)][string]$Gif, [Parameter(Mandatory)][string]$Out)

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$img = [System.Drawing.Image]::FromFile($Gif)
try {
    $dim = New-Object System.Drawing.Imaging.FrameDimension $img.FrameDimensionsList[0]
    $count = $img.GetFrameCount($dim)
    $raw = try { $img.GetPropertyItem(0x5100).Value } catch { $null }
    $delays = @()
    for ($i = 0; $i -lt $count; $i++) {
        $img.SelectActiveFrame($dim, $i) | Out-Null
        $frame = New-Object System.Drawing.Bitmap $img
        $frame.Save((Join-Path $Out "f$i.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $frame.Dispose()
        # Hundredths of a second; 0 or 1 means "as fast as possible", which browsers show at 100 ms.
        $cs = if ($raw) { [BitConverter]::ToInt32($raw, 4 * $i) } else { 10 }
        $delays += if ($cs -le 1) { 100 } else { $cs * 10 }
    }
    $meta = @{ w = $img.Width; h = $img.Height; delays = $delays } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $Out 'meta.json') -Value $meta -Encoding ascii
} finally { $img.Dispose() }
"$count"
