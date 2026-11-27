[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$')]
    [string]$Model = 'qwen2.5-1.5b-instruct',
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$protocolSubKey = 'Software\Classes\uniflow-local-ai'
$protocolKey = "HKCU:\$protocolSubKey"
$handlerId = 'UniFlow.LocalAiPreview'
$existingHandler = Get-Item -LiteralPath $protocolKey -ErrorAction SilentlyContinue
if ($existingHandler -and $existingHandler.GetValue('UniFlowHandler') -ne $handlerId) {
    throw 'uniflow-local-ai is registered by another application for this Windows user.'
}

if ($Uninstall) {
    if ($existingHandler) {
        Remove-Item -LiteralPath $existingHandler.PSPath -Recurse -Force
    }
    Write-Output 'UniFlow Local AI URL handler removed.'
    return
}

$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$node) {
    throw 'Install Node.js and make node.exe available on PATH.'
}
$lms = Get-Command lms.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$lmsPath = if ($lms) { $lms.Source } else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.lmstudio\bin\lms.exe'
}
if (!(Test-Path -LiteralPath $lmsPath -PathType Leaf)) {
    throw 'Install the LM Studio CLI or make lms.exe available on PATH.'
}

$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$launcher = Join-Path $PSScriptRoot 'start-local-ai.ps1'
$runner = Join-Path $PSScriptRoot 'local-ai-session.mjs'
foreach ($file in @($powershell, $launcher, $runner)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required UniFlow launcher file not found: $file"
    }
}

$command = '"{0}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{1}" "%1"' -f $powershell, $launcher
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolSubKey)
try {
    $key.SetValue('', 'URL:UniFlow Local AI')
    $key.SetValue('URL Protocol', '')
    $key.SetValue('UniFlowHandler', $handlerId)
    $key.SetValue('NodePath', $node.Source)
    $key.SetValue('LmsPath', $lmsPath)
    $key.SetValue('Model', $Model)

    $commandKey = $key.CreateSubKey('shell\open\command')
    try {
        $commandKey.SetValue('', $command)
    } finally {
        $commandKey.Dispose()
    }
} finally {
    $key.Dispose()
}
Write-Output 'UniFlow Local AI URL handler registered for this Windows user.'
