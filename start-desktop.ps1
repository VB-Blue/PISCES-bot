[CmdletBinding()]
param([switch]$Inspect)

$ErrorActionPreference = 'Stop'
$desktopRoot = $PSScriptRoot
$desktopVersion = (Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
$packagedExe = Join-Path $desktopRoot "release\pisces-ai-v$desktopVersion\win-unpacked\PISCES AI.exe"
$developmentExe = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'

if ($Inspect) {
    [pscustomobject]@{ executable = $packagedExe; version = $desktopVersion; mode = 'automatic-handoff' } | ConvertTo-Json
    return
}

if (Test-Path -LiteralPath $packagedExe) {
    $launchProcess = Start-Process -FilePath $packagedExe -ArgumentList @('--desktop-launcher', ('--workspace-root="' + $desktopRoot + '"')) -WorkingDirectory (Split-Path -Parent $packagedExe) -WindowStyle Hidden -PassThru
} elseif ((Test-Path -LiteralPath $developmentExe) -and (Test-Path -LiteralPath (Join-Path $desktopRoot 'dist\index.html'))) {
    $launchProcess = Start-Process -FilePath $developmentExe -ArgumentList @(('"' + $desktopRoot + '"'), '--desktop-launcher', ('--workspace-root="' + $desktopRoot + '"')) -WorkingDirectory $desktopRoot -WindowStyle Hidden -PassThru
} else {
    throw 'PISCES AI 尚未构建。请在此目录运行 npm install，然后运行 npm run pack:core。'
}
$launchProcess.WaitForExit()
if ($launchProcess.ExitCode) { exit $launchProcess.ExitCode }
