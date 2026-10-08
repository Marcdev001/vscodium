@echo off
setlocal
set "ALBION_DIAG_SCRIPT=%~f0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$raw = [IO.File]::ReadAllText($env:ALBION_DIAG_SCRIPT); $parts = [regex]::Split($raw, '(?m)^:POWERSHELL_PAYLOAD\r?$'); if ($parts.Count -ne 2) { throw 'Embedded diagnostics payload was not found.' }; Invoke-Expression $parts[1]"
exit /b %ERRORLEVEL%
:POWERSHELL_PAYLOAD
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workDir = Join-Path $env:TEMP "albion-diag-$stamp"
$desktop = [Environment]::GetFolderPath('Desktop')
$zipPath = Join-Path $desktop "albion-diag-$stamp.zip"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$script:AppExe = $null
$installLog = Join-Path $workDir 'diag-install.log'
$installCandidates = @(
    @{ Name = 'Albion'; Dir = (Join-Path $env:LOCALAPPDATA 'Programs\Albion'); Exes = @('Albion.exe', 'albion.exe', 'VSCodium.exe', 'Code.exe', 'codium.exe') },
    @{ Name = 'VSCodium'; Dir = (Join-Path $env:LOCALAPPDATA 'Programs\VSCodium'); Exes = @('VSCodium.exe', 'Code.exe', 'codium.exe') }
)
foreach ($candidate in $installCandidates) {
    if (Test-Path -LiteralPath $candidate.Dir -PathType Container) {
        "FOUND install directory: $($candidate.Name) - $($candidate.Dir)" | Add-Content -LiteralPath $installLog -Encoding UTF8
        if (-not $script:AppExe) {
            foreach ($exeName in $candidate.Exes) {
                $exePath = Join-Path $candidate.Dir $exeName
                if (Test-Path -LiteralPath $exePath -PathType Leaf) {
                    $script:AppExe = $exePath
                    break
                }
            }
        }
    } else {
        "NOT FOUND install directory: $($candidate.Name) - $($candidate.Dir)" | Add-Content -LiteralPath $installLog -Encoding UTF8
    }
}
if ($script:AppExe) {
    "Selected executable: $script:AppExe" | Add-Content -LiteralPath $installLog -Encoding UTF8
} else {
    'No supported Albion or VSCodium executable was found in the checked install directories.' | Add-Content -LiteralPath $installLog -Encoding UTF8
}

function Invoke-AppDiagnostic {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $logPath = Join-Path $workDir "diag-app-$Name.log"
    if (-not $script:AppExe) {
        "Skipped: no supported installed application executable was found." | Set-Content -LiteralPath $logPath -Encoding UTF8
        return
    }

    $stdoutPath = Join-Path $workDir "diag-app-$Name.stdout.tmp"
    $stderrPath = Join-Path $workDir "diag-app-$Name.stderr.tmp"
    "Executable: $script:AppExe" | Set-Content -LiteralPath $logPath -Encoding UTF8
    "Arguments: $($Arguments -join ' ')" | Add-Content -LiteralPath $logPath -Encoding UTF8
    try {
        $process = Start-Process -FilePath $script:AppExe -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $script:AppExe) -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        Start-Sleep -Seconds 15
        $taskOutput = & tasklist.exe /FI "PID eq $($process.Id)" 2>&1
        $stillRunning = [bool](Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
        "Process ID: $($process.Id)" | Add-Content -LiteralPath $logPath -Encoding UTF8
        "Survived 15 seconds: $stillRunning" | Add-Content -LiteralPath $logPath -Encoding UTF8
        'tasklist result:' | Add-Content -LiteralPath $logPath -Encoding UTF8
        $taskOutput | Add-Content -LiteralPath $logPath -Encoding UTF8
    } catch {
        "Launch or process-check error: $_" | Add-Content -LiteralPath $logPath -Encoding UTF8
    }

    foreach ($stream in @(@{ Label = 'STDOUT'; Path = $stdoutPath }, @{ Label = 'STDERR'; Path = $stderrPath })) {
        "--- $($stream.Label) ---" | Add-Content -LiteralPath $logPath -Encoding UTF8
        if (Test-Path -LiteralPath $stream.Path) {
            Get-Content -LiteralPath $stream.Path -ErrorAction SilentlyContinue | Add-Content -LiteralPath $logPath -Encoding UTF8
            Remove-Item -LiteralPath $stream.Path -Force -ErrorAction SilentlyContinue
        } else {
            '(no output captured)' | Add-Content -LiteralPath $logPath -Encoding UTF8
        }
    }
}

Invoke-AppDiagnostic -Name 'normal' -Arguments @()
Invoke-AppDiagnostic -Name 'verbose' -Arguments @('--verbose')
Invoke-AppDiagnostic -Name 'safe' -Arguments @('--verbose', '--disable-gpu', '--no-sandbox')

function Copy-LatestApplicationLog {
    param([Parameter(Mandatory = $true)][string]$ProfileName)

    $logRoot = Join-Path $env:APPDATA "$ProfileName\logs"
    if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) {
        "No $ProfileName application log directory found: $logRoot" | Add-Content -LiteralPath (Join-Path $workDir 'diag-main.log') -Encoding UTF8
        "No $ProfileName application log directory found: $logRoot" | Add-Content -LiteralPath (Join-Path $workDir 'diag-renderer.log') -Encoding UTF8
        return
    }

    $latest = Get-ChildItem -LiteralPath $logRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
        "No log session directory found under: $logRoot" | Add-Content -LiteralPath (Join-Path $workDir 'diag-main.log') -Encoding UTF8
        "No log session directory found under: $logRoot" | Add-Content -LiteralPath (Join-Path $workDir 'diag-renderer.log') -Encoding UTF8
        return
    }

    foreach ($logName in @('main.log', 'renderer.log')) {
        $source = Join-Path $latest.FullName $logName
        $destination = Join-Path $workDir ("diag-" + $logName)
        "=== $ProfileName - $($latest.Name) ===" | Add-Content -LiteralPath $destination -Encoding UTF8
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Get-Content -LiteralPath $source -Raw | Add-Content -LiteralPath $destination -Encoding UTF8
        } else {
            "Not present: $source" | Add-Content -LiteralPath $destination -Encoding UTF8
        }
    }
}
Copy-LatestApplicationLog -ProfileName 'Albion'
Copy-LatestApplicationLog -ProfileName 'VSCodium'

$setupLog = Join-Path $workDir 'diag-setup.log'
$latestSetupLog = Get-ChildItem -Path (Join-Path $env:TEMP 'Setup Log *.txt') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestSetupLog) {
    Copy-Item -LiteralPath $latestSetupLog.FullName -Destination $setupLog -Force
    "Copied newest installer log: $($latestSetupLog.FullName)" | Add-Content -LiteralPath $setupLog -Encoding UTF8
} else {
    'No Inno Setup log matching %TEMP%\Setup Log *.txt was found.' | Set-Content -LiteralPath $setupLog -Encoding UTF8
}

$eventLog = Join-Path $workDir 'diag-eventviewer.log'
$query = '*[System[Level=2 and TimeCreated[timediff(@SystemTime) <= 86400000]]]'
try {
    & wevtutil.exe qe Application "/q:$query" /c:30 /f:text 2>&1 | Out-File -LiteralPath $eventLog -Encoding UTF8
} catch {
    "Could not query the Application event log: $_" | Set-Content -LiteralPath $eventLog -Encoding UTF8
}

$defenderLog = Join-Path $workDir 'diag-defender.log'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    "Running as administrator: $isAdministrator" | Set-Content -LiteralPath $defenderLog -Encoding UTF8
    if (-not $isAdministrator) {
        'Non-administrator run: Defender threat details or preferences may be unavailable.' | Add-Content -LiteralPath $defenderLog -Encoding UTF8
    }
    try {
        '=== Get-MpThreatDetection ===' | Add-Content -LiteralPath $defenderLog -Encoding UTF8
        Get-MpThreatDetection | Format-List * | Out-String -Width 300 | Add-Content -LiteralPath $defenderLog -Encoding UTF8
    } catch {
        "Get-MpThreatDetection unavailable or denied: $_" | Add-Content -LiteralPath $defenderLog -Encoding UTF8
    }
    try {
        '=== Get-MpPreference ExclusionPath ===' | Add-Content -LiteralPath $defenderLog -Encoding UTF8
        Get-MpPreference | Select-Object -ExpandProperty ExclusionPath | Out-String -Width 300 | Add-Content -LiteralPath $defenderLog -Encoding UTF8
    } catch {
        "Get-MpPreference unavailable or denied: $_" | Add-Content -LiteralPath $defenderLog -Encoding UTF8
    }
} catch {
    "Defender diagnostics unavailable: $_" | Set-Content -LiteralPath $defenderLog -Encoding UTF8
}

$vcredistLog = Join-Path $workDir 'diag-vcredist.log'
try {
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    $runtime = $registry.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64')
    if ($runtime) {
        "Installed: $($runtime.GetValue('Installed', 0))" | Set-Content -LiteralPath $vcredistLog -Encoding UTF8
        foreach ($valueName in @('Version', 'Major', 'Minor', 'Bld', 'Rbld')) {
            "$valueName`: $($runtime.GetValue($valueName, '(missing)'))" | Add-Content -LiteralPath $vcredistLog -Encoding UTF8
        }
        $runtime.Dispose()
    } else {
        'Visual C++ 2015-2022 x64 runtime registry key is missing.' | Set-Content -LiteralPath $vcredistLog -Encoding UTF8
    }
    $registry.Dispose()
} catch {
    "Could not read the Visual C++ runtime registry key: $_" | Set-Content -LiteralPath $vcredistLog -Encoding UTF8
}

$gpuLog = Join-Path $workDir 'diag-gpu.log'
try {
    if (Get-Command wmic.exe -ErrorAction SilentlyContinue) {
        & wmic.exe path win32_VideoController get name,driverversion,status 2>&1 | Out-File -LiteralPath $gpuLog -Encoding UTF8
    } else {
        'wmic.exe is unavailable; using Get-CimInstance instead.' | Set-Content -LiteralPath $gpuLog -Encoding UTF8
        Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, Status | Format-List | Out-String -Width 300 | Add-Content -LiteralPath $gpuLog -Encoding UTF8
    }
} catch {
    "Could not collect GPU details: $_" | Set-Content -LiteralPath $gpuLog -Encoding UTF8
}

$systemLog = Join-Path $workDir 'diag-system.log'
try {
    '=== OS and memory (systeminfo) ===' | Set-Content -LiteralPath $systemLog -Encoding UTF8
    & systeminfo.exe | Select-String -Pattern 'OS|Memory' | Out-String -Width 300 | Add-Content -LiteralPath $systemLog -Encoding UTF8
    '=== OS build and physical memory ===' | Add-Content -LiteralPath $systemLog -Encoding UTF8
    Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, TotalVisibleMemorySize, FreePhysicalMemory | Format-List | Out-String -Width 300 | Add-Content -LiteralPath $systemLog -Encoding UTF8
    '=== C: free disk ===' | Add-Content -LiteralPath $systemLog -Encoding UTF8
    Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object DeviceID, Size, FreeSpace | Format-List | Out-String -Width 300 | Add-Content -LiteralPath $systemLog -Encoding UTF8
} catch {
    "Could not collect complete system information: $_" | Add-Content -LiteralPath $systemLog -Encoding UTF8
}

Compress-Archive -Path (Join-Path $workDir '*') -DestinationPath $zipPath -Force
Write-Host ''
Write-Host 'SEND THE albion-diag ZIP ON YOUR DESKTOP' -ForegroundColor Green
Write-Host $zipPath
Read-Host 'Press Enter to close'
