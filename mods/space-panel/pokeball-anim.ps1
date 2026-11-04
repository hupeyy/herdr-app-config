# The Poke Ball on space-panel's cards, standing still (pokeball-v<V>-still.png) and, while a
# dev workspace works (pokeball-v<V>-c<n>.png): it rocks one way on its base, rocks the other way,
# then bounces once (squash and stretch, a shadow that shrinks with height), and repeats.
# The ball is -Sprite (PokeAPI's poke-ball item, drawn at a three-quarter angle), cropped to its
# own pixels; without one, the flat red-and-white pixel ball from the map below.
# Frames are 24x32 with the ground near the bottom; nearest-neighbour keeps the pixels.
# Files are named pokeball-v<Version>-...: herdr caches images by path, so a new look needs new
# names to show (space-panel's BALL_VERSION passes the version).
param([Parameter(Mandatory)][string]$Dir, [string]$Version = '3', [string]$Sprite = '')

Add-Type -AssemblyName System.Drawing

# K outline, R red, D dark red, H highlight, W white, L grey shade
$map = @(
    '.....KKKK.....',
    '...KKRRRRKK...',
    '..KRRRRRRRRK..',
    '.KRHHRRRRRRDK.',
    '.KRHRRRRRRRDK.',
    'KRRRRKKKKRRRDK',
    'KKKKKKWWKKKKKK',
    'KWWWWKWWKWWWLK',
    'KWWWWKKKKWWWLK',
    '.KWWWWWWWWWLK.',
    '.KWWWWWWWWLLK.',
    '..KWWWWWWLLK..',
    '...KKLLLLKK...',
    '.....KKKK.....'
)
$colors = @{
    'K' = [System.Drawing.Color]::FromArgb(255, 16, 16, 16)
    'R' = [System.Drawing.Color]::FromArgb(255, 232, 16, 26)
    'D' = [System.Drawing.Color]::FromArgb(255, 160, 0, 16)
    'H' = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    'W' = [System.Drawing.Color]::FromArgb(255, 244, 244, 244)
    'L' = [System.Drawing.Color]::FromArgb(255, 168, 168, 168)
}
if ($Sprite -and (Test-Path $Sprite)) {
    # The sprite has a transparent margin: keep only the ball's own pixels.
    $src = [System.Drawing.Bitmap]::FromFile($Sprite)
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
    $ball = $src.Clone((New-Object System.Drawing.Rectangle $minX, $minY, $bw, $bh), $src.PixelFormat)
    $src.Dispose()
} else {
    $bw = $bh = $map.Count
    $ball = New-Object System.Drawing.Bitmap $bw, $bh
    for ($y = 0; $y -lt $bh; $y++) {
        for ($x = 0; $x -lt $bw; $x++) {
            $c = $map[$y][$x]
            if ($c -ne '.') { $ball.SetPixel($x, $y, $colors[[string]$c]) }
        }
    }
}

# Wide enough that a 20-degree rock of the sprite's ball stays inside the frame.
$W = 24; $H = 32; $ground = 30

# lift (px above ground), x scale, y scale, tilt (degrees, about the ball's base)
$rock = { param($dir) @(
    @(0, 1, 1, (10 * $dir)), @(0, 1, 1, (20 * $dir)), @(0, 1, 1, (20 * $dir)), @(0, 1, 1, (10 * $dir)), @(0, 1, 1, 0)
) }
$bounce = @(
    @(0, 1.12, 0.88, 0), @(4, 0.90, 1.12, 0), @(8, 0.95, 1.05, 0), @(11, 1, 1, 0), @(12, 1, 1, 0),
    @(11, 1, 1, 0), @(8, 0.95, 1.05, 0), @(4, 0.90, 1.12, 0), @(0, 1.28, 0.72, 0), @(0, 1.10, 0.90, 0),
    @(0, 1, 1, 0), @(0, 1, 1, 0)
)
$frames = (& $rock -1) + (& $rock 1) + $bounce

function Save-Frame($lift, $sx, $sy, $angle, $path) {
    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        # Shadow: wide and dark on the ground, small and faint at the top of a hop.
        $k = 1 - ($lift / 16)
        $sw = [int][Math]::Round($bw * (0.55 + 0.45 * $k) * [Math]::Max(1, $sx))
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](40 + 60 * $k), 0, 0, 0))
        $g.FillEllipse($brush, [int](($W - $sw) / 2), $ground - 1, $sw, 3)
        $brush.Dispose()
        # Ball: scaled and tilted about its base (bottom centre), which sits at the lift height,
        # so a rock pivots on the ground like the capture wobble.
        # GDI+ takes singles: PowerShell's own numbers can pick an overload it rejects.
        $g.TranslateTransform([single]($W / 2), [single]($ground - $lift))
        $g.RotateTransform([single]$angle)
        $g.ScaleTransform([single]$sx, [single]$sy)
        $g.DrawImage($script:ball, [single](-$bw / 2), [single](-$bh), [single]$bw, [single]$bh)
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

$i = 0
foreach ($f in $frames) {
    Save-Frame $f[0] $f[1] $f[2] $f[3] (Join-Path $Dir "pokeball-v$Version-c$i.png")
    $i++
}
Save-Frame 0 1 1 0 (Join-Path $Dir "pokeball-v$Version-still.png")
# space-panel draws the frames again when this marker is missing.
Set-Content -Path (Join-Path $Dir "pokeball-v$Version-ready") -Value $i
$ball.Dispose()
"$i"
