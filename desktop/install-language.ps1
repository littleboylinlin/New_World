param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Manifest,
    [string]$Locale = '',
    [string]$Selection = ''
)

$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$temporary = $null
try {
    $metadata = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($metadata.schema -ne 1 -or $metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid language manifest' }
    $preferences = Join-Path $Root 'language.json'
    if (!$Locale -and (Test-Path -LiteralPath $preferences)) {
        try { $Locale = (Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json).locale } catch { $Locale = '' }
        if ($Locale -notin @('zh-CN', 'en')) { $Locale = '' }
    }
    if (!$Locale) {
        $Locale = if ((Get-UICulture).Name -match '^zh(?:-|$)') { 'zh-CN' } else { 'en' }
    }
    if ($Locale -notin @('zh-CN', 'en')) { throw 'Unsupported language' }
    $pack = $metadata.packs.$Locale
    if ($pack.sha256 -notmatch '^[0-9a-f]{64}$' -or $pack.size -gt 262144 -or $pack.size -lt 1 -or $pack.file -ne "New-World-lang-$Locale.json") {
        throw 'Invalid language pack metadata'
    }
    $cache = Join-Path (Join-Path $Root 'packs') $metadata.version
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $target = Join-Path $cache "$Locale.json"
    function Test-Pack([string]$Path) {
        if (![IO.File]::Exists($Path) -or ([IO.FileInfo]$Path).Length -ne $pack.size) { return $false }
        $stream = [IO.File]::OpenRead($Path)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
            return $digest -eq $pack.sha256
        } finally {
            $stream.Dispose()
            $algorithm.Dispose()
        }
    }
    if (!(Test-Pack $target)) {
        $temporary = Join-Path $cache ("download-" + [Guid]::NewGuid().ToString('N') + '.tmp')
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $url = "https://github.com/littleboylinlin/New_World/releases/download/v$($metadata.version)/$($pack.file)"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temporary -TimeoutSec 30
        if (!(Test-Pack $temporary)) { throw 'Language pack checksum mismatch' }
        Move-Item -LiteralPath $temporary -Destination $target -Force
        $temporary = $null
    }
    $pending = Join-Path $Root ('language-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($pending, (@{ locale = $Locale } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $pending -Destination $preferences -Force
    if ($Selection) { [IO.File]::WriteAllText($Selection, $Locale, (New-Object Text.UTF8Encoding $false)) }
    Write-Output "Language ready: $Locale"
    exit 0
} catch {
    if ($temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    Write-Error -ErrorAction Continue $_
    exit 4
}
