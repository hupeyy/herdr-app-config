# A bouncing Poke Ball for space-panel's "working" mark, frames pokeball-b<n>.png beside
# pokeball.png: up and down on an arc, squashed on landing, stretched while fast, with a shadow
# that shrinks as the ball rises. Nearest-neighbour scaling keeps it pixel art.
param([Parameter(Mandatory)][string]$Dir)

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'pokeball.png'))
try {
    # The ball's own pixels: the sprite has a transparent margin.
    $minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            if ($src.GetPixel($x, $y).A -gt 0) {
                if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    $bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1
    $W = 30; $H = 40; $ground = 36

    # height above the ground (px), horizontal and vertical scale
    $frames = @(
        @(0, 1.30, 0.70), @(0, 1.12, 0.88), @(4, 0.90, 1.12), @(8, 0.95, 1.05), @(11, 1, 1), @(12, 1, 1),
        @(11, 1, 1), @(8, 0.95, 1.05), @(4, 0.90, 1.12), @(1, 0.92, 1.08), @(0, 1.18, 0.82)
    )
    $i = 0
    foreach ($f in $frames) {
        $lift = $f[0]; $sx = $f[1]; $sy = $f[2]
        $out = New-Object System.Drawing.Bitmap $W, $H
        $g = [System.Drawing.Graphics]::FromImage($out)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            # Shadow: wide and dark on the ground, small and faint at the top of the bounce.
            $k = 1 - ($lift / 16)
            $sw = [int][Math]::Round($bw * (0.55 + 0.45 * $k) * [Math]::Max(1, $sx)); $shh = 3
            $alpha = [int](40 + 60 * $k)
            $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 0, 0, 0))
            $g.FillEllipse($brush, [int](($W - $sw) / 2), $ground - 1, $sw, $shh)
            $brush.Dispose()
            # Ball: scaled about its bottom centre, lifted off the ground.
            $dw = [int][Math]::Round($bw * $sx); $dh = [int][Math]::Round($bh * $sy)
            $dx = [int](($W - $dw) / 2); $dy = $ground - $lift - $dh
            $g.DrawImage($src, (New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh),
                (New-Object System.Drawing.Rectangle $minX, $minY, $bw, $bh), [System.Drawing.GraphicsUnit]::Pixel)
        } finally { $g.Dispose() }
        $out.Save((Join-Path $Dir "pokeball-b$i.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
        $i++
    }
} finally { $src.Dispose() }
"$i"
