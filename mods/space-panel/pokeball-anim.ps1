# The Poke Ball on space-panel's cards: a red-and-white pixel ball drawn from the map below (no
# downloaded art), standing still (pokeball-still.png) and, while a dev workspace works, hopping
# and rocking (pokeball-c<n>.png): a hop tilting left, a squashed landing, a hop tilting right,
# a landing that rocks it left and right, then a rest. Squash and stretch, a shadow that shrinks
# with height. Frames are 20x30 with the ground near the bottom; nearest-neighbour keeps pixels.
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

# lift (px above ground), x scale, y scale, tilt (degrees)
$hop = { param($dir) @(
    @(0, 1.10, 0.90, 0), @(4, 0.90, 1.12, (6 * $dir)), @(8, 0.95, 1.05, (12 * $dir)), @(11, 1, 1, (18 * $dir)),
    @(12, 1, 1, (20 * $dir)), @(11, 1, 1, (16 * $dir)), @(8, 0.95, 1.05, (10 * $dir)), @(4, 0.90, 1.12, (5 * $dir))
) }
# The leading comma keeps a single frame one item: @(@(...)) would flatten it into four numbers.
$squash = , @(0, 1.28, 0.72, 0)
$frames = $squash + (& $hop -1) + $squash + (& $hop 1) + @(
    @(0, 1.22, 0.78, 0), @(0, 1.05, 0.95, -14), @(0, 1, 1, 14), @(0, 1, 1, -8), @(0, 1, 1, 4),
    @(0, 1, 1, 0), @(0, 1, 1, 0), @(0, 1, 1, 0)
)

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
        # Ball: scaled and tilted about its own centre, its bottom at the lift height.
        $dh = $size * $sy
        $cy = $ground - $lift - $dh / 2
        # GDI+ takes singles: PowerShell's own numbers can pick an overload it rejects.
        $g.TranslateTransform([single]($W / 2), [single]$cy)
        $g.RotateTransform([single]$angle)
        $g.ScaleTransform([single]$sx, [single]$sy)
        $g.DrawImage($script:ball, [single](-$size / 2), [single](-$size / 2), [single]$size, [single]$size)
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
$ball.Dispose()
"$i"
