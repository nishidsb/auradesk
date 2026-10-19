# AuraDesk - send a control command to the current SMTC session
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI when there is no BOM.
#
# Two modes:
#   1) one-shot : powershell -File smtc-ctl.ps1 toggle
#   2) resident : powershell -File smtc-ctl.ps1   (reads commands from stdin, one per line)
#
# The resident mode avoids paying the ~300-500 ms PowerShell startup cost on
# every button press, so the desktop layer feels instant.
param([string]$action = '')

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

# Resolve the preferred session each time: the user may switch players mid-flight.
function Get-Target {
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($mgr.GetSessions())
  $preferred = @($sessions | Where-Object { $_.SourceAppUserModelId -match 'listen1' })
  if ($preferred.Count -gt 0) { return $preferred[0] }
  foreach ($x in $sessions) {
    try { if ($x.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { return $x } } catch {}
  }
  return $mgr.GetCurrentSession()
}

function Invoke-Cmd([string]$cmd) {
  try {
    $s = Get-Target
    if ($null -eq $s) { return '{"ok":false,"reason":"no-session"}' }
    # seek <ticks> : 100-nanosecond units, needs Windows 10 1809+
    if ($cmd -like 'seek *') {
      $ticks = [long](($cmd -split ' ', 2)[1])
      if ($ticks -lt 0) { $ticks = 0 }
      $r = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
      if ($r) { return '{"ok":true}' }
      return '{"ok":false,"reason":"seek-rejected"}'
    }
    switch ($cmd) {
      'toggle' { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
      'play'   { Await ($s.TryPlayAsync()) ([bool]) | Out-Null }
      'pause'  { Await ($s.TryPauseAsync()) ([bool]) | Out-Null }
      'next'   { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null }
      'prev'   { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null }
      'status' { return '{"ok":true}' }
      default  { return '{"ok":false,"reason":"unknown-command"}' }
    }
    return '{"ok":true}'
  } catch {
    return '{"ok":false,"reason":"exception"}'
  }
}

if ($action -ne '') {
  Invoke-Cmd $action
  exit 0
}

# ---- resident mode -----------------------------------------------------------
'{"ready":true}'
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim().ToLower()
  if ($cmd -eq '') { continue }
  if ($cmd -eq 'quit' -or $cmd -eq 'exit') { break }
  Invoke-Cmd $cmd
  [Console]::Out.Flush()
}
