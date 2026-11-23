# The Reader's message box gets no image on paste (GPUI hands mods text only), so this saves the
# clipboard's image as a PNG for Claude to read, the way herdr's terminal paste does.
#   paste-image.ps1 <out.png>  ->  "image <out.png>" | "files <path>|<path>" | "none"
# It only reads the clipboard.
param([string]$Out)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
    $img.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
    "image $Out"
} elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
    "files " + (([Windows.Forms.Clipboard]::GetFileDropList()) -join "|")
} else {
    "none"
}
