# Install cdesign (Windows PowerShell 5.1+ / PowerShell 7):
#   irm https://raw.githubusercontent.com/<owner>/cdesign/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = if ($env:CDESIGN_REPO) { $env:CDESIGN_REPO } else { 'dsmarcelo/cdesign' }
$Ref = if ($env:CDESIGN_REF) { $env:CDESIGN_REF } else { 'main' }
$Share = if ($env:CDESIGN_HOME) { $env:CDESIGN_HOME } else { Join-Path $env:USERPROFILE '.local\share\cdesign' }
$Bin = Join-Path $env:USERPROFILE '.local\bin'

$env:Path = "$env:USERPROFILE\.bun\bin;$Bin;$env:Path"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Bun...'
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

New-Item -ItemType Directory -Force (Split-Path $Share) | Out-Null
if (Test-Path $Share) { (Get-Item $Share).Delete() 2>$null; if (Test-Path $Share) { Remove-Item -Recurse -Force $Share } }

if ($env:CDESIGN_SRC) {
  # dev install: junction to the checkout so edits apply immediately
  New-Item -ItemType Junction -Path $Share -Target (Resolve-Path $env:CDESIGN_SRC).Path | Out-Null
} else {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cdesign-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Write-Host "Downloading $Repo@$Ref..."
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $tmp
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $Share
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Push-Location $Share
try { bun install --production --silent } finally { Pop-Location }

New-Item -ItemType Directory -Force $Bin | Out-Null
$BunPath = (Get-Command bun).Source
$launcher = "@echo off`r`n`"$BunPath`" `"$Share\src\cli.ts`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $Bin 'cdesign.cmd'), $launcher)

try { & (Join-Path $Bin 'cdesign.cmd') install-mcp } catch { }

# Put the launcher dir on the user PATH for new shells
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$Bin".TrimStart(';'), 'User')
  Write-Host "Added $Bin to your PATH. Open a new terminal to use 'cdesign'."
}
Write-Host "Installed: $Bin\cdesign.cmd"
