# MPC Ekran — worker PowerShell (OCR Windows + UI Automation).
# Protokół: jedna linia JSON na wejściu {id, cmd, ...} → jedna linia JSON na wyjściu {id, ok, ...}.
# Proces jest trwały (start raz ~0,5 s), dzięki czemu OCR i UIA odpowiadają w setkach ms.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -Namespace MpcNative -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@
try { [void][MpcNative.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, [Type]$type) {
  $m = $script:AsTaskGeneric.MakeGenericMethod($type)
  $task = $m.Invoke($null, @($op))
  [void]$task.Wait(-1)
  return $task.Result
}

$script:Engines = @{}
function Get-OcrEngine([string]$lang) {
  $key = if ($lang) { $lang } else { 'auto' }
  if ($script:Engines.ContainsKey($key)) { return $script:Engines[$key] }
  $engine = $null
  if ($lang -and $lang -ne 'auto') {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($lang)))
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw 'Brak silnika OCR Windows (zainstaluj pakiet językowy z OCR)' }
  $script:Engines[$key] = $engine
  return $engine
}

function Invoke-Ocr($req) {
  $full = [IO.Path]::GetFullPath(($req.path -replace '/', '\'))
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = Get-OcrEngine $req.lang
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in $res.Lines) {
      $words = New-Object System.Collections.ArrayList
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        [void]$words.Add(@{ t = $w.Text; x = [double]$r.X; y = [double]$r.Y; w = [double]$r.Width; h = [double]$r.Height })
      }
      [void]$lines.Add(@{ text = $line.Text; words = $words })
    }
    $bmp.Dispose()
    return @{ lang = $engine.RecognizerLanguage.LanguageTag; angle = $res.TextAngle; lines = $lines }
  } finally {
    $stream.Dispose()
  }
}

$script:Interactive = @{
  'Button' = 1; 'Edit' = 1; 'CheckBox' = 1; 'RadioButton' = 1; 'ComboBox' = 1; 'Hyperlink' = 1;
  'ListItem' = 1; 'MenuItem' = 1; 'TabItem' = 1; 'Slider' = 1; 'TreeItem' = 1; 'SplitButton' = 1;
  'Spinner' = 1; 'DataItem' = 1; 'MenuBar' = 0; 'Document' = 0; 'Text' = 1; 'Image' = 1; 'ScrollBar' = 0;
  'Header' = 0; 'HeaderItem' = 1; 'ToolBar' = 0; 'List' = 0; 'Tab' = 0; 'Menu' = 0; 'Window' = 0; 'Pane' = 0;
  'Group' = 0; 'Custom' = 0; 'Table' = 0; 'Tree' = 0; 'StatusBar' = 0; 'TitleBar' = 0; 'Thumb' = 0;
  'Calendar' = 0; 'ProgressBar' = 0; 'ToolTip' = 0; 'DataGrid' = 0; 'AppBar' = 0; 'SemanticZoom' = 0
}

function Invoke-Uia($req) {
  $AE = [System.Windows.Automation.AutomationElement]
  $hwnd = [IntPtr]0
  if ($req.hwnd) { $hwnd = [IntPtr][long]$req.hwnd } else { $hwnd = [MpcNative.Dpi]::GetForegroundWindow() }
  if ($hwnd -eq [IntPtr]0) { throw 'Brak okna dla UI Automation' }
  $root = $AE::FromHandle($hwnd)
  $max = if ($req.max) { [int]$req.max } else { 600 }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($(if ($req.timeoutMs) { [int]$req.timeoutMs } else { 4000 }))
  $includeText = [bool]$req.includeText

  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add($AE::NameProperty)
  $cr.Add($AE::ControlTypeProperty)
  $cr.Add($AE::BoundingRectangleProperty)
  $cr.Add($AE::IsOffscreenProperty)
  $cr.Add($AE::IsEnabledProperty)
  $cr.Add($AE::AutomationIdProperty)
  $cr.Add($AE::ClassNameProperty)
  $cr.Add($AE::IsKeyboardFocusableProperty)
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element

  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsOffscreenProperty, $false)
  $items = New-Object System.Collections.ArrayList
  $truncated = $false
  $act = $cr.Activate()
  try {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($el in $all) {
      if ([DateTime]::UtcNow -gt $deadline) { $truncated = $true; break }
      $c = $el.Cached
      $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $flag = $script:Interactive[$type]
      if ($flag -eq $null) { $flag = 0 }
      if ($flag -eq 0) { continue }
      if (($type -eq 'Text' -or $type -eq 'Image') -and -not $includeText) { continue }
      $r = $c.BoundingRectangle
      if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { continue }
      [void]$items.Add(@{
          name = $c.Name; type = $type; id = $c.AutomationId; cls = $c.ClassName;
          enabled = $c.IsEnabled; focusable = $c.IsKeyboardFocusable;
          x = [double]$r.X; y = [double]$r.Y; w = [double]$r.Width; h = [double]$r.Height
        })
      if ($items.Count -ge $max) { $truncated = $true; break }
    }
  } finally {
    $act.Dispose()
  }
  $rootRect = $root.Current.BoundingRectangle
  return @{
    window = @{ name = $root.Current.Name; cls = $root.Current.ClassName; x = [double]$rootRect.X; y = [double]$rootRect.Y; w = [double]$rootRect.Width; h = [double]$rootRect.Height }
    items = $items; truncated = $truncated
  }
}

function Describe-Element($el) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  $pw = $false
  try { $pw = [bool]$c.IsPassword } catch { }
  return @{
    found = $true; name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '');
    id = $c.AutomationId; cls = $c.ClassName; enabled = $c.IsEnabled; password = $pw; pid = $c.ProcessId;
    x = [double]$r.X; y = [double]$r.Y; w = [double]$r.Width; h = [double]$r.Height
  }
}

$script:Clickable = @{ 'Button' = 1; 'SplitButton' = 1; 'ListItem' = 1; 'MenuItem' = 1; 'TabItem' = 1; 'Hyperlink' = 1;
  'CheckBox' = 1; 'RadioButton' = 1; 'ComboBox' = 1; 'Edit' = 1; 'TreeItem' = 1; 'DataItem' = 1; 'HeaderItem' = 1; 'Slider' = 1; 'Spinner' = 1 }

# Element pod punktem. Gdy trafiamy w napis/ikonę wewnątrz przycisku, wchodzimy do klikalnego rodzica (max 3 poziomy).
function Invoke-ElementAt($req) {
  $AE = [System.Windows.Automation.AutomationElement]
  $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
  $el = $AE::FromPoint($pt)
  if (-not $el) { return @{ found = $false } }
  $type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if (-not $script:Clickable.ContainsKey($type)) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $p = $el
    for ($i = 0; $i -lt 3; $i++) {
      $p = $walker.GetParent($p)
      if (-not $p) { break }
      $pt2 = $p.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($script:Clickable.ContainsKey($pt2)) { $el = $p; break }
      if ($pt2 -eq 'Window' -or $pt2 -eq 'Pane') { break }
    }
    $type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  }
  # Klik w napis przy polu wyboru (HTML <label>, tekst obok checkboxa/radia): Chromium często zwraca wtedy cały
  # kontener. Szukamy CheckBox/RadioButton o tej samej nazwie albo w tym samym wierszu, na lewo od punktu.
  # via=label — po stronie Node sprawdzamy jeszcze, czy pod punktem jest napis (a nie puste miejsce).
  if (-not $script:Clickable.ContainsKey($type)) {
    $label = ([string]$el.Current.Name).Trim()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $CT = [System.Windows.Automation.ControlType]
    $cond = New-Object System.Windows.Automation.OrCondition(
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::CheckBox)),
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::RadioButton)))
    $scope = $el
    for ($i = 0; $i -lt 3; $i++) {
      if ($i -gt 0) { $scope = $walker.GetParent($scope); if (-not $scope) { break } }
      $st = $scope.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($i -gt 0 -and ($st -eq 'Window' -or $st -eq 'Pane')) { break }
      $best = $null; $bestD = 1e9
      foreach ($h in $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        $hr = $h.Current.BoundingRectangle
        if ($hr.Width -le 0) { continue }
        $dx = $req.x - ($hr.X + $hr.Width / 2); $dy = [math]::Abs($req.y - ($hr.Y + $hr.Height / 2))
        if ($label -and ([string]$h.Current.Name).Trim() -eq $label -and [math]::Sqrt($dx * $dx + $dy * $dy) -lt 400) { $best = $h; break }
        if ($dy -le [math]::Max(12, $hr.Height) -and $dx -ge -40 -and $dx -le 320) {
          $d = [math]::Abs($dx) + 3 * $dy
          if ($d -lt $bestD) { $best = $h; $bestD = $d }
        }
      }
      if ($best) { $r = Describe-Element $best; $r.via = 'label'; return $r }
    }
  }
  return Describe-Element $el
}

# Kontrolka po tożsamości (AutomationId albo nazwa + typ) — odporne na przesunięcie i zmianę rozmiaru okna.
function Invoke-Find($req) {
  $AE = [System.Windows.Automation.AutomationElement]
  $root = $AE::FromHandle([IntPtr][long]$req.hwnd)
  $conds = New-Object System.Collections.ArrayList
  if ($req.automationId) { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, [string]$req.automationId))) }
  if ($req.name) { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$req.name))) }
  if ($conds.Count -eq 0) { throw 'find: podaj automationId albo name' }
  $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$conds.ToArray()) }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    $d = Describe-Element $e
    if ($req.type -and $d.type -ne $req.type) { continue }
    if ($d.w -lt 2 -or $d.h -lt 2) { continue }
    [void]$out.Add($d)
    if ($out.Count -ge 8) { break }
  }
  return @{ items = $out }
}

function Invoke-Focused($req) {
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $el) { return @{ found = $false } }
  return Describe-Element $el
}

function Invoke-ProcInfo($req) {
  $p = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
  $desc = ''; $product = ''; $path = ''
  try { $path = $p.Path; $vi = $p.MainModule.FileVersionInfo; $desc = $vi.FileDescription; $product = $vi.ProductName } catch { }
  return @{ name = $p.ProcessName; description = $desc; product = $product; path = $path }
}

[Console]::Out.WriteLine((@{ id = 0; ok = $true; ready = $true; pid = $PID } | ConvertTo-Json -Compress))
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $sw = [Diagnostics.Stopwatch]::StartNew()
    switch ($req.cmd) {
      'ocr' { $data = Invoke-Ocr $req }
      'uia' { $data = Invoke-Uia $req }
      'element_at' { $data = Invoke-ElementAt $req }
      'find' { $data = Invoke-Find $req }
      'focused' { $data = Invoke-Focused $req }
      'proc_info' { $data = Invoke-ProcInfo $req }
      'ping' { $data = @{ pong = $true } }
      'quit' { exit 0 }
      default { throw "Nieznana komenda: $($req.cmd)" }
    }
    $out = @{ id = $id; ok = $true; ms = $sw.ElapsedMilliseconds; data = $data }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 8))
  } catch {
    $err = @{ id = $id; ok = $false; error = $_.Exception.GetBaseException().Message }
    [Console]::Out.WriteLine(($err | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
