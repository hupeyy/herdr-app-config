# The Poké Ball on space-panel's cards, pixel for pixel after the classic 12-pixel sprite: seen
# from a little above, so the band curves down and the button sits low on the front.
#   pokeball-v<V>-still.png   idle
#   pokeball-v<V>-c<n>.png    an agent works: rocks one way, rocks the other way, bounces once
#   pokeball-v<V>-s<n>.png    an agent's shell runs: turns flat about its centre, circling streaks
#   pokeball-v<V>-o<n>.png    an agent starts waiting: closed, half open, open, with a small hop
#   pokeball-v<V>-open.png    an agent needs input: fully open, the lid's grey inside showing
# The open ball is 16 rows tall, the closed one 12. Frames are 18x24 (spin frames 24x24) with
# the ground near the bottom; nearest-neighbour scaling keeps the pixels. Files are named pokeball-v<Version>-...: herdr caches images by path, so a new
# look needs new names (space-panel's BALL_VERSION passes the version). Earlier looks: ./archive.
param([Parameter(Mandatory)][string]$Dir, [string]$Version = '16')

Add-Type -AssemblyName System.Drawing

# The sprite's own colours. K outline, R red, D dark red, P pink highlight, W white, L light grey,
# A inside of the lid, G shade inside the ball, S the lid's shaded inside.
$palette = @{
    'K' = @(0, 0, 0); 'R' = @(254, 0, 0); 'D' = @(180, 0, 1); 'P' = @(254, 104, 105); 'W' = @(254, 254, 254)
    'L' = @(180, 180, 180); 'A' = @(162, 162, 162); 'G' = @(139, 139, 139); 'S' = @(121, 121, 121)
}
function Map-Bitmap($rows) {
    $bmp = New-Object System.Drawing.Bitmap $rows[0].Length, $rows.Count
    for ($y = 0; $y -lt $rows.Count; $y++) {
        for ($x = 0; $x -lt $rows[$y].Length; $x++) {
            $c = [string]$rows[$y][$x]
            if ($c -ne '.') { $p = $palette[$c]; $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $p[0], $p[1], $p[2])) }
        }
    }
    return $bmp
}

$closed = @(
    '....KKKK....',
    '..KKRDDDKK..',
    '.KRRPRDDDDK.',
    '.KRPWPRRDDK.',
    'KRRRPRRRDDDK',
    'KRRRRKKDDDDK',
    'KKRRKWWKDDKK',
    'KWKKKWWKKKLK',
    '.KWWWKKLLLK.',
    '.KLWWWWLLLK.',
    '..KKLLLLKK..',
    '....KKKK....'
)
# Half open (the opening's middle frame): the lid tipped back over a black mouth.
$halfOpen = @(
    '....KKKK....',
    '..KKWWDDKK..',
    '.KWWRDDDDDK.',
    '.KRRRKKDDDK.',
    'KRRKKWWKKDDK',
    'KRKAGKKGGKDK',
    'KKAKKKKKKGKK',
    'KLKKKKKKKKLK',
    'KWKKKKKKKKLK',
    '.KWWKKKKWLK.',
    '.KLWWWLLLLK.',
    '..KKLLLLKK..',
    '....KKKK....'
)
# Open: the lid stands up behind the ball, its grey inside facing us, over the black hollow.
$fullOpen = @(
    '....RKKD....',
    '..RDKWLKDD..',
    '.RKKAKKSKKD.',
    '.KAAAASSSSK.',
    'DAAAAAASSSSD',
    'KAAAAAASSSSK',
    'KAAAAASSSSSK',
    '.KAASSSSSSK.',
    '..KKSSSSKK..',
    '.KWKKKKKKLK.',
    'KWKKKKKKKKLK',
    'KLKKKKKKKKLK',
    '.KWKKKKKKLK.',
    '.KLWWLLLLLK.',
    '..KKLLLLKK..',
    '....KKKK....'
)
$ball = Map-Bitmap $closed
$half = Map-Bitmap $halfOpen
$open = Map-Bitmap $fullOpen
$bw = $ball.Width; $bh = $ball.Height

$W = 18; $H = 24; $ground = 22

# ---- Working: rock one way, rock the other way, bounce once ----
# lift (px above ground), x scale, y scale, tilt (degrees, about the ball's base)
$rock = { param($dir) @(
    @(0, 1, 1, (10 * $dir)), @(0, 1, 1, (20 * $dir)), @(0, 1, 1, (20 * $dir)), @(0, 1, 1, (10 * $dir)), @(0, 1, 1, 0)
) }
$bounce = @(
    @(0, 1.12, 0.88, 0), @(3, 0.90, 1.12, 0), @(6, 0.95, 1.05, 0), @(8, 1, 1, 0), @(9, 1, 1, 0),
    @(8, 1, 1, 0), @(6, 0.95, 1.05, 0), @(3, 0.90, 1.12, 0), @(0, 1.28, 0.72, 0), @(0, 1.10, 0.90, 0),
    @(0, 1, 1, 0), @(0, 1, 1, 0)
)
$frames = (& $rock -1) + (& $rock 1) + $bounce

function Save-Frame($img, $lift, $sx, $sy, $angle, $path) {
    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        # Shadow: wide and dark on the ground, small and faint at the top of a hop.
        $k = 1 - ($lift / 12)
        $sw = [int][Math]::Round($bw * (0.55 + 0.45 * $k) * [Math]::Max(1, $sx))
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](40 + 60 * $k), 0, 0, 0))
        $g.FillEllipse($brush, [int](($W - $sw) / 2), $ground - 1, $sw, 3)
        $brush.Dispose()
        # The ball, scaled and tilted about its base (bottom centre), which sits at the lift height,
        # so a rock pivots on the ground. GDI+ takes singles: PowerShell's numbers can pick an
        # overload it rejects.
        $g.TranslateTransform([single]($W / 2), [single]($ground - $lift))
        $g.RotateTransform([single]$angle)
        $g.ScaleTransform([single]$sx, [single]$sy)
        $g.DrawImage($img, [single](-$img.Width / 2), [single](-$img.Height), [single]$img.Width, [single]$img.Height)
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

# ---- Shell: the ball turns flat on screen about its centre, like a wheel ----
# 30-degree steps (nearest-neighbour, so the pixels stay square), with two light streaks circling
# behind the turn, then a pause. Spin frames are 24x24 so the streaks' circle fits.
$spin = @(0..11 | ForEach-Object { $_ * 30 }) + @(0, 0, 0, 0, 0, 0)
$spinTurns = 12 # the first 12 spin frames turn; the rest are the pause, without streaks
$SW = 24; $scx = 12; $scy = 15 # the ball's centre in the frame
$streakR = 8.5

function Save-Spin($angle, $turning, $path) {
    $out = New-Object System.Drawing.Bitmap $SW, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
        $g.FillEllipse($shadow, $scx - 5, $ground - 1, $bw - 1, 3); $shadow.Dispose()
        if ($turning) {
            # Two arcs on opposite sides, each brightening toward its head, with a dark pixel
            # beside each so they stand out on the white half.
            $edge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 20, 22, 30))
            $a0 = $angle * [Math]::PI / 180
            foreach ($k in 0, 1) {
                for ($j = 0; $j -le 12; $j++) {
                    $t = $a0 + $k * [Math]::PI - 0.5 - $j * 0.09
                    $x = [int][Math]::Round($scx - 0.5 + $streakR * [Math]::Cos($t)); $y = [int][Math]::Round($scy - 0.5 + $streakR * [Math]::Sin($t))
                    $g.FillRectangle($edge, $x + 1, $y + 1, 1, 1)
                    $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int][Math]::Min(255, 120 + 11 * $j), 225, 245, 255))
                    $g.FillRectangle($b, $x, $y, 1, 1); $b.Dispose()
                }
            }
            $edge.Dispose()
        }
        $g.TranslateTransform([single]$scx, [single]$scy)
        $g.RotateTransform([single]$angle)
        $g.DrawImage($script:ball, [single](-$bw / 2), [single](-$bh / 2), [single]$bw, [single]$bh)
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

$i = 0
foreach ($f in $frames) { Save-Frame $ball $f[0] $f[1] $f[2] $f[3] (Join-Path $Dir "pokeball-v$Version-c$i.png"); $i++ }
Save-Frame $ball 0 1 1 0 (Join-Path $Dir "pokeball-v$Version-still.png")
Save-Frame $open 0 1 1 0 (Join-Path $Dir "pokeball-v$Version-open.png")
# Opening, after the classic sheet: a squash, the lid pops to half open as the ball hops, then
# it lands fully open. The card then holds open.png.
$opening = @(
    @($ball, 0, 1, 1), @($ball, 0, 1.12, 0.88), @($half, 1, 1, 1), @($half, 2, 1, 1),
    @($open, 1, 1, 1), @($open, 0, 1.08, 0.92), @($open, 0, 1, 1)
)
$o = 0
foreach ($f in $opening) { Save-Frame $f[0] $f[1] $f[2] $f[3] 0 (Join-Path $Dir "pokeball-v$Version-o$o.png"); $o++ }
$s = 0
foreach ($angle in $spin) { Save-Spin $angle ($s -lt $spinTurns) (Join-Path $Dir "pokeball-v$Version-s$s.png"); $s++ }
# space-panel draws the frames again when this marker is missing.
Set-Content -Path (Join-Path $Dir "pokeball-v$Version-ready") -Value $i
$ball.Dispose(); $half.Dispose(); $open.Dispose()
"$i"
