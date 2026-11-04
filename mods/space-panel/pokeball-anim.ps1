# The Poke Ball on space-panel's cards, standing still (pokeball-v<V>-still.png) and, while a
# dev workspace works (pokeball-v<V>-c<n>.png): it rocks one way on its base, rocks the other way,
# then bounces once (squash and stretch, a shadow that shrinks with height), and repeats.
# The ball is -Sprite (PokeAPI's poke-ball item, drawn at a three-quarter angle), cropped to its
# own pixels; without one, the flat red-and-white pixel ball from the map below.
# Frames are 24x32 with the ground near the bottom; nearest-neighbour keeps the pixels.
# Files are named pokeball-v<Version>-...: herdr caches images by path, so a new look needs new
# names to show (space-panel's BALL_VERSION passes the version).
# -LidAngle, -LidShift and -LidScale set how far the open ball's lid is swung back (try others
# with a throwaway -Version and -Dir to compare).
param([Parameter(Mandatory)][string]$Dir, [string]$Version = '3', [string]$Sprite = '', [int]$LidAngle = 38, [int]$LidShift = 3, [int]$LidScale = 75)

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

# The shell spin (pokeball-v<V>-s<n>.png), for an agent with a shell still running: one full turn
# about the ball's vertical axis through its centre, in 30-degree steps, then a short pause, and
# again. A sphere keeps its round outline as it turns, and a Poke Ball looks the same all round
# except for its button, so only the button moves: along the band, narrowing toward the edge,
# hidden while it is round the back. The outline, shading and highlight stay where they are.
# While it turns, circular motion streaks orbit it on a tilted ring (see Draw-Orbit). Spin frames
# are 30 wide (the others 24) so the ring fits.
$spin = @(0..11 | ForEach-Object { $_ * 30 }) + @(0, 0, 0, 0, 0, 0)
$spinTurns = 12 # the first 12 spin frames turn; the rest are the pause, without streaks
$SW = 30

# Two light arcs travelling round a tilted ring at the ball's band, the same way as the button.
# The half behind the ball is dimmer and drawn under it; the half in front is drawn over it,
# bright, brightening toward the arc's head, with a dark pixel under each so it stands out even
# over the ball's pale lower half. The ring's front is its lower half.
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

# The PokeAPI sprite's button, in the cropped ball's pixels (the sprite is a fixed file): a white
# cross in a grey ring on the band, left of centre (sprite rows 16-20, columns 10-14).
$haveButton = $Sprite -and (Test-Path $Sprite) -and $bw -eq 18 -and $bh -eq 18
if ($haveButton) {
    $px0 = 4; $py0 = 10; $pw = 5; $ph = 5
    # Only the ring and cross move: the cut's red corners and white-half pixels stay transparent.
    $patch = New-Object System.Drawing.Bitmap $pw, $ph
    for ($x = 0; $x -lt $pw; $x++) { for ($y = 0; $y -lt $ph; $y++) {
        $corner = ($y -eq 0 -and ($x -eq 0 -or $x -eq 4)) -or ($y -eq 4 -and ($x -eq 0 -or $x -eq 4))
        if (-not $corner) { $patch.SetPixel($x, $y, $ball.GetPixel($px0 + $x, $py0 + $y)) }
    } }
    # The ball without its button: red cap above the band where the ring's top was, band where
    # the cross was, then the white half below it (keeping that half's own highlight at the left).
    $plain = $ball.Clone()
    $red = $ball.GetPixel(4, 10); $band = $ball.GetPixel(15, 11); $white = $ball.GetPixel(9, 14)
    for ($x = 5; $x -le 7; $x++) { $plain.SetPixel($x, 10, $red) }
    for ($x = 4; $x -le 8; $x++) {
        $plain.SetPixel($x, 11, $band); $plain.SetPixel($x, 12, $band)
        if ($x -lt 8) { $plain.SetPixel($x, 13, $white) }
        if ($x -gt 4) { $plain.SetPixel($x, 14, $white) }
    }
    # Where the button sits on the turning sphere: its angle from the facing direction.
    $r = $bw / 2
    $phi0 = [Math]::Asin((($px0 + $pw / 2) - $r) / $r)
}

function Save-Spin($angle, $turning, $path) {
    $out = New-Object System.Drawing.Bitmap $SW, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 0, 0, 0))
        $g.FillEllipse($shadow, [int](($SW - $bw) / 2) + 1, $ground - 1, $bw - 2, 3); $shadow.Dispose()
        $x0 = [int](($SW - $bw) / 2); $top = $ground - $bh
        # The ring: wider than the ball, tilted, at band height; it turns 1.5 times per ball turn.
        $ocx = $x0 + $bw / 2 - 0.5; $ocy = $top + 11.5; $orx = $bw / 2 + 4.5; $ory = 5
        $phase = -$angle * [Math]::PI / 180 * 1.5
        if ($turning) { Draw-Orbit $g $phase $ocx $ocy $orx $ory $true }
        if (-not $script:haveButton) {
            # The flat fallback ball: no button to move, so it simply stands there, round.
            $g.DrawImage($script:ball, $x0, $top, $bw, $bh)
        } else {
            $g.DrawImage($script:plain, $x0, $top, $bw, $bh)
            $phi = $script:phi0 + $angle * [Math]::PI / 180
            $facing = [Math]::Cos($phi)
            # Visible until it is nearly edge-on; the clip below keeps it inside the outline.
            if ($facing -gt 0.08) {
                $cx = $script:r + $script:r * [Math]::Sin($phi)
                $w = [Math]::Max(2, [int][Math]::Round($script:pw * $facing))
                # The band runs about a pixel lower on the right than on the left.
                $dy = $top + $script:py0 + [int][Math]::Round(($cx - $script:r) / $script:r * 0.8 + 0.3)
                $dx = $x0 + [int][Math]::Round($cx - $w / 2)
                # Near the rim the button must not poke outside the ball's round outline.
                $rim = New-Object System.Drawing.Drawing2D.GraphicsPath
                $rim.AddEllipse($x0 + 1, $top + 1, $bw - 2, $bh - 2)
                $g.SetClip($rim)
                $g.DrawImage($script:patch, (New-Object System.Drawing.Rectangle $dx, $dy, $w, $script:ph),
                    (New-Object System.Drawing.Rectangle 0, 0, $script:pw, $script:ph), [System.Drawing.GraphicsUnit]::Pixel)
                $g.ResetClip(); $rim.Dispose()
            }
        }
        if ($turning) { Draw-Orbit $g $phase $ocx $ocy $orx $ory $false }
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

# An opened ball (pokeball-v<V>-open.png), for an agent that needs input, after the classic
# opening sprite, in the same three-quarter view as the closed ball: seen a little from above and
# from the front left (the button is left of centre and the band slopes down to the right). The
# opening follows the band's slope; the lid is hinged at the back right, opposite the button, and
# leans up and back that way with its grey inside facing the viewer and the red shell along its
# outer edge. Colours come from the sprite.
function Save-Open($path) {
    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $x0 = [int](($W - $bw) / 2); $top = $ground - $bh
        $brush = { param($r, $gg, $b, $a = 255) New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, $r, $gg, $b)) }
        $outline = & $brush 49 49 49; $red = & $brush 255 148 58; $redDark = & $brush 222 90 58
        $grey = & $brush 123 123 132; $greyLight = & $brush 165 165 197; $greyDark = & $brush 74 82 82
        $rim = & $brush 222 206 247; $hollow = & $brush 24 24 30; $shadow = & $brush 0 0 0 100
        # An ellipse of size w x h centred at (cx, cy), turned by angle degrees (down to the right).
        $oval = {
            param($b, $cx, $cy, $w, $h, $angle)
            $g.TranslateTransform([single]$cx, [single]$cy); $g.RotateTransform([single]$angle)
            $g.FillEllipse($b, [single](-$w / 2), [single](-$h / 2), [single]$w, [single]$h)
            $g.ResetTransform()
        }
        $g.FillEllipse($shadow, $x0 + 1, $ground - 1, $bw - 2, 3)
        # Lid: hinged at the back right of the opening, leaning up and back to the right. Its
        # inside faces front left, so the red shell shows as a rim along its upper right edge.
        # Opened further, the lid is seen more edge-on, so it is drawn smaller ($k) and further
        # up and back toward its hinge, leaving the opening clear.
        $k = $script:LidScale / 100
        # It stays low enough that its lower edge meets the back of the rim, where the hinge is.
        $lx = $x0 + 11 + $script:LidShift; $ly = $top + 2 - [int]($script:LidShift / 2); $la = $script:LidAngle
        & $oval $outline $lx $ly (18 * $k) (16 * $k) $la
        & $oval $red $lx $ly (16 * $k) (14 * $k) $la
        & $oval $redDark ($lx + 3 * $k) ($ly + 1 * $k) (9 * $k) (11 * $k) $la
        & $oval $outline ($lx - 1 * $k) ($ly + 1 * $k) (15 * $k) (13 * $k) $la
        & $oval $grey ($lx - 1 * $k) ($ly + 1 * $k) (13 * $k) (11 * $k) $la
        & $oval $greyDark ($lx - 1 * $k) ($ly + 4 * $k) (10 * $k) (5 * $k) $la
        & $oval $grey ($lx - 2 * $k) ($ly + 2 * $k) (10 * $k) (7 * $k) $la
        & $oval $greyLight ($lx - 4 * $k) ($ly - 1 * $k) (5 * $k) (4 * $k) $la
        # The hinge: a short dark block joining the lid to the back right of the rim.
        $g.FillRectangle($outline, $x0 + 13, $top + 6, 3, 3)
        $g.FillRectangle($greyDark, $x0 + 14, $top + 7, 1, 1)
        # Bowl: the sprite's own lower half, from the band down.
        $g.DrawImage($script:ball, (New-Object System.Drawing.Rectangle $x0, ($top + 10), $bw, ($bh - 10)),
            (New-Object System.Drawing.Rectangle 0, 10, $bw, ($bh - 10)), [System.Drawing.GraphicsUnit]::Pixel)
        # Its opening along the band, sloping down to the right like the band: outline, light rim,
        # dark hollow, and the far inside wall a little lighter so the hollow reads as depth.
        $ox = $x0 + 9; $oy = $top + 11; $oa = 7
        & $oval $outline $ox $oy 18 8 $oa
        & $oval $rim $ox $oy 17 7 $oa
        & $oval $hollow $ox ($oy + 0.5) 15 5 $oa
        & $oval $greyDark $ox ($oy - 1) 11 2 $oa
        foreach ($b in $outline, $red, $redDark, $grey, $greyLight, $greyDark, $rim, $hollow, $shadow) { $b.Dispose() }
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
Save-Open (Join-Path $Dir "pokeball-v$Version-open.png")
$s = 0
foreach ($angle in $spin) { Save-Spin $angle ($s -lt $spinTurns) (Join-Path $Dir "pokeball-v$Version-s$s.png"); $s++ }
# space-panel draws the frames again when this marker is missing.
Set-Content -Path (Join-Path $Dir "pokeball-v$Version-ready") -Value $i
$ball.Dispose()
"$i"
