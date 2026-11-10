param([string]$Installer, [string]$Directory)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class InstallerWindow {
    private delegate bool VisitWindow(IntPtr window, IntPtr unused);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, VisitWindow visit, IntPtr unused);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);

    public static IntPtr Find(IntPtr parent, int id, string text) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr unused) {
            if (!IsWindowVisible(child)) return true;
            if (id != 0 && (GetDlgCtrlID(child) != id || !IsWindowEnabled(child))) return true;
            if (!String.IsNullOrEmpty(text) && Text(child).Trim() != text) return true;
            found = child;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static string Text(IntPtr window) {
        var label = new StringBuilder(512);
        IntPtr ignored;
        SendMessageTimeout(window, 0x000D, (IntPtr)label.Capacity, label, 2, 1000, out ignored); // WM_GETTEXT
        return label.ToString();
    }

    public static string Describe(IntPtr parent) {
        var description = new StringBuilder(Text(parent));
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr unused) {
            if (IsWindowVisible(child)) {
                description.AppendLine();
                description.AppendFormat("{0} enabled={1} {2}", GetDlgCtrlID(child), IsWindowEnabled(child), Text(child));
            }
            return true;
        }, IntPtr.Zero);
        return description.ToString();
    }

    public static void SetPath(IntPtr window, string path) {
        IntPtr result;
        if (SendMessageTimeout(window, 0x000C, IntPtr.Zero, path, 2, 2000, out result) == IntPtr.Zero || result == IntPtr.Zero)
            throw new InvalidOperationException("Could not enter the installation path");
        if (Text(window) != path) throw new InvalidOperationException("Installer did not keep the entered path");
    }

    public static void Select(IntPtr window) {
        IntPtr result;
        if (SendMessageTimeout(window, 0x00F0, IntPtr.Zero, IntPtr.Zero, 2, 2000, out result) == IntPtr.Zero || result != IntPtr.Zero)
            throw new InvalidOperationException("Expected an unchecked installer checkbox");
        if (SendMessageTimeout(window, 0x00F1, (IntPtr)1, IntPtr.Zero, 2, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Could not check the installer option");
    }

    public static void Next(IntPtr parent, IntPtr button) {
        if (!PostMessage(parent, 0x0111, (IntPtr)1, button)) // WM_COMMAND / IDOK
            throw new InvalidOperationException("Could not advance the installer");
    }
}
'@

function Wait-For($Find, [string]$Description) {
    $limit = (Get-Date).AddSeconds(75)
    do {
        $value = & $Find
        if ($value) { return $value }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $limit)
    throw "Timed out waiting for $Description"
}

function Find-Control([int]$Id, [string]$Text = '') {
    $setup.Refresh()
    if ($setup.HasExited) { throw "Installer exited early with code $($setup.ExitCode)" }
    if ($setup.MainWindowHandle -eq 0) { return }
    $control = [InstallerWindow]::Find($setup.MainWindowHandle, $Id, $Text)
    if ($control -ne [IntPtr]::Zero) { $control }
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
    $directoryField = Wait-For { Find-Control 1019 } 'installation directory field'
    [InstallerWindow]::SetPath($directoryField, $Directory)
    $next = Wait-For { Find-Control 1 } 'install button'
    [InstallerWindow]::Next($setup.MainWindowHandle, $next)

    $launch = Wait-For { Find-Control 0 '启动 New World' } 'launch checkbox'
    $shortcut = Wait-For { Find-Control 0 '创建桌面快捷方式' } 'desktop shortcut checkbox'
    [InstallerWindow]::Select($launch)
    [InstallerWindow]::Select($shortcut)

    $finish = Wait-For { Find-Control 1 } 'finish button'
    [InstallerWindow]::Next($setup.MainWindowHandle, $finish)
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
} catch {
    $setup.Refresh()
    if ($setup.MainWindowHandle -ne 0) { Write-Output ([InstallerWindow]::Describe($setup.MainWindowHandle)) }
    Write-Output "Application exists at chosen path: $(Test-Path -LiteralPath (Join-Path $Directory 'New World.exe'))"
    throw
} finally {
    if (!$setup.HasExited) { $setup.Kill() }
}
