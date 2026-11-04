# The Poké Ball on space-panel's cards, pixel for pixel after the classic 12-pixel sprite: seen
# from a little above, so the band curves down and the button sits low on the front.
#   pokeball-v<V>-still.png   idle
#   pokeball-v<V>-c<n>.png    an agent works: rocks one way, rocks the other way, bounces once
#   pokeball-v<V>-s<n>.png    an agent's shell runs: spins on its vertical axis, orbit streaks
#   pokeball-v<V>-open.png    an agent needs input: half open, a black mouth under the lid
# Frames are 18x24 (spin frames 23x24) with the ground near the bottom; nearest-neighbour scaling
# keeps the pixels. Files are named pokeball-v<Version>-...: herdr caches images by path, so a new
# look needs new names (space-panel's BALL_VERSION passes the version). Earlier looks: ./archive.
param([Parameter(Mandatory)][string]$Dir, [string]$Version = '16')

Add-Type -AssemblyName System.Drawing

# The sprite's own colours. K outline, R red, D dark red, P pink highlight, W white, L light grey,
# A inside of the lid, G shade inside the ball.
$palette = @{
    'K' = @(0, 0, 0); 'R' = @(254, 0, 0); 'D' = @(180, 0, 1); 'P' = @(254, 104, 105); 'W' = @(254, 254, 254)
    'L' = @(180, 180, 180); 'A' = @(162, 162, 162); 'G' = @(139, 139, 139)
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
    '.KWWWKKLLLKK',
    '.KLWWWWLLLK.',
    '..KKLLLLKKK.',
    '....KKKK....'
)
$halfOpen = @(
    '....KKKK....',
    '..KKWWDDKK..',
    '.KWWRDDDDDK.',
    '.KRRRKKDDDK.',
    'KRRKKWWKKDDK',
    'KRKAGKKGGKDK',
    'KKAKKKKKKGK.',
    'KLKKKKKKKKLK',
    'KWKKKKKKKKLK',
    '.KWWKKKKWLK.',
    '.KLWWWLLLLK.',
    '..KKLLLLKK..',
    '....KKKK....'
)
# For the spin: the ball without its button (the band straight through), and the button itself.
$bare = @(
    '....KKKK....',
    '..KKRDDDKK..',
    '.KRRPRDDDDK.',
    '.KRPWPRRDDK.',
    'KRRRPRRRDDDK',
    'KRRRRRRDDDDK',
    'KKRRRRDDDDKK',
    'KWKKKKKKKKLK',
    '.KWWWWWLLLKK',
    '.KLWWWWLLLK.',
    '..KKLLLLKKK.',
    '....KKKK....'
)
$button = @(
    '.KK.',
    'KWWK',
    'KWWK',
    '.KK.'
)
$ball = Map-Bitmap $closed
$open = Map-Bitmap $halfOpen
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

# ---- Shell: spin on the vertical axis, with circular motion streaks ----
# A sphere keeps its round outline as it turns, and the ball looks the same all round except for
# its button, so only the button moves: along the band (which curves down to the front, as the
# ball is seen from above), narrowing toward the edge, hidden round the back. Spin frames are 23
# wide so the streaks' ring fits.
$spin = @(0..11 | ForEach-Object { $_ * 30 }) + @(0, 0, 0, 0, 0, 0)
$spinTurns = 12 # the first 12 spin frames turn; the rest are the pause, without streaks
$SW = 23
$plain = Map-Bitmap $bare
$patch = Map-Bitmap $button
$pw = $patch.Width; $ph = $patch.Height
$r = $bw / 2

# Two light arcs travelling round a tilted ring at the band, the same way as the button. The half
# behind the ball is dimmer and under it; the half in front is over it, bright, brightening toward
# the arc's head, with a dark pixel under each so it stands out on the white half.
function Draw-Orbit($g, $phase, $cx, $cy, $rx, $ry, $back) {
    $edge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 20, 22, 30))
    for ($k = 0; $k -lt 2; $k++) {
        $t0 = $phase + $k * [Math]::PI
        for ($j = 0; $j -le 14; $j++) {
            $t = $t0 + $j * 0.11
            $front = [Math]::Sin($t) -gt 0
            if ($front -eq $back) { continue }
            $a = if ($back) { [Math]::Min(170, 90 + 6 * $j) } else { [Math]::Min(255, 170 + 8 * $j) }
            $x = [int][Math]::Round($cx + $rx * [Math]::Cos($t)); $y = [int][Math]::Round($cy + $ry * [Math]::Sin($t))
            if (-not $back) { $g.FillRectangle($edge, $x, $y + 1, 1, 1) }
            $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int]$a, 225, 245, 255))
            $g.FillRectangle($b, $x, $y, 1, 1)
            $b.Dispose()
        }
    }
    $edge.Dispose()
}

function Save-Spin($angle, $turning, $path) {
    $out = New-Object System.Drawing.Bitmap $SW, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $x0 = [int](($SW - $bw) / 2); $top = $ground - $bh
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 0, 0, 0))
        $g.FillEllipse($shadow, $x0 + 1, $ground - 1, $bw - 2, 3); $shadow.Dispose()
        # The ring: wider than the ball, tilted, at the band; it turns 1.5 times per ball turn.
        $ocx = $x0 + $bw / 2 - 0.5; $ocy = $top + 7; $orx = $bw / 2 + 4.5; $ory = 4
        $phase = -$angle * [Math]::PI / 180 * 1.5
        if ($turning) { Draw-Orbit $g $phase $ocx $ocy $orx $ory $true }
        $g.DrawImage($script:plain, $x0, $top, $bw, $bh)
        $phi = $angle * [Math]::PI / 180
        $facing = [Math]::Cos($phi)
        # Visible until it is nearly edge-on; the clip keeps it inside the round outline.
        if ($facing -gt 0.08) {
            # Centre on the band: 4.5 px either side of the middle, row 8 at the front, row 7 at the sides.
            $cx = $script:r + 4.5 * [Math]::Sin($phi); $cy = 7 + $facing
            # Full width until well round: at 3 px the scaled button loses half its white centre.
            $w = if ($facing -gt 0.55) { $script:pw } else { [Math]::Max(2, [int][Math]::Round($script:pw * $facing)) }
            $dx = $x0 + [int][Math]::Round($cx - $w / 2); $dy = $top + [int][Math]::Round($cy - $script:ph / 2)
            $rim = New-Object System.Drawing.Drawing2D.GraphicsPath
            $rim.AddEllipse($x0 + 1, $top + 1, $bw - 2, $bh - 2)
            $g.SetClip($rim)
            $g.DrawImage($script:patch, (New-Object System.Drawing.Rectangle $dx, $dy, $w, $script:ph),
                (New-Object System.Drawing.Rectangle 0, 0, $script:pw, $script:ph), [System.Drawing.GraphicsUnit]::Pixel)
            $g.ResetClip(); $rim.Dispose()
        }
        if ($turning) { Draw-Orbit $g $phase $ocx $ocy $orx $ory $false }
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

$i = 0
foreach ($f in $frames) { Save-Frame $ball $f[0] $f[1] $f[2] $f[3] (Join-Path $Dir "pokeball-v$Version-c$i.png"); $i++ }
Save-Frame $ball 0 1 1 0 (Join-Path $Dir "pokeball-v$Version-still.png")
Save-Frame $open 0 1 1 0 (Join-Path $Dir "pokeball-v$Version-open.png")
$s = 0
foreach ($angle in $spin) { Save-Spin $angle ($s -lt $spinTurns) (Join-Path $Dir "pokeball-v$Version-s$s.png"); $s++ }
# space-panel draws the frames again when this marker is missing.
Set-Content -Path (Join-Path $Dir "pokeball-v$Version-ready") -Value $i
$ball.Dispose(); $open.Dispose()
"$i"
