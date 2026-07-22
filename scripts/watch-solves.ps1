$log = Join-Path $PSScriptRoot "..\data\hard-recover-trend-nav.log"
$log = [System.IO.Path]::GetFullPath($log)
Write-Output "WATCH $log"
if (-not (Test-Path $log)) { Write-Output "NO LOG"; exit 1 }
Get-Content -Path $log -Wait -Tail 20 | ForEach-Object {
  $line = $_
  if ($line -match "RECOVERY solved|captcha_solved|clean via trend|wall cleared|RECOVERY clean via|^\[[0-9]+/") {
    Write-Output $line
  }
  if ($line -match "IP recovery pass complete") {
    Write-Output $line
    exit 0
  }
}
