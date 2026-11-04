# The Poke Ball on space-panel's cards: a red-and-white pixel ball drawn from the map below (no
# downloaded art), standing still (pokeball-still.png) and, while a dev workspace works
# (pokeball-c<n>.png): it rocks one way on its base, rocks the other way, then bounces once
# (squash and stretch, a shadow that shrinks with height), and repeats. Frames are 20x30 with the
# ground near the bottom; nearest-neighbour keeps the pixels.
param([Parameter(Mandatory)][string]$Dir)

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
$size = $map.Count
$ball = New-Object System.Drawing.Bitmap $size, $size
for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $c = $map[$y][$x]
        if ($c -ne '.') { $ball.SetPixel($x, $y, $colors[[string]$c]) }
    }
}

$W = 20; $H = 30; $ground = 28

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
        $sw = [int][Math]::Round($size * (0.55 + 0.45 * $k) * [Math]::Max(1, $sx))
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](40 + 60 * $k), 0, 0, 0))
        $g.FillEllipse($brush, [int](($W - $sw) / 2), $ground - 1, $sw, 3)
        $brush.Dispose()
        # Ball: scaled and tilted about its base (bottom centre), which sits at the lift height,
        # so a rock pivots on the ground like the capture wobble.
        # GDI+ takes singles: PowerShell's own numbers can pick an overload it rejects.
        $g.TranslateTransform([single]($W / 2), [single]($ground - $lift))
        $g.RotateTransform([single]$angle)
        $g.ScaleTransform([single]$sx, [single]$sy)
        $g.DrawImage($script:ball, [single](-$size / 2), [single](-$size), [single]$size, [single]$size)
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

$i = 0
foreach ($f in $frames) {
    Save-Frame $f[0] $f[1] $f[2] $f[3] (Join-Path $Dir "pokeball-c$i.png")
    $i++
}
Save-Frame 0 1 1 0 (Join-Path $Dir 'pokeball-still.png')
# space-panel redraws the frames when this marker's name changes (BALL_VERSION there).
Set-Content -Path (Join-Path $Dir 'pokeball-anim-3') -Value $i
$ball.Dispose()
"$i"
