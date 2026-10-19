# AuraDesk - resolve Windows shortcuts (.lnk) to their launch targets
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI when there is no BOM.
#
#   powershell -File lnk-resolve.ps1 <input-list.txt>
#
# input  : one .lnk path per line (UTF-8)
# output : one JSON object per line  {"ok":true,"path":..,"target":..,"args":..,"dir":..}
param([string]$listFile)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not $listFile -or -not (Test-Path $listFile)) { '{"error":"no-input"}'; exit 0 }

$sh = New-Object -ComObject WScript.Shell
$lines = @(Get-Content -LiteralPath $listFile -Encoding UTF8)
foreach ($raw in $lines) {
  # Get-Content decorates each string with PSPath/ReadCount note properties,
  # which ConvertTo-Json would serialise as an object. Cast back to a plain string.
  $p = [string]$raw
  if (-not $p) { continue }
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $o = [ordered]@{ ok = $true; path = $p; target = ''; args = ''; dir = '' }
  try {
    $sc = $sh.CreateShortcut($p)
    $o.target = [string]$sc.TargetPath
    $o.args = [string]$sc.Arguments
    $o.dir = [string]$sc.WorkingDirectory
  } catch {
    $o.ok = $false
  }
  $o | ConvertTo-Json -Compress
}
[Console]::Out.Flush()
