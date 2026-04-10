$target   = "E:\Dev\Software\compteur electric\dist\PowerStation-1.0.0-portable.exe"
$icon     = "E:\Dev\Software\compteur electric\build\icon.ico"
$workDir  = "E:\Dev\Software\compteur electric\dist"
$desktop  = [Environment]::GetFolderPath("Desktop")
$lnkPath  = Join-Path $desktop "PowerStation.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath       = $target
$sc.IconLocation     = $icon
$sc.WorkingDirectory = $workDir
$sc.Description      = "Power Station - Compteur Electrique Shelly EM"
$sc.Save()

Write-Host "OK: $lnkPath"
