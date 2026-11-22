param([string]$Installer, [string]$Package, [string]$Directory)

# The online installer stays small and installs the app from a local package (the same path it takes
# when the download is placed next to it); the download itself needs the release to be on the mirror.
$ErrorActionPreference = 'Stop'
$size = (Get-Item $Installer).Length
if ($size -gt 2MB) { throw "The online installer is $size bytes" }
$process = Start-Process -FilePath $Installer -ArgumentList @('/S', "--package-file=$Package", "/D=$Directory") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "The online installer exited with $($process.ExitCode)" }
$app = Join-Path $Directory 'New World.exe'
if (-not (Test-Path $app)) { throw "New World.exe was not installed to $Directory" }
Write-Host "Online installer: $([math]::Round($size / 1KB)) KB; installed $app"
