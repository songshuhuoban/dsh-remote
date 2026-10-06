<#
.SYNOPSIS
  Creates the DSH Remote Android release key once and gives it to the release workflow.

.DESCRIPTION
  Generates a PKCS12 keystore with a random password using the JDK's keytool, keeps the
  keystore and its password in a backup folder outside the repository, and uploads both to
  the repository's GitHub Actions secrets with the GitHub CLI. Nothing secret is printed.

  Keep the backup folder safe (for example copy it into your password manager): every later
  APK must be signed with this same key, or phones cannot upgrade the installed app.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File apps/mobile/tool/create-release-key.ps1
#>
param(
  [string]$Repo = 'songshuhuoban/dsh-remote',
  [string]$BackupDir = (Join-Path $HOME 'dsh-remote-android-key'),
  [string]$Alias = 'dsh-remote'
)
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 turns a native tool's stderr into a terminating error under 'Stop',
# and keytool reports its progress on stderr. Native tools are judged by exit code instead.
function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$InputText)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($PSBoundParameters.ContainsKey('InputText')) { $output = $InputText | & $File @Arguments 2>&1 }
    else { $output = & $File @Arguments 2>&1 }
    [pscustomobject]@{ Code = $LASTEXITCODE; Output = @($output | ForEach-Object { "$_" }) }
  } finally {
    $ErrorActionPreference = $previous
  }
}

$keytool = (Get-Command keytool -ErrorAction SilentlyContinue).Source
if (-not $keytool) {
  $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java' -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\keytool.exe') } | Select-Object -First 1
  if ($jdk) { $keytool = Join-Path $jdk.FullName 'bin\keytool.exe' }
}
if (-not $keytool) { throw 'keytool not found; install a JDK (17 or newer) first.' }
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { throw 'GitHub CLI (gh) not found.' }
if ((Invoke-Native $gh @('auth', 'status')).Code -ne 0) { throw 'Sign in to the GitHub CLI first: gh auth login' }

$keystore = Join-Path $BackupDir 'dsh-remote-release.p12'
$passwordFile = Join-Path $BackupDir 'password.txt'
if (Test-Path $keystore) {
  throw "A release key already exists at $keystore. Reuse it; a new key would stop phones from upgrading."
}
New-Item -ItemType Directory -Force $BackupDir | Out-Null

# 32 random bytes as URL-safe text. keytool reads it from the environment, so it never appears
# on a command line.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$env:DSH_RELEASE_KEY_PASSWORD = $password
try {
  $created = Invoke-Native $keytool @(
    '-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-alias', $Alias,
    '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
    '-dname', 'CN=DSH Remote, O=DSH Remote', '-noprompt',
    '-storepass:env', 'DSH_RELEASE_KEY_PASSWORD', '-keypass:env', 'DSH_RELEASE_KEY_PASSWORD')
  if ($created.Code -ne 0 -or -not (Test-Path $keystore)) {
    throw "keytool could not create the keystore: $($created.Output -join ' ')"
  }
  Set-Content -Path $passwordFile -Value $password -NoNewline -Encoding ascii

  function Set-Secret([string]$Name, [string]$Value) {
    # Through stdin, so the value never appears on a command line or in the output.
    $result = Invoke-Native $gh @('secret', 'set', $Name, '--repo', $Repo) -InputText $Value
    if ($result.Code -ne 0) { throw "Uploading $Name failed; the key is kept in $BackupDir. $($result.Output -join ' ')" }
  }
  Set-Secret 'ANDROID_KEYSTORE_BASE64' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore)))
  Set-Secret 'ANDROID_KEYSTORE_PASSWORD' $password
  Set-Secret 'ANDROID_KEY_ALIAS' $Alias

  $listing = Invoke-Native $keytool @('-list', '-v', '-keystore', $keystore, '-alias', $Alias,
    '-storepass:env', 'DSH_RELEASE_KEY_PASSWORD')
  $fingerprint = $listing.Output | Where-Object { $_ -match 'SHA-?256' } | Select-Object -First 1
} finally {
  Remove-Item Env:DSH_RELEASE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
Write-Host "Release key created and uploaded to $Repo (ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS)."
Write-Host "Backup (keep it safe, never commit it): $BackupDir"
if ($fingerprint) { Write-Host $fingerprint.Trim() }
