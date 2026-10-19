// Real control of other Windows software: window discovery, screenshots, mouse, keyboard and UI Automation.
// One long-lived legacy Windows PowerShell host does the native calls. It needs
// the .NET Framework UIAutomation and System.Runtime.WindowsRuntime assemblies;
// this helper cannot run on the PowerShell 7/.NET runtime used by ordinary commands.
// Requests and replies are single JSON lines, with only one native request in flight.
const { spawn } = require('node:child_process');
const { writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Windows() {
    var list = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr p) { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(GetWindowTextLength(h) + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$script:elements = @{}
function Get-Info($h) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  $procId = [uint32]0; [W]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $name = ''; try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  [pscustomobject]@{ hwnd = [int64]$h; title = [W]::Title($h); process = $name; pid = [int]$procId; x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T; foreground = ([W]::GetForegroundWindow() -eq $h); minimized = [W]::IsIconic($h) }
}
function Find-Window($query, $hwnd) {
  if ($hwnd) { return [IntPtr][int64]$hwnd }
  $q = ([string]$query).ToLower()
  $best = $null; $bestArea = -1
  foreach ($h in [W]::Windows()) {
    $i = Get-Info $h
    if ($i.width -lt 40 -or $i.height -lt 40 -and -not $i.minimized) { continue }
    if ($i.title.ToLower().Contains($q) -or $i.process.ToLower().Contains($q)) { $area = $i.width * $i.height; if ($area -gt $bestArea) { $best = $h; $bestArea = $area } }
  }
  if ($best -eq $null) { throw "没有找到窗口：$query" }
  return $best
}
function Focus-Window($h) {
  if ([W]::IsIconic($h)) { [W]::ShowWindow($h, 9) | Out-Null }
  [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [W]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 350
  return ([W]::GetForegroundWindow() -eq $h)
}
$vk = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20; backspace = 0x08; delete = 0x2E; del = 0x2E; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22; insert = 0x2D }
for ($n = 1; $n -le 12; $n++) { $vk["f$n"] = 0x6F + $n }
function Send-Keys($spec) {
  $parts = ([string]$spec).ToLower().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $codes = @()
  foreach ($p in $parts) {
    if ($vk.ContainsKey($p)) { $codes += [byte]$vk[$p] }
    elseif ($p.Length -eq 1) { $codes += [byte][char]$p.ToUpper() }
    else { throw "不认识的按键：$p" }
  }
  foreach ($c in $codes) { [W]::keybd_event($c, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
  [array]::Reverse($codes)
  foreach ($c in $codes) { [W]::keybd_event($c, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
}
function Mouse-Click($x, $y, $button, $count) {
  [W]::SetCursorPos([int]$x, [int]$y) | Out-Null; Start-Sleep -Milliseconds 150
  $down = 0x2; $up = 0x4; if ($button -eq 'right') { $down = 0x8; $up = 0x10 } elseif ($button -eq 'middle') { $down = 0x20; $up = 0x40 }
  for ($i = 0; $i -lt $count; $i++) { [W]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70; [W]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
}
function Capture-Rect($rect) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = [Math]::Max([int]$rect.x, $vs.X); $y = [Math]::Max([int]$rect.y, $vs.Y)
  $w = [Math]::Min([int]$rect.x + [int]$rect.width, $vs.Right) - $x; $h = [Math]::Min([int]$rect.y + [int]$rect.height, $vs.Bottom) - $y
  if ($w -lt 8 -or $h -lt 8) { throw '窗口不在屏幕范围内' }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size); $g.Dispose()
  return @{ bmp = $bmp; x = $x; y = $y; w = $w; h = $h }
}
$palette = @('#E6194B', '#3CB44B', '#4363D8', '#F58231', '#911EB4', '#008080', '#9A6324', '#800000')
function Draw-Marks($cap, $marks) {
  $g = [System.Drawing.Graphics]::FromImage($cap.bmp)
  $font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  foreach ($m in $marks) {
    $color = [System.Drawing.ColorTranslator]::FromHtml($palette[$m.id % $palette.Count])
    $pen = New-Object System.Drawing.Pen $color, 2
    $rx = [int]($m.sx - $cap.x); $ry = [int]($m.sy - $cap.y)
    $g.DrawRectangle($pen, $rx, $ry, [int]$m.sw, [int]$m.sh)
    $size = $g.MeasureString([string]$m.id, $font)
    $brush = New-Object System.Drawing.SolidBrush $color
    $lx = [Math]::Max(0, $rx); $ly = [Math]::Max(0, $ry); if ($m.sw -gt 90) { $lx = [Math]::Max(0, $rx + [int]$m.sw - [int]$size.Width - 1) }
    $g.FillRectangle($brush, $lx, $ly, [int]$size.Width, [int]$size.Height)
    $g.DrawString([string]$m.id, $font, [System.Drawing.Brushes]::White, $lx, $ly)
    $pen.Dispose(); $brush.Dispose()
  }
  $font.Dispose(); $g.Dispose()
}
function Take-Screenshot($rect, $maxWidth, $marks) {
  $cap = Capture-Rect $rect
  if ($marks) { Draw-Marks $cap $marks }
  $bmp = $cap.bmp; $w = $cap.w; $h = $cap.h
  $mw = [double]$maxWidth; if ($mw -le 0) { $mw = 1280 }
  $scale = [Math]::Min(1.0, $mw / $w)
  $out = $bmp
  if ($scale -lt 1.0) { $out = New-Object System.Drawing.Bitmap ([int]($w * $scale)), ([int]($h * $scale)); $g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $out.Width, $out.Height); $g2.Dispose() }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 72L
  $ms = New-Object System.IO.MemoryStream; $out.Save($ms, $codec, $params)
  $result = @{ image = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($ms.ToArray()); originX = $cap.x; originY = $cap.y; scale = $scale; width = $out.Width; height = $out.Height }
  $bmp.Dispose(); if ($out -ne $bmp) { $out.Dispose() }
  return $result
}
$GRID = 64
function Get-Gray($rect) {
  $cap = Capture-Rect $rect
  $small = New-Object System.Drawing.Bitmap $GRID, $GRID
  $g = [System.Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBilinear'; $g.DrawImage($cap.bmp, 0, 0, $GRID, $GRID); $g.Dispose()
  $bytes = New-Object byte[] ($GRID * $GRID); $i = 0
  for ($yy = 0; $yy -lt $GRID; $yy++) { for ($xx = 0; $xx -lt $GRID; $xx++) { $p = $small.GetPixel($xx, $yy); $bytes[$i] = [byte](($p.R * 30 + $p.G * 59 + $p.B * 11) / 100); $i++ } }
  $small.Dispose(); $cap.bmp.Dispose()
  return ,$bytes
}
function Diff-Cells($a, $b) { $n = 0; for ($i = 0; $i -lt $a.Length; $i++) { if ([Math]::Abs([int]$a[$i] - [int]$b[$i]) -gt 10) { $n++ } }; return $n / [double]$a.Length }
$script:ocr = $null
function Init-Ocr {
  if ($script:ocr) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw '系统没有可用的 OCR 语言包（设置 → 时间和语言 → 语言和区域）' }
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
  $script:ocr = @{ engine = $engine; asTask = $method }
}
function Await-Op($op, $type) { $t = $script:ocr.asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; return $t.Result }
function Run-Ocr($rect) {
  Init-Ocr
  $cap = Capture-Rect $rect
  $factor = 1.0; if ($cap.w -lt 1100) { $factor = 2.0 }
  $bmp = $cap.bmp
  if ($factor -gt 1.0) { $big = New-Object System.Drawing.Bitmap ([int]($cap.w * $factor)), ([int]($cap.h * $factor)); $g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($bmp, 0, 0, $big.Width, $big.Height); $g.Dispose(); $bmp.Dispose(); $bmp = $big }
  $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $ms.Position = 0; $bmp.Dispose()
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-Op ($script:ocr.engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) {
    $words = @(); $minX = 1e9; $minY = 1e9; $maxX = 0; $maxY = 0
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect; $wx = $cap.x + $r.X / $factor; $wy = $cap.y + $r.Y / $factor; $ww = $r.Width / $factor; $wh = $r.Height / $factor
      $words += [pscustomobject]@{ text = $w.Text; x = [int]$wx; y = [int]$wy; w = [int]$ww; h = [int]$wh }
      $minX = [Math]::Min($minX, $wx); $minY = [Math]::Min($minY, $wy); $maxX = [Math]::Max($maxX, $wx + $ww); $maxY = [Math]::Max($maxY, $wy + $wh)
    }
    if ($words.Count -gt 0) { $lines += [pscustomobject]@{ text = $line.Text; x = [int]$minX; y = [int]$minY; w = [int]($maxX - $minX); h = [int]($maxY - $minY); words = $words } }
  }
  return $lines
}
function Get-CachedElements($hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @([System.Windows.Automation.AutomationElement]::NameProperty, [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty, [System.Windows.Automation.AutomationElement]::IsOffscreenProperty, [System.Windows.Automation.AutomationElement]::IsEnabledProperty, [System.Windows.Automation.AutomationElement]::AutomationIdProperty)) { $cr.Add($p) }
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $scope = $cr.Activate()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Automation]::ControlViewCondition) } finally { $scope.Dispose() }
  return $all
}
function Get-ElType($e) { return ([string]$e.Cached.ControlType.ProgrammaticName).Replace('ControlType.', '') }
$interactive = @('Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem', 'RadioButton', 'Slider', 'Spinner', 'SplitButton', 'TabItem', 'TreeItem', 'DataItem', 'Document')
function Get-Marks($hwnd, $info, $maxMarks) {
  $all = Get-CachedElements $hwnd
  $script:elements = @{}
  $marks = New-Object System.Collections.ArrayList
  $seen = 0; $patternCalls = 0
  foreach ($e in $all) {
    $seen++; if ($seen -gt 3000 -or $marks.Count -ge $maxMarks) { break }
    try {
      $type = Get-ElType $e
      if ($interactive -notcontains $type) { continue }
      if ($e.Cached.IsOffscreen) { continue }
      $r = $e.Cached.BoundingRectangle
      if ($r.Width -lt 6 -or $r.Height -lt 6) { continue }
      $left = [Math]::Max($r.X, $info.x); $top = [Math]::Max($r.Y, $info.y); $right = [Math]::Min($r.X + $r.Width, $info.x + $info.width); $bottom = [Math]::Min($r.Y + $r.Height, $info.y + $info.height)
      if ($right - $left -lt 6 -or $bottom - $top -lt 6) { continue }
      $id = $marks.Count + 1
      $script:elements[$id] = $e
      $value = $null; $state = $null
      if ($patternCalls -lt 50) {
        $p = $null
        if (@('Edit', 'ComboBox', 'Document', 'Spinner') -contains $type) { $patternCalls++; try { if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $value = $p.Current.Value; if ($value.Length -gt 120) { $value = $value.Substring(0, 120) } } } catch {} }
        elseif ($type -eq 'CheckBox') { $patternCalls++; try { if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $state = ([string]$p.Current.ToggleState) } } catch {} }
        elseif (@('ListItem', 'TabItem', 'RadioButton', 'TreeItem', 'DataItem') -contains $type) { $patternCalls++; try { if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { if ($p.Current.IsSelected) { $state = 'selected' } } } catch {} }
      }
      [void]$marks.Add([pscustomobject]@{ id = $id; type = $type; name = [string]$e.Cached.Name; aid = [string]$e.Cached.AutomationId; value = $value; state = $state; enabled = [bool]$e.Cached.IsEnabled; sx = [int]$left; sy = [int]$top; sw = [int]($right - $left); sh = [int]($bottom - $top) })
    } catch {}
  }
  return $marks
}
function Walk-Tree($root, $limit) {
  $script:elements = @{}
  $list = New-Object System.Collections.ArrayList
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  while ($queue.Count -gt 0 -and $list.Count -lt $limit) {
    $pair = $queue.Dequeue(); $el = $pair[0]; $depth = $pair[1]
    try {
      $c = $el.Current; $r = $c.BoundingRectangle
      $id = $list.Count + 1
      $script:elements[$id] = $el
      $value = $null; try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $value = $vp.Current.Value } catch {}
      [void]$list.Add([pscustomobject]@{ id = $id; type = ([string]$c.ControlType.ProgrammaticName).Replace('ControlType.', ''); name = $c.Name; automationId = $c.AutomationId; enabled = $c.IsEnabled; value = $value; x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height })
      if ($depth -lt 9) { $child = $walker.GetFirstChild($el); while ($child -ne $null -and $list.Count + $queue.Count -lt $limit * 2) { $queue.Enqueue(@($child, $depth + 1)); $child = $walker.GetNextSibling($child) } }
    } catch {}
  }
  return $list
}
function Handle($cmd, $a) {
  switch ($cmd) {
    'ping' { return @{ pong = $true } }
    'windows' { $items = @(); foreach ($h in [W]::Windows()) { $i = Get-Info $h; if ($i.width -ge 40 -and $i.height -ge 40 -or $i.minimized) { $items += $i } }; return @{ windows = @($items | Select-Object -First 40) } }
    'foreground' { return Get-Info ([W]::GetForegroundWindow()) }
    'focus' { $h = Find-Window $a.window $a.hwnd; $ok = Focus-Window $h; $i = Get-Info $h; return @{ focused = $ok; window = $i } }
    'screenshot' {
      if ($a.window -or $a.hwnd) { $h = Find-Window $a.window $a.hwnd; Focus-Window $h | Out-Null; $i = Get-Info $h; $shot = Take-Screenshot $i $a.maxWidth; $shot.window = $i; return $shot }
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      return Take-Screenshot ([pscustomobject]@{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }) $a.maxWidth
    }
    'region' { return Take-Screenshot ([pscustomobject]@{ x = [int]$a.x; y = [int]$a.y; width = [int]$a.width; height = [int]$a.height }) $a.maxWidth }
    'observe' {
      $h = Find-Window $null $a.hwnd; $info = Get-Info $h
      $marks = Get-Marks $h $info ([int]$a.maxMarks)
      $shot = Take-Screenshot $info $a.maxWidth $marks
      $out = @()
      foreach ($m in $marks) { $out += [pscustomobject]@{ id = $m.id; type = $m.type; name = $m.name; aid = $m.aid; value = $m.value; state = $m.state; enabled = $m.enabled; x = [int](($m.sx - $shot.originX) * $shot.scale); y = [int](($m.sy - $shot.originY) * $shot.scale); w = [int]($m.sw * $shot.scale); h = [int]($m.sh * $shot.scale); sx = $m.sx; sy = $m.sy; sw = $m.sw; sh = $m.sh } }
      $shot.window = $info; $shot.elements = @($out)
      return $shot
    }
    'hash' { $info = Get-Info (Find-Window $null $a.hwnd); return @{ hash = [Convert]::ToBase64String((Get-Gray $info)) } }
    'settle' {
      $h = Find-Window $null $a.hwnd
      Start-Sleep -Milliseconds 250
      $prev = Get-Gray (Get-Info $h); $stable = $false
      $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$a.timeoutMs)
      while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 220; $cur = Get-Gray (Get-Info $h); if ((Diff-Cells $prev $cur) -lt 0.0004) { $stable = $true; $prev = $cur; break }; $prev = $cur }
      $changed = 0.0
      if ($a.before) { $changed = Diff-Cells ([Convert]::FromBase64String($a.before)) $prev }
      return @{ stable = $stable; changed = $changed }
    }
    'ocr' { $h = Find-Window $null $a.hwnd; return @{ lines = @(Run-Ocr (Get-Info $h)) } }
    'hastext' {
      $h = Find-Window $null $a.hwnd; $all = Get-CachedElements $h; $found = $false
      foreach ($e in $all) { if (([string]$e.Cached.Name).IndexOf([string]$a.text, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $found = $true; break } }
      return @{ found = $found }
    }
    'readtext' {
      $h = Find-Window $null $a.hwnd; $all = Get-CachedElements $h
      $lines = New-Object System.Collections.ArrayList; $total = 0; $last = ''
      $plain = @('Text', 'ListItem', 'DataItem', 'TreeItem', 'Hyperlink', 'HeaderItem')
      $labeled = @('Button', 'MenuItem', 'TabItem', 'CheckBox', 'RadioButton', 'ComboBox', 'Header')
      foreach ($e in $all) {
        if ($total -gt [int]$a.maxChars) { break }
        try {
          if ($e.Cached.IsOffscreen) { continue }
          $type = Get-ElType $e
          if ($type -eq 'Document' -or $type -eq 'Edit') {
            $text = $null; $p = $null
            if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) { $text = $p.DocumentRange.GetText(8000) }
            elseif ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $text = $p.Current.Value }
            if ($text) { $line = '[' + $type + '] ' + $text.Trim(); [void]$lines.Add($line); $total += $line.Length }
            continue
          }
          $name = ([string]$e.Cached.Name).Trim()
          if (-not $name -or $name -eq $last) { continue }
          if ($plain -contains $type) { [void]$lines.Add($name); $total += $name.Length; $last = $name }
          elseif ($labeled -contains $type) { $line = '[' + $type + '] ' + $name; [void]$lines.Add($line); $total += $line.Length; $last = $name }
        } catch {}
      }
      return @{ lines = @($lines) }
    }
    'click' { Mouse-Click $a.x $a.y $a.button $a.count; return @{ clicked = $true } }
    'drag' {
      [W]::SetCursorPos([int]$a.x, [int]$a.y) | Out-Null; Start-Sleep -Milliseconds 80
      [W]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
      $steps = 14
      for ($s = 1; $s -le $steps; $s++) { [W]::SetCursorPos([int]($a.x + ($a.x2 - $a.x) * $s / $steps), [int]($a.y + ($a.y2 - $a.y) * $s / $steps)) | Out-Null; Start-Sleep -Milliseconds 25 }
      Start-Sleep -Milliseconds 60; [W]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero); return @{ dragged = $true }
    }
    'scroll' { [W]::SetCursorPos([int]$a.x, [int]$a.y) | Out-Null; Start-Sleep -Milliseconds 50; [W]::mouse_event(0x800, 0, 0, [int]($a.amount * 120), [UIntPtr]::Zero); return @{ scrolled = $true } }
    'keys' { Send-Keys $a.keys; return @{ pressed = $true } }
    'inspect' { $h = Find-Window $a.window $a.hwnd; $root = [System.Windows.Automation.AutomationElement]::FromHandle($h); return @{ elements = @(Walk-Tree $root ([int]$a.limit)) } }
    'invoke' {
      $el = $script:elements[[int]$a.id]; if ($el -eq $null) { throw '没有这个控件编号，请先 inspect_window' }
      foreach ($pattern in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
        $p = $null
        if ($el.TryGetCurrentPattern($pattern, [ref]$p)) {
          if ($pattern -eq [System.Windows.Automation.InvokePattern]::Pattern) { $p.Invoke() } elseif ($pattern -eq [System.Windows.Automation.SelectionItemPattern]::Pattern) { $p.Select() } elseif ($pattern -eq [System.Windows.Automation.TogglePattern]::Pattern) { $p.Toggle() } else { $p.Expand() }
          return @{ invoked = $true }
        }
      }
      $r = $el.Current.BoundingRectangle; Mouse-Click ($r.X + $r.Width / 2) ($r.Y + $r.Height / 2) 'left' 1; return @{ invoked = $true; via = 'click' }
    }
    'setvalue' {
      $el = $script:elements[[int]$a.id]; if ($el -eq $null) { throw '没有这个控件编号，请先 inspect_window' }
      $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue([string]$a.text); return @{ set = $true }
    }
    default { throw "未知命令：$cmd" }
  }
}
$inputMutex = New-Object System.Threading.Mutex($false, ('Local\PISCES.AI.DesktopInput.' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json; $id = $req.id
    $held = $false
    try {
      try { $held = $inputMutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
      if (-not $held) {
        [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = '其他原生动作仍占用桌面输入，当前操作未开始'; execution_status = 'not_started'; code = 'DESKTOP_INPUT_BUSY' } | ConvertTo-Json -Compress))
        continue
      }
      $result = Handle $req.cmd $req.args
    } finally { if ($held) { $inputMutex.ReleaseMutex() } }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
$inputMutex.Dispose()
`;

function desktopError(message, status = 'not_started', code = 'DESKTOP_HELPER_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code; error.execution_status = status; error.recoverable = true;
  return error;
}

class DesktopAgent {
  constructor({ dir, spawnProcess = spawn }) {
    this.dir = dir; this.spawnProcess = spawnProcess; this.child = null;
    this.pending = new Map(); this.queue = []; this.inFlight = null;
    this.nextId = 1; this.idle = null; this.starting = null; this.stopping = false; this.generation = 0;
  }

  async start() {
    if (this.stopping || this.inFlight?.abandoned) throw desktopError('上一次桌面操作仍在原生进程中执行，输入通道已隔离；核对状态后再继续', 'unknown', 'CORE_ACTION_UNCERTAIN');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.startHelper(++this.generation);
    try { await this.starting; } finally { this.starting = null; }
  }

  async startHelper(generation) {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'desktop-agent.ps1');
    await writeFile(file, '﻿' + SCRIPT, 'utf8');
    if (generation !== this.generation) throw desktopError('桌面控制启动已停止', 'not_started', 'DESKTOP_ACTION_CANCELLED');
    const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = '';
    child.stdin.on?.('error', error => {
      if (this.child !== child) return;
      this.failAll('桌面控制输入通道中断：' + error.message, false);
      this.stop();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        const waiting = this.pending.get(message.id);
        if (!waiting || waiting.child !== child) continue;
        this.pending.delete(message.id); this.inFlight = null;
        this.cleanup(waiting);
        // Cancellation settled the caller, not the native operation. Only this reply releases quarantine.
        if (!waiting.abandoned) message.ok ? waiting.resolve(message.result) : waiting.reject(desktopError(message.error || '桌面操作失败', message.execution_status || 'failed', message.code || 'DESKTOP_ACTION_FAILED'));
        this.drain();
      }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null; this.stopping = false; clearTimeout(this.idle);
      this.failAll('桌面控制进程已退出' + (stderr ? '：' + stderr.slice(0, 200) : ''), true);
    });
    child.on('error', error => {
      // A failed spawn has no native process. Errors from an existing helper do not prove that it stopped.
      const neverStarted = !child.pid;
      this.failAll('无法启动桌面控制进程：' + error.message, neverStarted);
      if (neverStarted && this.child === child) { this.child = null; this.stopping = false; }
      else this.stop();
    });
    await this.call('ping', {}, { timeout: 30000, skipStart: true });
  }

  async call(cmd, args = {}, { timeout = 20000, signal, skipStart = false } = {}) {
    if (signal?.aborted) throw desktopError('任务已停止', 'not_started', 'DESKTOP_ACTION_CANCELLED');
    if (!skipStart) await this.start();
    if (signal?.aborted) throw desktopError('任务已停止', 'not_started', 'DESKTOP_ACTION_CANCELLED');
    if (this.stopping || this.inFlight?.abandoned) throw desktopError('上一次桌面操作结果尚未确认，输入通道已隔离', 'unknown', 'CORE_ACTION_UNCERTAIN');
    if (!this.child) throw desktopError('桌面控制进程不可用');
    clearTimeout(this.idle);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const request = { id, cmd, args, timeout, signal, resolve, reject, child: this.child, abandoned: false };
      request.abort = () => {
        if (this.inFlight === request) this.abandon(request, '任务已停止，原生动作可能仍在执行');
        else {
          const index = this.queue.indexOf(request);
          if (index < 0) return;
          this.queue.splice(index, 1); this.cleanup(request);
          reject(desktopError('任务已停止', 'not_started', 'DESKTOP_ACTION_CANCELLED'));
        }
      };
      signal?.addEventListener('abort', request.abort, { once: true });
      this.queue.push(request);
      this.drain();
    });
  }

  cleanup(request) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
  }

  abandon(request, reason) {
    if (request.abandoned) return;
    request.abandoned = true; this.cleanup(request);
    request.reject(desktopError(reason, 'unknown', 'CORE_ACTION_UNCERTAIN'));
    // Nothing already queued may slip into the helper after the caller cancels.
    for (const waiting of this.queue.splice(0)) {
      this.cleanup(waiting);
      waiting.reject(desktopError('前一个桌面动作结果未知，此动作尚未发送', 'not_started', 'DESKTOP_CHANNEL_QUARANTINED'));
    }
  }

  drain() {
    if (this.stopping || this.inFlight || !this.child) return;
    const request = this.queue.shift();
    if (!request) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.stop(), 5 * 60 * 1000);
      this.idle.unref?.();
      return;
    }
    this.inFlight = request; this.pending.set(request.id, request);
    request.timer = setTimeout(() => this.abandon(request, '桌面操作超时：' + request.cmd + '；原生动作仍需核对'), request.timeout);
    const writeFailed = error => { if (error && this.pending.has(request.id)) { this.abandon(request, '桌面控制通道中断：' + error.message); this.stop(); } };
    try { this.child.stdin.write(JSON.stringify({ id: request.id, cmd: request.cmd, args: request.args }) + '\n', writeFailed); }
    catch (error) { writeFailed(error); }
  }

  failAll(reason, confirmedStopped) {
    for (const [id, request] of this.pending) {
      this.abandon(request, reason);
      if (confirmedStopped) { this.cleanup(request); this.pending.delete(id); }
    }
    if (confirmedStopped) this.inFlight = null;
    for (const request of this.queue.splice(0)) { this.cleanup(request); request.reject(desktopError(reason)); }
  }

  stop() {
    clearTimeout(this.idle);
    if (!this.child) { if (this.starting) this.generation++; return; }
    const alreadyStopping = this.stopping;
    this.stopping = true; this.failAll('桌面控制正在停止，已发出的动作结果需要核对', false);
    if (alreadyStopping) return;
    // kill() only requests termination. Keep the child and quarantine until its exit event confirms it.
    try { this.child.stdin.end(); this.child.kill(); } catch {}
  }
}

module.exports = { DesktopAgent };
