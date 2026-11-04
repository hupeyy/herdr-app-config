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

# The shell spin (pokeball-v<V>-s<n>.png), for an agent with a shell still running: one full turn
# about the ball's vertical axis through its centre, in 30-degree steps, then a short pause, and
# again. A sphere keeps its round outline as it turns, and a Poke Ball looks the same all round
# except for its button, so only the button moves: along the band, narrowing toward the edge,
# hidden while it is round the back. The outline, shading and highlight stay where they are.
$spin = @(0..11 | ForEach-Object { $_ * 30 }) + @(0, 0, 0, 0, 0, 0)

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

function Save-Spin($angle, $path) {
    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 0, 0, 0))
        $g.FillEllipse($shadow, [int](($W - $bw) / 2) + 1, $ground - 1, $bw - 2, 3); $shadow.Dispose()
        $x0 = [int](($W - $bw) / 2); $top = $ground - $bh
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
    } finally { $g.Dispose() }
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

# An opened ball (pokeball-v<V>-open.png), for an agent that needs input: the bottom half stays on
# the ground and the top half swings up and back on its rear hinge, with light inside.
function Save-Open($path) {
    # Cut at the band: the darkest row in the middle of the ball.
    $split = [int]($bh / 2); $best = -1
    for ($y = [int]($bh * 0.35); $y -le [int]($bh * 0.75); $y++) {
        $dark = 0
        for ($x = 0; $x -lt $bw; $x++) { $c = $script:ball.GetPixel($x, $y); if ($c.A -gt 0 -and ($c.R + $c.G + $c.B) -lt 300) { $dark++ } }
        if ($dark -gt $best) { $best = $dark; $split = $y }
    }
    $out = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $x0 = [int](($W - $bw) / 2); $top = $ground - $bh
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 0, 0, 0))
        $g.FillEllipse($shadow, $x0 + 1, $ground - 1, $bw - 2, 3); $shadow.Dispose()
        # Bottom half, where it always is.
        $g.DrawImage($script:ball, (New-Object System.Drawing.Rectangle $x0, ($top + $split), $bw, ($bh - $split)),
            (New-Object System.Drawing.Rectangle 0, $split, $bw, ($bh - $split)), [System.Drawing.GraphicsUnit]::Pixel)
        # Light from inside the open ball.
        $glow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 255, 248, 200))
        $g.FillEllipse($glow, $x0 + 2, $top + $split - 2, $bw - 4, 4); $glow.Dispose()
        # Top half, swung up and back about its rear (left) end of the cut.
        $g.TranslateTransform([single]($x0 + 1), [single]($top + $split))
        $g.RotateTransform([single]-38)
        $g.DrawImage($script:ball, (New-Object System.Drawing.Rectangle -1, (-$split - 1), $bw, $split),
            (New-Object System.Drawing.Rectangle 0, 0, $bw, $split), [System.Drawing.GraphicsUnit]::Pixel)
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
foreach ($angle in $spin) { Save-Spin $angle (Join-Path $Dir "pokeball-v$Version-s$s.png"); $s++ }
# space-panel draws the frames again when this marker is missing.
Set-Content -Path (Join-Path $Dir "pokeball-v$Version-ready") -Value $i
$ball.Dispose()
"$i"
