Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The URI is untrusted. Check it before opening any files or starting a process.
if ($args.Count -ne 1 -or $args[0] -cnotin @('uniflow-local-ai://preview', 'uniflow-local-ai://preview/')) {
    exit 2
}

$settings = Get-Item -LiteralPath 'HKCU:\Software\Classes\uniflow-local-ai'
if ($settings.GetValue('UniFlowHandler') -ne 'UniFlow.LocalAiPreview') {
    exit 2
}

$env:UNIFLOW_BIONIC_MODEL = $settings.GetValue('Model')
$env:UNIFLOW_LMS_PATH = $settings.GetValue('LmsPath')
$runner = Join-Path $PSScriptRoot 'local-ai-session.mjs'
Start-Process -FilePath ($settings.GetValue('NodePath')) `
    -ArgumentList ('"' + $runner + '"') `
    -WorkingDirectory (Split-Path -Parent $PSScriptRoot) `
    -WindowStyle Hidden
