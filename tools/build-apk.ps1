# 出包脚本：aapt2 → javac → d8 → 注入 classes.dex → zipalign → apksigner
#
# 用法（PowerShell 执行策略禁止直接跑 .ps1，必须带 Bypass）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File tools\build-apk.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File tools\build-apk.ps1 -VersionName 1.0.1 -VersionCode 2
#
# 三个必须踩准的地方（错了包就装不上）：
#   1. resources.arsc 不能压缩 —— targetSdk>=30 的硬性要求。所以 add dex 那步
#      必须用 ZipArchive 的「仅追加、不重压缩」，不能用 jar uf（它会整包重压）。
#   2. zipalign 必须在 apksigner 之前。
#   3. 升级必须用同一把签名钥匙，否则手机上覆盖安装失败。

[CmdletBinding()]
param(
    [string]$VersionName = "1.0.0",
    [int]$VersionCode = 1,
    [string]$CopyTo = "",
    # JDK 17 目录（含 bin\javac.exe）。不给就用 JAVA_HOME，再找不到就报错让你指定。
    [string]$Jdk = "",
    # 签名密钥库与口令文件。默认放 %USERPROFILE%\.dsh\mobile-app\，升级必须用同一把。
    [string]$Keystore = "",
    [string]$KeystorePassFile = ""
)

$ErrorActionPreference = "Stop"

# 这两个程序集必须在脚本一开始就加载：PowerShell 5.1 里如果在用到的地方才 Add-Type，
# [System.IO.Compression.ZipArchiveMode] 会报 Unable to find type。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root    = Split-Path -Parent $PSScriptRoot
$android = Join-Path $root "android"
$build   = Join-Path $android "build"
$dist    = Join-Path $root "dist"

# 机上的 ANDROID_SDK_ROOT 还指着一个早已不存在的临时目录，所以不能只信环境变量：
# 按顺序找，第一个真的含 android.jar 的才算数。
$sdkCandidates = @($env:DSH_ANDROID_SDK, "C:\Android\sdk", $env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)
$sdk = $null
foreach ($c in $sdkCandidates) {
    if (-not $c) { continue }
    if (Test-Path (Join-Path $c "platforms\android-34\android.jar")) { $sdk = $c; break }
}
if (-not $sdk) {
    foreach ($c in $sdkCandidates) { if ($c) { $sdk = $c; break } }
}
$jdkCandidates = @($Jdk, $env:JAVA_HOME, "C:\Program Files\Android\Android Studio\jbr", "C:\Program Files\Java\jdk-17")
$jdk = $null
foreach ($c in $jdkCandidates) {
    if (-not $c) { continue }
    if (Test-Path (Join-Path $c "bin\javac.exe")) { $jdk = $c; break }
}
if (-not $jdk) {
    Fail "找不到 JDK 17：请设 JAVA_HOME，或用 -Jdk 'D:\jdk-17' 指定（需要 bin\javac.exe）"
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$buildTools = Join-Path $sdk "build-tools\34.0.0"
$androidJar = Join-Path $sdk "platforms\android-34\android.jar"

$aapt2     = Join-Path $buildTools "aapt2.exe"
$d8        = Join-Path $buildTools "d8.bat"
$zipalign  = Join-Path $buildTools "zipalign.exe"
$apksigner = Join-Path $buildTools "apksigner.bat"
$javac     = Join-Path $jdk "bin\javac.exe"
$keytool   = Join-Path $jdk "bin\keytool.exe"

function Fail($msg) { Write-Host "`n[失败] $msg" -ForegroundColor Red; exit 1 }

function Need($path, $what) {
    if (-not (Test-Path $path)) { Fail "缺少 $what`n        $path" }
}

function Step($title) {
    Write-Host ""
    Write-Host "== $title" -ForegroundColor Cyan
}

function Run($exe, [string[]]$argv, $what) {
    $start = Get-Date
    # 输出先落盘：工具的 stderr（javac 的 deprecation 提示之类）在 PS 5.1 里会变成
    # NativeCommandError 糊满屏幕，成功时没必要看；失败时再整段打出来。
    $log = Join-Path $env:TEMP ("dsh-build-" + [guid]::NewGuid().ToString("N") + ".log")
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $exe @argv *> $log
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    $ms = [int]((Get-Date) - $start).TotalMilliseconds
    if ($code -ne 0) {
        Get-Content $log -Encoding UTF8 | ForEach-Object { Write-Host "   $_" }
        Remove-Item $log -Force -ErrorAction SilentlyContinue
        Fail "$what（exit $code）"
    }
    Remove-Item $log -Force -ErrorAction SilentlyContinue
    Write-Host "   ok  ${ms}ms"
}

Need $androidJar "android.jar（sdkmanager `"platforms;android-34`"）"
Need $aapt2 "aapt2（build-tools 34.0.0）"
Need $javac "javac（JDK 17）"
Need $keytool "keytool（JDK 17）"

if (Test-Path $build) { Remove-Item $build -Recurse -Force }
foreach ($d in @("res", "classes", "dex", "gen")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $build $d) | Out-Null
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Step "0/7 图标"
$py = (Get-Command python -ErrorAction SilentlyContinue)
if ($py) {
    & python (Join-Path $root "tools\make-icon.py")
    if ($LASTEXITCODE -ne 0) { Fail "图标生成失败" }
} else {
    Write-Host "   跳过（没有 python，沿用已有 png）"
}

Step "1/7 编译资源"
Run $aapt2 @(
    "compile", "--dir", (Join-Path $android "res"), "-o", (Join-Path $build "res")
) "aapt2 compile"

Step "2/7 链接资源与清单"
$flats = @(Get-ChildItem (Join-Path $build "res") -Recurse -Filter *.flat | ForEach-Object { $_.FullName })
if ($flats.Count -eq 0) { Fail "没有编译出任何 .flat" }

$linkArgs = @(
    "link",
    "-o", (Join-Path $build "base.apk"),
    "-I", $androidJar,
    "--manifest", (Join-Path $android "AndroidManifest.xml"),
    "-A", (Join-Path $android "assets"),
    "--java", (Join-Path $build "gen"),
    "--min-sdk-version", "26",
    "--target-sdk-version", "34",
    "--version-code", "$VersionCode",
    "--version-name", $VersionName,
    # 每个 .flat 都是一次 -R；不带这个参数时，除第一个之外全被当成「覆盖已有资源」，
    # 于是报 does not override an existing resource。
    "--auto-add-overlay"
)
foreach ($f in $flats) { $linkArgs += @("-R", $f) }
Run $aapt2 $linkArgs "aapt2 link"

Step "3/7 编译 Java"
$sources = @(Get-ChildItem (Join-Path $android "src") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
# aapt2 link 生成的 R.java 也要一起编：以前代码里没人引用自家 R（只用 android.R），
# 所以一直没加；通知小图标用了 R.mipmap.ic_launcher，从这里开始需要它。
$sources += @(Get-ChildItem (Join-Path $build "gen") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
# vendor 的纯 Java 库（ZXing core）：没有 Gradle，直接进 javac classpath + d8 输入。
$libDir = Join-Path $android "libs"
$libJars = @()
if (Test-Path $libDir) {
    $libJars = @(Get-ChildItem $libDir -Filter *.jar | ForEach-Object { $_.FullName })
}
$javacClassPath = $androidJar
foreach ($j in $libJars) { $javacClassPath = $javacClassPath + ";" + $j }
$javacArgs = @(
    "-encoding", "UTF-8",
    "-nowarn",
    "-source", "8", "-target", "8",
    "-bootclasspath", $androidJar,
    "-classpath", $javacClassPath,
    "-d", (Join-Path $build "classes")
) + $sources
Run $javac $javacArgs "javac"

Step "4/7 dex"
# 命令行会超 Windows 的 8191 字符限制（加入 ZXing jar 后触发），改用 d8 的 @argfile。
# 每行一个参数；路径里的空格不用加引号（加了会被当成路径的一部分）。
$classFiles = @(Get-ChildItem (Join-Path $build "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName })
$dexInputs = $classFiles + $libJars
$argFile = Join-Path $env:TEMP ("dsh-d8-" + [guid]::NewGuid().ToString("N") + ".txt")
$d8Lines = @("--lib", $androidJar, "--min-api", "26", "--output", (Join-Path $build "dex")) + $dexInputs
[System.IO.File]::WriteAllLines($argFile, $d8Lines, (New-Object System.Text.UTF8Encoding($false)))
try {
    Run $d8 @("@" + $argFile) "d8"
} finally {
    Remove-Item $argFile -Force -ErrorAction SilentlyContinue
}

$dex = Join-Path $build "dex\classes.dex"
Need $dex "classes.dex"

Step "5/7 打包（追加 classes.dex，不重压缩其它条目）"
$packed = Join-Path $build "packed.apk"
Copy-Item (Join-Path $build "base.apk") $packed -Force
$zip = [System.IO.Compression.ZipFile]::Open($packed, "Update")
try {
    $entry = $zip.CreateEntry("classes.dex", [System.IO.Compression.CompressionLevel]::NoCompression)
    $out = $entry.Open()
    $in = [System.IO.File]::OpenRead($dex)
    try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
} finally {
    $zip.Dispose()
}
Write-Host "   ok  已写入 classes.dex"

Step "6/7 对齐 + 签名"
$aligned = Join-Path $build "aligned.apk"
Run $zipalign @("-f", "-p", "4", $packed, $aligned) "zipalign"

$ksDir  = Join-Path $env:USERPROFILE ".dsh\mobile-app"
$ks     = if ($Keystore) { $Keystore } else { Join-Path $ksDir "dsh-mobile.keystore" }
$pwFile = if ($KeystorePassFile) { $KeystorePassFile } else { Join-Path $ksDir "keystore.pass" }
if (-not (Test-Path $ks)) { $ksDir = Split-Path -Parent $ks; if (-not $ksDir) { $ksDir = "." } }

if (-not (Test-Path $ks)) {
    Write-Host "   首次运行：生成签名密钥（以后升级必须用这把，别删）"
    New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
    $pw = "dsh" + ([guid]::NewGuid().ToString("N").Substring(0, 20))
    & $keytool -genkeypair -v -keystore $ks -storetype PKCS12 -alias dsh `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $pw -keypass $pw `
        -dname "CN=DSH Mobile,O=local,C=CN"
    if ($LASTEXITCODE -ne 0) { Fail "生成密钥库失败" }
    [System.IO.File]::WriteAllText($pwFile, $pw)
    Write-Host "   密钥库：$ks"
    Write-Host "   口令文件：$pwFile"
}
Need $ks "签名密钥库"
Need $pwFile "签名口令文件"

# 口令用 pass: 直接给，不用 file: —— 同一个文件被 --ks-pass 和 --key-pass 各读一次时，
# apksigner 会在第二次读到 EOF，报 "end of file reached"。
$pass = [System.IO.File]::ReadAllText($pwFile).Trim()
if (-not $pass) { Fail "签名口令为空：$pwFile" }

$apk = Join-Path $dist ("dsh-mobile-" + $VersionName + ".apk")
if (Test-Path $apk) { Remove-Item $apk -Force }
Run $apksigner @(
    "sign",
    "--ks", $ks,
    "--ks-key-alias", "dsh",
    "--ks-pass", ("pass:" + $pass),
    "--key-pass", ("pass:" + $pass),
    "--out", $apk,
    $aligned
) "apksigner sign"

Step "7/7 自检"
Write-Host "-- 签名"
& $apksigner "verify" "--print-certs" $apk
if ($LASTEXITCODE -ne 0) { Fail "签名校验不通过" }

Write-Host "`n-- 包信息"
& $aapt2 "dump" "badging" $apk | Select-String -Pattern "^package:|^sdkVersion|^targetSdkVersion|^uses-permission|^launchable-activity|^application-label"

$size = [math]::Round((Get-Item $apk).Length / 1KB, 1)
Write-Host "`n[完成] $apk  ($size KB)" -ForegroundColor Green

if ($CopyTo -ne "") {
    New-Item -ItemType Directory -Force -Path $CopyTo | Out-Null
    $dst = Join-Path $CopyTo (Split-Path -Leaf $apk)
    Copy-Item $apk $dst -Force
    Write-Host "[已复制] $dst" -ForegroundColor Green
}
