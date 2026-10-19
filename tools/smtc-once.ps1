# AuraDesk - read Windows System Media Transport Controls (SMTC)
# Emits one compact JSON object per line. ASCII only on purpose:
# Windows PowerShell 5.1 parses .ps1 as ANSI when there is no BOM, so keep it ASCII.

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
} catch {
  '{"error":"winrt-unavailable"}'
  exit 1
}

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  '{"error":"manager-unavailable"}'
  exit 1
}

'{"ready":true}'

# PowerShell 5.1 cannot cast the WinRT __ComObject to IInputStream directly,
# so bind the AsStreamForRead(IInputStream) overload through reflection once.
$asStreamForRead = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
} catch {}

function Read-ThumbBytes($ref) {
  if ($null -eq $ref -or $null -eq $asStreamForRead) { return $null }
  $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  if ($null -eq $stream) { return $null }
  $net = $asStreamForRead.Invoke($null, @($stream))
  if ($null -eq $net) { return $null }
  $ms = New-Object System.IO.MemoryStream
  $net.CopyTo($ms)
  $net.Dispose()
  $bytes = $ms.ToArray()
  $ms.Dispose()
  if ($bytes.Length -gt 0 -and $bytes.Length -lt 6000000) { return $bytes }
  return $null
}

# Prefer a music player over whatever happens to be the "current" session
# (e.g. a browser tab playing video while Listen1 is the real music source).
$preferPattern = 'listen1'

function Pick-Session($mgr) {
  $sessions = @($mgr.GetSessions())
  if ($sessions.Count -eq 0) { return $null }
  $preferred = @($sessions | Where-Object { $_.SourceAppUserModelId -match $preferPattern })
  if ($preferred.Count -gt 0) { return $preferred[0] }
  foreach ($x in $sessions) {
    try {
      if ($x.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { return $x }
    } catch {}
  }
  return $mgr.GetCurrentSession()
}

$lastKey = ''
for ($i = 0; $i -lt 1; $i++) {
  $out = [ordered]@{ ok = $true }
  $s = $null
  try { $s = Pick-Session $mgr } catch { $s = $null }

  if ($null -eq $s) {
    $out.none = $true
    $lastKey = ''
  } else {
    try {
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()

      $out.app = [string]$s.SourceAppUserModelId
      $out.title = [string]$props.Title
      $out.artist = [string]$props.Artist
      $out.album = [string]$props.AlbumTitle
      $out.status = [string]$info.PlaybackStatus
      $out.playing = ($info.PlaybackStatus.ToString() -eq 'Playing')
      $out.position = [math]::Round($tl.Position.TotalSeconds, 2)
      $out.duration = [math]::Round($tl.EndTime.TotalSeconds, 2)

      $key = "$($out.title)|$($out.artist)"
      if ($key -ne $lastKey) {
        $lastKey = $key
        $out.changed = $true
        try {
          $bytes = Read-ThumbBytes $props.Thumbnail
          if ($null -ne $bytes) { $out.thumb = [Convert]::ToBase64String($bytes) }
        } catch {
          $out.thumbError = 1
        }
      }
    } catch {
      $out.error = 'session-read-failed'
    }
  }

  $out | ConvertTo-Json -Compress
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 800
}
