# The Poke Ball on space-panel's cards, standing still (pokeball-v<V>-still.png) and, while a
# dev workspace works (pokeball-v<V>-c<n>.png): it rocks one way on its base, rocks the other way,
# then bounces once (squash and stretch, a shadow that shrinks with height), and repeats.
# The ball is -Sprite (PokeAPI's poke-ball item, drawn at a three-quarter angle), cropped to its
# own pixels; without one, the flat red-and-white pixel ball from the map below.
# Frames are 24x32 with the ground near the bottom; nearest-neighbour keeps the pixels.
# Files are named pokeball-v<Version>-...: herdr caches images by path, so a new look needs new
# names to show (space-panel's BALL_VERSION passes the version).
# -LidAngle sets how far the open ball's lid is tipped back (try others with a throwaway
# -Version and -Dir to compare).
param([Parameter(Mandatory)][string]$Dir, [string]$Version = '3', [string]$Sprite = '', [int]$LidAngle = 18)

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

# A half-opened ball (pokeball-v<V>-open.png), for an agent that needs input, after the middle
# frame of the classic opening sprite. It is modelled in 3D so the lid opens like the real thing:
# the sprite is a sphere (radius R) seen from slightly above (elevation $elev), its button on the
# front a little left of centre, and the hinge on the back directly opposite the button. Every
# pixel of the top half is a point on the sphere; the lid turns -LidAngle degrees about the hinge
# axis (the rim's tangent at the hinge), so its front lifts and it tips back away from the
# viewer, then each point is projected back to the screen (far points first). The bottom half
# stays; the opening is the rim's own projection, a light ring around a dark hollow.
function Save-Open($path) {
    $R = $bw / 2.0
    $elev = 16 * [Math]::PI / 180            # how far above the ball we look (from the band's place)
    $phiB = [Math]::Asin(((4 + 2.5) - $R) / $R) # the button's azimuth: left of centre, on the front
    $ce = [Math]::Cos($elev); $se = [Math]::Sin($elev)
    # The hinge: on the rim, opposite the button. Its axis is the rim's tangent there.
    $hx = -$R * [Math]::Sin($phiB); $hz = -$R * [Math]::Cos($phiB)
    $ax = [Math]::Cos($phiB); $az = -[Math]::Sin($phiB)
    $th = $script:LidAngle * [Math]::PI / 180
    # Turn a point about the hinge axis (Rodrigues), the way that lifts the lid's front.
    $turn = {
        param($x, $y, $z, $t)
        $vx = $x - $hx; $vy = $y; $vz = $z - $hz
        $c = [Math]::Cos($t); $s = [Math]::Sin($t)
        $cx = 0 * $vz - $az * $vy; $cy = $az * $vx - $ax * $vz; $cz = $ax * $vy - 0 * $vx
        $d = $ax * $vx + $az * $vz
        @(($hx + $vx * $c + $cx * $s + $ax * $d * (1 - $c)), ($vy * $c + $cy * $s), ($hz + $vz * $c + $cz * $s + $az * $d * (1 - $c)))
    }
    $front = & $turn 0 0 $R $th
    if ($front[1] -lt 0) { $th = -$th }

    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $x0 = [int](($W - $bw) / 2); $top = $ground - $bh
        $scx = $x0 + $R; $scy = $top + $R    # the sphere's centre on screen
        $mk = { param($r, $gg, $b, $a = 255) New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, $r, $gg, $b)) }
        $outline = & $mk 49 49 49; $rim = & $mk 222 206 247; $hollow = & $mk 24 24 30; $wall = & $mk 74 82 82
        $shadow = & $mk 0 0 0 100
        $g.FillEllipse($shadow, $x0 + 1, $ground - 1, $bw - 2, 3)

        # Each sprite pixel's point on the sphere's visible side.
        $lid = New-Object System.Collections.Generic.List[object]
        for ($v = 0; $v -lt $bh; $v++) {
            for ($u = 0; $u -lt $bw; $u++) {
                $col = $script:ball.GetPixel($u, $v)
                if ($col.A -eq 0) { continue }
                $sx = $u + 0.5 - $R; $su = $R - ($v + 0.5)
                $t2 = $R * $R - $sx * $sx - $su * $su
                $t = if ($t2 -gt 0) { [Math]::Sqrt($t2) } else { 0 }
                $X = $sx; $Y = $su * $ce + $t * $se; $Z = -$su * $se + $t * $ce
                if ($Y -le 0) { $out.SetPixel($x0 + $u, $top + $v, $col); continue } # bottom half stays
                $p = & $turn $X $Y $Z $th
                $lid.Add(@($p[0], $p[1], $p[2], $col))
            }
        }
        # The opening: the rim's projection, a flat ellipse at the equator.
        $ry = $R * $se
        $g.FillEllipse($outline, [single]($scx - $R), [single]($scy - $ry - 1), [single](2 * $R), [single](2 * $ry + 2))
        $g.FillEllipse($rim, [single]($scx - $R + 1), [single]($scy - $ry), [single](2 * $R - 2), [single](2 * $ry))
        $g.FillEllipse($hollow, [single]($scx - $R + 2), [single]($scy - $ry + 0.5), [single](2 * $R - 4), [single](2 * $ry - 1))
        $g.FillEllipse($wall, [single]($scx - $R + 4), [single]($scy - $ry + 0.5), [single](2 * $R - 8), 1)
        # The lid, far points first, each projected back to the screen; a pixel and the one below
        # it, so the tilted lid has no holes.
        foreach ($p in ($lid | Sort-Object { $_[1] * $se + $_[2] * $ce })) {
            $px = [int][Math]::Floor($scx + $p[0]); $py = [int][Math]::Floor($scy - ($p[1] * $ce - $p[2] * $se))
            foreach ($dy in 0, 1) {
                if ($px -ge 0 -and $px -lt $W -and ($py + $dy) -ge 0 -and ($py + $dy) -lt $H) {
                    if ($dy -eq 0 -or $out.GetPixel($px, $py + 1).A -eq 0) { $out.SetPixel($px, $py + $dy, $p[3]) }
                }
            }
        }
        foreach ($b in $outline, $rim, $hollow, $wall, $shadow) { $b.Dispose() }
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
