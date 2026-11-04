# Tilted copies of the Poke Ball for the "working" wobble in space-panel: pokeball-r<angle>.png
# beside pokeball.png. herdr can only spin an svg, so the rocking is a few frames swapped in turn.
# The ball pivots on its bottom centre, like the game's capture wobble; pixels stay sharp.
param([Parameter(Mandatory)][string]$Dir, [int[]]$Angles = @(-24, -12, 12, 24))

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'pokeball.png'))
try {
    # The ball's visible box: its bottom centre is the pivot.
    $minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            if ($src.GetPixel($x, $y).A -gt 0) {
                if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    $pivotX = ($minX + $maxX + 1) / 2.0
    $pivotY = $maxY + 1
    foreach ($angle in $Angles) {
        $out = New-Object System.Drawing.Bitmap $src.Width, $src.Height
        $g = [System.Drawing.Graphics]::FromImage($out)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $g.TranslateTransform($pivotX, $pivotY)
            $g.RotateTransform($angle)
            $g.TranslateTransform(-$pivotX, -$pivotY)
            $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
        } finally { $g.Dispose() }
        $out.Save((Join-Path $Dir "pokeball-r$angle.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
    }
} finally { $src.Dispose() }
'ok'
