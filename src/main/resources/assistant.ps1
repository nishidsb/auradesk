# AuraDesk assistant - resident PowerShell worker
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI when there is no BOM.
#
# Resident mode (stdin commands, one JSON line per reply on stdout):
#   scan          -> {"type":"windows","list":[{h,t,pn,pp,min,fg,r:[x,y,w,h]}]}
#   toggle <hwnd> -> activate / minimize a window (AttachThreadInput focus steal)
#   vol <0-100>   -> {"type":"vol","v":n,"m":bool}
#   mute          -> toggle mute, replies vol
#   devs          -> {"type":"devs","d":{"out":[{id,name}],"in":[...],"cur":id,"curIn":id}}
#   setout <id> / setin <id> -> switch default audio device, replies with devs
#   desk          -> toggle "show desktop"
#   shot <hwnd> <path> <reqid> -> {"type":"shot","id":reqid,"ok":bool,"path":..,"w":..,"h":..,"t":title}
#   quit          -> exit
param()

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$code = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace Aura {
  public static class W32 {
    public delegate bool EnumProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  }

  // Window snapshot for hover bubble preview (PrintWindow with PW_RENDERFULLCONTENT
  // captures DWM-composed content of GPU-rendered windows like Chrome / Edge).
  // maxW > 0 downscales before PNG encode: the edge bar refreshes many windows
  // at once, full-size encoding would cost hundreds of ms per frame.
  public static class Shot {
    public static object Capture(IntPtr h, string path, int maxW) {
      try {
        if (W32.IsIconic(h)) return new System.Collections.Generic.Dictionary<string, object> { { "ok", false }, { "err", "minimized" } };
        W32.RECT r;
        if (!W32.GetWindowRect(h, out r)) return new System.Collections.Generic.Dictionary<string, object> { { "ok", false }, { "err", "rect" } };
        int w = r.R - r.L; int hh = r.B - r.T;
        if (w <= 0 || hh <= 0) return new System.Collections.Generic.Dictionary<string, object> { { "ok", false }, { "err", "size" } };
        using (var bmp = new System.Drawing.Bitmap(w, hh)) {
          using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            W32.PrintWindow(h, hdc, 2); // PW_RENDERFULLCONTENT
            g.ReleaseHdc(hdc);
          }
          if (maxW > 0 && w > maxW) {
            int tw = maxW; int th = Math.Max(1, hh * maxW / w);
            using (var thumb = new System.Drawing.Bitmap(bmp, tw, th)) {
              thumb.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
            w = tw; hh = th;
          } else {
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
          }
        }
        return new System.Collections.Generic.Dictionary<string, object> { { "ok", true }, { "w", w }, { "h", hh } };
      } catch (Exception e) {
        return new System.Collections.Generic.Dictionary<string, object> { { "ok", false }, { "err", e.GetType().Name } };
      }
    }
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n);
    int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float db, Guid g);
    int SetMasterVolumeLevelScalar(float lv, Guid g);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float lv);
    int SetChannelVolumeLevel(uint ch, float db, Guid g);
    int SetChannelVolumeLevelScalar(uint ch, float lv, Guid g);
    int GetChannelVolumeLevel(uint ch, out float db);
    int GetChannelVolumeLevelScalar(uint ch, out float lv);
    int SetMute(int m, Guid g);
    int GetMute(out int m);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int stgm, out IPropertyStore ps);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int s);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    int Count(out uint c);
    int Item(uint i, out IMMDevice d);
  }

  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Sequential)] public struct PROPVARIANT {
    public ushort vt; public ushort r1; public ushort r2; public ushort r3;
    public IntPtr p;
  }

  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PROPERTYKEY k);
    int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
  }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int f, int m, out IMMDeviceCollection c);
    int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d);
  }

  // Undocumented policy API: switch system default audio device (as SoundSwitch does)
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    int GetMixFormat(IntPtr a, IntPtr b);
    int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    int ResetDeviceFormat(IntPtr a);
    int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    int SetProcessingPeriod(IntPtr a, IntPtr b);
    int GetShareMode(IntPtr a, IntPtr b);
    int SetShareMode(IntPtr a, IntPtr b);
    int GetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    int SetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string a, int b);
    int SetEndpointVisibility(IntPtr a, int b);
  }

  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  public class CPolicyConfigClient { }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorCom { }

  public static class Vol {
    static IAudioEndpointVolume EP() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDevice d;
      en.GetDefaultAudioEndpoint(0, 1, out d);
      var iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      d.Activate(ref iid, 23, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }
    public static int Get() { float v; EP().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100f); }
    public static bool GetMute() { int m; EP().GetMute(out m); return m != 0; }
    public static void Set(int v) { float f = Math.Max(0, Math.Min(100, v)) / 100f; EP().SetMasterVolumeLevelScalar(f, Guid.Empty); }
    public static void SetMute(bool b) { EP().SetMute(b ? 1 : 0, Guid.Empty); }
  }

  public static class Dev {
    static Guid NameFmt = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); // PKEY_Device_FriendlyName

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);

    static string NameOf(IMMDevice d) {
      try {
        IPropertyStore ps; d.OpenPropertyStore(0, out ps);
        var k = new PROPERTYKEY(); k.fmtid = NameFmt; k.pid = 14;
        PROPVARIANT v; ps.GetValue(ref k, out v);
        string s = (v.vt == 31 && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : ""; // VT_LPWSTR
        if (v.p != IntPtr.Zero) PropVariantClear(ref v);
        return s ?? "";
      } catch { return ""; }
    }

    static System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>> Enum(int flow) {
      var list = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, string>>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDeviceCollection c; en.EnumAudioEndpoints(flow, 1, out c); // DEVICE_STATE_ACTIVE
      uint n; c.Count(out n);
      for (uint i = 0; i < n; i++) {
        IMMDevice d; c.Item(i, out d);
        string id; d.GetId(out id);
        var dic = new System.Collections.Generic.Dictionary<string, string>();
        dic["id"] = id; dic["name"] = NameOf(d);
        list.Add(dic);
      }
      return list;
    }

    public static object List() {
      var o = Enum(0); // eRENDER
      var i = Enum(1); // eCAPTURE
      string cur = ""; string curIn = "";
      try {
        var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        IMMDevice d; string id;
        en.GetDefaultAudioEndpoint(0, 1, out d); d.GetId(out id); cur = id;
        en.GetDefaultAudioEndpoint(1, 1, out d); d.GetId(out id); curIn = id;
      } catch {}
      var res = new System.Collections.Generic.Dictionary<string, object>();
      res["out"] = o; res["in"] = i; res["cur"] = cur; res["curIn"] = curIn;
      return res;
    }

    public static void SetDefault(string id) {
      var pc = (IPolicyConfig)(new CPolicyConfigClient());
      pc.SetDefaultEndpoint(id, 0); // eCONSOLE
      pc.SetDefaultEndpoint(id, 1); // eMULTIMEDIA
    }
  }
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

# System shell windows we never want in the app list
$hostProc = @('SearchHost','StartMenuExperienceHost','ShellExperienceHost','Widgets','WidgetService','TextInputModuleHost','ShellHost')
$badClass = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','Windows.UI.Core.CoreWindow','XamlExplorerHostIslandWindow')

$skipPid = 0
if ($env:AURA_PID) { try { $skipPid = [int]$env:AURA_PID } catch {} }

function Get-WinList {
  $list = New-Object System.Collections.ArrayList
  $fg = [Aura.W32]::GetForegroundWindow()
  $pCache = @{}
  $cb = {
    param([IntPtr]$h, [IntPtr]$lp)
    try {
      if (-not [Aura.W32]::IsWindowVisible($h)) { return $true }
      $ex = [Aura.W32]::GetWindowLongW($h, -20)
      if (($ex -band 0x80) -ne 0) { return $true } # WS_EX_TOOLWINDOW
      $sb = New-Object System.Text.StringBuilder 512
      [Aura.W32]::GetWindowTextW($h, $sb, 512) | Out-Null
      $title = $sb.ToString().Trim()
      if (-not $title) { return $true }
      $sb2 = New-Object System.Text.StringBuilder 256
      [Aura.W32]::GetClassNameW($h, $sb2, 256) | Out-Null
      $cls = $sb2.ToString()
      if ($badClass -contains $cls) { return $true }
      $cloak = 0
      if ([Aura.W32]::DwmGetWindowAttribute($h, 14, [ref]$cloak, 4) -eq 0 -and $cloak -ne 0) { return $true }
      $r = New-Object Aura.W32+RECT
      if (-not [Aura.W32]::GetWindowRect($h, [ref]$r)) { return $true }
      $w = $r.R - $r.L; $hh = $r.B - $r.T
      if ($w -le 0 -or $hh -le 0) { return $true }
      $procId = 0
      [Aura.W32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      if ($procId -eq $skipPid) { return $true }
      $pn = ''; $pp = ''
      if ($pCache.ContainsKey($procId)) {
        $pn = $pCache[$procId][0]; $pp = $pCache[$procId][1]
      } else {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) { $pn = $p.Name; $pp = $p.Path }
        $pCache[$procId] = @($pn, $pp)
      }
      if ($hostProc -contains $pn) { return $true }
      [void]$list.Add(@{
        h = [int64]$h
        t = $title
        pn = $pn
        pp = $pp
        min = [bool][Aura.W32]::IsIconic($h)
        fg = ($h -eq $fg)
        r = @($r.L, $r.T, $w, $hh)
      })
    } catch {}
    return $true
  }
  [Aura.W32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  # process name list (for tray-only / windowless running apps)
  $procs = @()
  try { $procs = @(Get-Process | ForEach-Object { $_.Name.ToLower() } | Sort-Object -Unique) } catch {}
  return @{ type = 'windows'; list = $list; procs = $procs } | ConvertTo-Json -Compress -Depth 4
}

function Out-Vol {
  try {
    $v = [Aura.Vol]::Get()
    $m = [Aura.Vol]::GetMute()
    @{ type = 'vol'; v = $v; m = $m } | ConvertTo-Json -Compress
  } catch { '{"type":"vol","v":null,"m":false}' }
}

function Out-Devs {
  try { @{ type = 'devs'; d = [Aura.Dev]::List() } | ConvertTo-Json -Compress -Depth 5 }
  catch { '{"type":"devs","d":{"out":[],"in":[],"cur":"","curIn":""}}' }
}

function Invoke-Cmd([string]$cmd) {
  try {
    if ($cmd -eq 'scan') { return Get-WinList }
    if ($cmd -like 'vol *') {
      [Aura.Vol]::Set([int](($cmd -split ' ', 2)[1]))
      return Out-Vol
    }
    if ($cmd -eq 'mute') {
      [Aura.Vol]::SetMute(-not [Aura.Vol]::GetMute())
      return Out-Vol
    }
    if ($cmd -eq 'devs') { return Out-Devs }
    if ($cmd -like 'setout *') {
      [Aura.Dev]::SetDefault((($cmd -split ' ', 2)[1]))
      return Out-Devs
    }
    if ($cmd -like 'setin *') {
      [Aura.Dev]::SetDefault((($cmd -split ' ', 2)[1]))
      return Out-Devs
    }
    if ($cmd -eq 'desk') {
      $sh = New-Object -ComObject Shell.Application
      $sh.ToggleDesktop()
      return '{"ok":true}'
    }
    if ($cmd -like 'shot *') {
      # shot <hwnd> <path> <reqid> -> {"type":"shot","id":reqid,"ok":bool,...}
      # Minimized windows cannot be printed: fall back to the cached last frame
      # (kept fresh by every successful shot and by toggle before minimizing).
      $parts = ($cmd -split ' ', 3)
      $h = [IntPtr][int64]$parts[1]
      $path = $parts[2]
      $reqid = ''
      $li = $path.LastIndexOf(' ')
      if ($li -gt 0) { $reqid = $path.Substring($li + 1); $path = $path.Substring(0, $li) }
      $cached = $false
      if ([Aura.W32]::IsIconic($h)) {
        $dir = Split-Path -Parent $path
        $last = Join-Path $dir ('last-w' + [int64]$h + '.png')
        if (Test-Path $last) {
          $path = $last; $cached = $true
          $o = @{ type = 'shot'; id = $reqid; ok = $true; cached = $true; path = $path }
          $sb3 = New-Object System.Text.StringBuilder 512
          [Aura.W32]::GetWindowTextW($h, $sb3, 512) | Out-Null
          $o['t'] = $sb3.ToString()
          $img = [System.Drawing.Image]::FromFile($last)
          $o['w'] = $img.Width; $o['h'] = $img.Height
          $img.Dispose()
          return $o | ConvertTo-Json -Compress -Depth 3
        }
      }
      $res = [Aura.Shot]::Capture($h, $path, 440)
      $o = @{ type = 'shot'; id = $reqid; ok = $res.ok }
      if ($res.ok) {
        try {
          $dir = Split-Path -Parent $path
          Copy-Item $path (Join-Path $dir ('last-w' + [int64]$h + '.png')) -Force
        } catch {}
        $sb3 = New-Object System.Text.StringBuilder 512
        [Aura.W32]::GetWindowTextW($h, $sb3, 512) | Out-Null
        $o['path'] = $path; $o['w'] = $res.w; $o['h'] = $res.h; $o['t'] = $sb3.ToString()
      } else { $o['err'] = $res.err }
      return $o | ConvertTo-Json -Compress -Depth 3
    }
    if ($cmd -like 'toggle *') {
      $h = [IntPtr][int64](($cmd -split ' ', 2)[1])
      # stale/reused-hwnd guard: never touch a dead or hidden handle
      # (SwitchToThisWindow on a recycled hwnd can bring an unrelated window
      # to the front and flash the taskbar red with no notification)
      if (-not [Aura.W32]::IsWindow($h) -or -not [Aura.W32]::IsWindowVisible($h)) {
        return ('{"ok":false,"act":false,"err":"stale or invisible hwnd ' + [int64]$h + '"}')
      }
      # already foreground and not minimized -> minimize (task switcher habit)
      if (-not [Aura.W32]::IsIconic($h) -and $h -eq [Aura.W32]::GetForegroundWindow()) {
        # keep a last frame so the hover bubble can still preview it while minimized
        # (path is resolved relative to the shots dir chosen by the main process)
        try {
          $lastDir = Join-Path $env:APPDATA 'AuraDesk\shots'
          if (Test-Path $lastDir) {
            [Aura.Shot]::Capture($h, (Join-Path $lastDir ('last-w' + [int64]$h + '.png')), 440) | Out-Null
          }
        } catch {}
        [Aura.W32]::ShowWindow($h, 6) | Out-Null # SW_MINIMIZE
        return '{"ok":true,"act":true}'
      }
      if ([Aura.W32]::IsIconic($h)) { [Aura.W32]::ShowWindow($h, 9) | Out-Null } # SW_RESTORE
      # A background process cannot steal focus directly: SetForegroundWindow gets
      # rejected. Temporarily attach our input thread to the current foreground
      # thread and the target thread, then bring the target window to front.
      $fg = [Aura.W32]::GetForegroundWindow()
      $my = [Aura.W32]::GetCurrentThreadId()
      $p1 = [uint32]0; $fgT = [Aura.W32]::GetWindowThreadProcessId($fg, [ref]$p1)
      $p2 = [uint32]0; $tgT = [Aura.W32]::GetWindowThreadProcessId($h, [ref]$p2)
      if ($fg -ne $h -and $fgT -ne 0) { [void][Aura.W32]::AttachThreadInput($my, $fgT, $true) }
      if ($tgT -ne 0 -and $tgT -ne $my) { [void][Aura.W32]::AttachThreadInput($my, $tgT, $true) }
      [void][Aura.W32]::BringWindowToTop($h)
      [void][Aura.W32]::SetForegroundWindow($h)
      if ($tgT -ne 0 -and $tgT -ne $my) { [void][Aura.W32]::AttachThreadInput($my, $tgT, $false) }
      if ($fg -ne $h -and $fgT -ne 0) { [void][Aura.W32]::AttachThreadInput($my, $fgT, $false) }
      $act = ([Aura.W32]::GetForegroundWindow() -eq $h)
      if (-not $act) {
        [Aura.W32]::SwitchToThisWindow($h, $true) # last resort
        Start-Sleep -Milliseconds 100
        $act = ([Aura.W32]::GetForegroundWindow() -eq $h)
      }
      $actStr = 'false'; if ($act) { $actStr = 'true' }
      return ('{"ok":true,"act":' + $actStr + '}')
    }
  } catch {
    @{ ok = $false; err = "$($_.Exception.GetType().Name): $($_.Exception.Message)" } | ConvertTo-Json -Compress
  }
  return '{"ok":false}'
}

# ---- resident loop -----------------------------------------------------------
Out-Vol
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()
  if ($cmd -eq '') { continue }
  if ($cmd -eq 'quit' -or $cmd -eq 'exit') { break }
  Invoke-Cmd $cmd
  [Console]::Out.Flush()
}
