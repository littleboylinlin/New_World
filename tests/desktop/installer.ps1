param([string]$Installer, [string]$Directory)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Wait-For($Find, [string]$Description) {
    $limit = (Get-Date).AddSeconds(45)
    do {
        $value = & $Find
        if ($value) { return $value }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $limit)
    throw "Timed out waiting for $Description"
}

function Find-Control($Property, [string]$Value) {
    $setup.Refresh()
    if ($setup.HasExited) { throw "Installer exited early with code $($setup.ExitCode)" }
    if ($setup.MainWindowHandle -eq 0) { return }
    $window = [Windows.Automation.AutomationElement]::FromHandle($setup.MainWindowHandle)
    $condition = [Windows.Automation.PropertyCondition]::new($Property, $Value)
    $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

$occupied = "$Directory Existing Files"
New-Item -ItemType Directory -Path $occupied | Out-Null
$marker = Join-Path $occupied 'keep.txt'
Set-Content -LiteralPath $marker -Value 'keep'
$invalid = Start-Process -FilePath $Installer -ArgumentList "/S /D=$occupied" -PassThru
if (!$invalid.WaitForExit(45000) -or $invalid.ExitCode -ne 3 -or (Get-Content -LiteralPath $marker) -ne 'keep') {
    throw 'Installer did not preserve the unrelated nonempty directory'
}

$setup = Start-Process -FilePath $Installer -PassThru
try {
    $id = [Windows.Automation.AutomationElement]::AutomationIdProperty
    $name = [Windows.Automation.AutomationElement]::NameProperty
    $directoryField = Wait-For { Find-Control $id '1019' } 'installation directory field'
    $directoryField.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Directory)
    $next = Wait-For { Find-Control $id '1' } 'install button'
    $next.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()

    $launch = Wait-For { Find-Control $name '启动 New World' } 'launch checkbox'
    $shortcut = Wait-For { Find-Control $name '创建桌面快捷方式' } 'desktop shortcut checkbox'
    foreach ($checkbox in @($launch, $shortcut)) {
        $toggle = $checkbox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) {
            throw "Expected $($checkbox.Current.Name) to be unchecked"
        }
        $toggle.Toggle()
    }

    $finish = Wait-For { Find-Control $id '1' } 'finish button'
    $finish.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    if (!$setup.WaitForExit(45000) -or $setup.ExitCode -ne 0) { throw 'Installer did not finish successfully' }

    $exe = Join-Path $Directory 'New World.exe'
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    $link = Join-Path $desktop 'New World.lnk'
    if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $link)) {
        throw 'The selected installation directory or desktop shortcut was not created'
    }
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($link).TargetPath -ne $exe) { throw 'The shortcut does not target the selected directory' }

    $app = Wait-For {
        Get-Process -Name 'New World' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -eq $exe } |
            Select-Object -First 1
    } 'New World window after installation'
    if (!$app.CloseMainWindow() -or !$app.WaitForExit(20000)) { throw 'New World did not close after the smoke test' }
    Write-Output 'Installer UI passed: selected directory, optional desktop shortcut, and optional launch.'
} finally {
    if (!$setup.HasExited) { $setup.Kill() }
}
