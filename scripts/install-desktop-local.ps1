param(
 [Parameter(Mandatory=$true)][string]$SourceExe,
 [switch]$Launch
)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $SourceExe).Path
if([IO.Path]::GetExtension($source) -ne '.exe' -or (Get-Item $source).Length -lt 2MB){
 throw 'Informe o executável Windows compilado do OmnyaDesk.'
}
$destination=Join-Path $env:LOCALAPPDATA 'Programs\OmnyaDesk\OmnyaDesk.exe'
$dir=Split-Path $destination
New-Item -ItemType Directory -Path $dir -Force|Out-Null
if($source -ine $destination){
 $running=Get-CimInstance Win32_Process -Filter "Name='OmnyaDesk.exe'" |
  Where-Object {$_.ExecutablePath -ieq $destination}
 foreach($process in $running){Stop-Process -Id $process.ProcessId -Force}
 Copy-Item -LiteralPath $source -Destination $destination -Force
}
if((Get-FileHash $source -Algorithm SHA256).Hash -ne
   (Get-FileHash $destination -Algorithm SHA256).Hash){throw 'Falha de integridade na instalação'}
$shell=New-Object -ComObject WScript.Shell
foreach($path in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'OmnyaDesk.lnk'),
 (Join-Path ([Environment]::GetFolderPath('Programs')) 'OmnyaDesk.lnk'))){
 if(Test-Path -LiteralPath $path){
  $prior=$shell.CreateShortcut($path)
  if($prior.TargetPath -and $prior.TargetPath -ine $destination -and
     $prior.TargetPath -notmatch 'OmnyaDesk'){throw 'Atalho pertence a outra aplicação'}
 }
 $shortcut=$shell.CreateShortcut($path)
 $shortcut.TargetPath=$destination
 $shortcut.WorkingDirectory=$dir
 $shortcut.IconLocation=$destination+',0'
 $shortcut.Description='OmnyaDesk — aplicativo desktop atualizado'
 $shortcut.Save()
}
if($Launch){Start-Process -FilePath $destination}
Write-Output ('PASS: OmnyaDesk atualizado no caminho estável '+$destination+'. Cofre de credenciais inalterado.')
