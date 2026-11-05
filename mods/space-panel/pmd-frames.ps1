# Fetches one Pokémon's idle animation from PMDCollab's SpriteCollab (CC BY-NC 4.0) and splits it
# into PNG frames: <Out>/f<n>.png, then <Out>/meta.json last ({ w, h, delays: [ms] }). The sheet's
# first row faces the viewer; frames are cropped to the box all of them fit in, so the sprite
# keeps its place as it moves. -Path is the sprite folder in the repo, e.g. 0025 or 0870/0002.
param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Out)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$base = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite/$Path"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$headers = @{ 'User-Agent' = 'herdr-app' }
[xml]$data = (Invoke-WebRequest -UseBasicParsing -Headers $headers "$base/AnimData.xml").Content
$anim = $data.AnimData.Anims.Anim | Where-Object { $_.Name -eq 'Idle' } | Select-Object -First 1
if ($anim.CopyOf) { $anim = $data.AnimData.Anims.Anim | Where-Object { $_.Name -eq $anim.CopyOf } | Select-Object -First 1 }
$fw = [int]$anim.FrameWidth; $fh = [int]$anim.FrameHeight
# Durations are in game frames (1/60 s).
$delays = @($anim.Durations.Duration | ForEach-Object { [int][Math]::Round([int]$_ * 1000 / 60) })
$sheetFile = Join-Path $Out 'sheet.png'
Invoke-WebRequest -UseBasicParsing -Headers $headers "$base/$($anim.Name)-Anim.png" -OutFile $sheetFile
$sheet = New-Object System.Drawing.Bitmap $sheetFile
try {
    # The box every frame fits in.
    $x0 = $fw; $y0 = $fh; $x1 = -1; $y1 = -1
    for ($i = 0; $i -lt $delays.Count; $i++) {
        for ($y = 0; $y -lt $fh; $y++) {
            for ($x = 0; $x -lt $fw; $x++) {
                if ($sheet.GetPixel($i * $fw + $x, $y).A -gt 0) {
                    if ($x -lt $x0) { $x0 = $x }; if ($x -gt $x1) { $x1 = $x }
                    if ($y -lt $y0) { $y0 = $y }; if ($y -gt $y1) { $y1 = $y }
                }
            }
        }
    }
    $w = $x1 - $x0 + 1; $h = $y1 - $y0 + 1
    for ($i = 0; $i -lt $delays.Count; $i++) {
        $frame = $sheet.Clone((New-Object System.Drawing.Rectangle ($i * $fw + $x0), $y0, $w, $h), $sheet.PixelFormat)
        $frame.Save((Join-Path $Out "f$i.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $frame.Dispose()
    }
} finally { $sheet.Dispose() }
Remove-Item $sheetFile
Set-Content -Path (Join-Path $Out 'meta.json') -Value (@{ w = $w; h = $h; delays = $delays } | ConvertTo-Json -Compress) -Encoding ascii
"$($delays.Count)"
