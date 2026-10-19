param([string]$Title, [string]$StateFile)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$window = New-Object System.Windows.Window
$window.Title = $Title; $window.Width = 460; $window.Height = 380; $window.Left = 80; $window.Top = 80; $window.Topmost = $true
$panel = New-Object System.Windows.Controls.StackPanel; $panel.Margin = 20
$box = New-Object System.Windows.Controls.TextBox; $box.Height = 30; $box.Margin = '0,0,0,12'
[System.Windows.Automation.AutomationProperties]::SetName($box, 'fixtureText')
$button = New-Object System.Windows.Controls.Button; $button.Content = 'Go'; $button.Width = 120; $button.Height = 40; $button.HorizontalAlignment = 'Left'; $button.Margin = '0,0,0,12'
$script:clicks = 0
$button.Add_Click({ $script:clicks++ })
$check = New-Object System.Windows.Controls.CheckBox; $check.Content = 'Enable feature'; $check.Margin = '0,0,0,12'
$list = New-Object System.Windows.Controls.ListBox; $list.Height = 100
foreach ($item in @('Alpha item', 'Beta item', 'Gamma item')) { [void]$list.Items.Add($item) }
$panel.Children.Add($box) | Out-Null; $panel.Children.Add($button) | Out-Null; $panel.Children.Add($check) | Out-Null; $panel.Children.Add($list) | Out-Null
$window.Content = $panel
$timer = New-Object System.Windows.Threading.DispatcherTimer; $timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({ try { [IO.File]::WriteAllText($StateFile, (@{ text = $box.Text; clicks = $script:clicks; checked = [bool]$check.IsChecked; selected = [string]$list.SelectedItem } | ConvertTo-Json -Compress)) } catch {} })
$timer.Start()
$window.ShowDialog() | Out-Null
