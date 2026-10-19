# AuraDesk · 从 exe / lnk / url 快捷方式里抠出程序自己的图标
# 用法：powershell -File icon-dump.ps1 -Job <job.json>
# job.json: { "size": 256, "items": [ { "id": "g_x", "src": "C:\\a\\b.exe", "out": "C:\\cache\\x.png" } ] }
# 逐行输出 JSON：{ "id": "...", "ok": true, "w": 256, "h": 256 }
param(
  [Parameter(Mandatory = $true)][string]$Job,
  [int]$Size = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('AuraShellIcon' -as [type])) {
  $cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AuraShellIcon
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

    [Flags]
    public enum SIIGBF
    {
        RESIZETOFIT = 0x00,
        BIGGERSIZEOK = 0x01,
        MEMORYONLY = 0x02,
        ICONONLY = 0x04,
        THUMBNAILONLY = 0x08,
        INCACHEONLY = 0x10
    }

    [ComImport]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory
    {
        void GetImage(SIZE size, SIIGBF flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr hObject);

    // 拿到 256×256 的大图标（exe 里嵌的最大一帧），失败返回 null
    public static Image Get(string path, int size)
    {
        IntPtr hbm = IntPtr.Zero;
        try
        {
            IShellItemImageFactory f;
            SHCreateItemFromParsingName(path, IntPtr.Zero,
                new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), out f);
            f.GetImage(new SIZE(size, size), SIIGBF.ICONONLY | SIIGBF.BIGGERSIZEOK, out hbm);
            if (hbm == IntPtr.Zero) return null;
            using (var tmp = Image.FromHbitmap(hbm))
            {
                return new Bitmap(tmp);
            }
        }
        catch { return null; }
        finally { if (hbm != IntPtr.Zero) DeleteObject(hbm); }
    }
}
'@
  Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing
}

$data = Get-Content -Raw -Encoding UTF8 $Job | ConvertFrom-Json
$size = if ($data.size) { [int]$data.size } else { $Size }

foreach ($it in $data.items) {
  $out = @{ id = $it.id; ok = $false }
  try {
    $src = [string]$it.src
    $dst = [string]$it.out
    if (-not (Test-Path -LiteralPath $src)) { $out.err = 'src missing'; }
    else {
      $img = [AuraShellIcon]::Get($src, $size)
      if ($img -eq $null) {
        # 某些 shell 项（ms-settings: 之类）拿不到，退回 AssociatedIcon 小图再放大
        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
        if ($ico -ne $null) {
          $img = New-Object System.Drawing.Bitmap($size, $size)
          $g = [System.Drawing.Graphics]::FromImage($img)
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.DrawImage($ico.ToBitmap(), 0, 0, $size, $size)
          $g.Dispose()
        }
      }
      if ($img -ne $null) {
        $dir = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $img.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
        $out.ok = $true
        $out.w = $img.Width
        $out.h = $img.Height
        $img.Dispose()
      } else { $out.err = 'no icon' }
    }
  } catch { $out.err = $_.Exception.Message }
  $out | ConvertTo-Json -Compress -Depth 3
}
