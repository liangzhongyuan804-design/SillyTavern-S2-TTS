<#
.SYNOPSIS
    Installs the S2 TTS extension into a SillyTavern installation.

.DESCRIPTION
    Copies the browser extension into public/scripts/extensions/third-party
    and the server plugin into plugins/, then enables server plugins in
    config.yaml.

    Node is the one runtime every SillyTavern already needs, so
    "node install.mjs --st <SillyTavern folder>" does the same thing on
    Windows, Linux and macOS. This script is the PowerShell variant.

.PARAMETER StRoot
    Path to the SillyTavern installation directory (the one containing server.js).

.EXAMPLE
    .\install.ps1 -StRoot 'F:\SillyTavern'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StRoot
)

$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionName = 'st-s2-tts'

# The browser extension lives in the root of the repository, so that the same
# repository can also be cloned by the extension manager and by
# "node plugins.js install".
$extensionFiles = @(
    'manifest.json',
    'index.js',
    'player.js',
    'queue.js',
    'sanitize.js',
    'profile.js',
    'profile-ui.js',
    'voicetree.js',
    'settings.html',
    'style.css'
)
$extensionDirs = @('locales')

if (-not (Test-Path -LiteralPath (Join-Path $StRoot 'server.js'))) {
    throw "这不是 SillyTavern 根目录（缺少 server.js）：$StRoot"
}

Write-Host "S2 TTS 安装程序" -ForegroundColor Cyan
Write-Host "  SillyTavern : $StRoot"
Write-Host ""

# --- browser extension -------------------------------------------------------
$extensionTarget = Join-Path $StRoot "public\scripts\extensions\third-party\$extensionName"
if (Test-Path -LiteralPath $extensionTarget) {
    Write-Host "覆盖已存在的扩展：$extensionTarget" -ForegroundColor Yellow
    # Remove first: Copy-Item into an existing directory nests the source
    # folder inside it, which would leave a stale subfolder behind.
    Remove-Item -LiteralPath $extensionTarget -Recurse -Force
}
New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
foreach ($file in $extensionFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $extensionTarget $file) -Force
}
foreach ($dir in $extensionDirs) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $dir) -Destination (Join-Path $extensionTarget $dir) -Recurse -Force
}
Write-Host "[1/3] 浏览器扩展已安装 -> $extensionTarget" -ForegroundColor Green

# --- server plugin -----------------------------------------------------------
$pluginTarget = Join-Path $StRoot "plugins\$extensionName"
if (Test-Path -LiteralPath $pluginTarget) {
    Write-Host "覆盖已存在的服务端插件：$pluginTarget" -ForegroundColor Yellow
    Remove-Item -LiteralPath $pluginTarget -Recurse -Force
}
New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null
Copy-Item -Path (Join-Path $sourceRoot 'plugin\*') -Destination $pluginTarget -Recurse -Force
Write-Host "[2/3] 服务端插件已安装 -> $pluginTarget" -ForegroundColor Green

# --- enable server plugins in config.yaml ------------------------------------
$configPath = Join-Path $StRoot 'config.yaml'
if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Host "[3/3] 未找到 config.yaml，跳过自动修改。" -ForegroundColor Yellow
    Write-Host "      请手动在 config.yaml 中添加：enableServerPlugins: true" -ForegroundColor Yellow
} else {
    $config = Get-Content -LiteralPath $configPath -Raw
    if ($config -match '(?m)^\s*enableServerPlugins\s*:') {
        Write-Host "[3/3] config.yaml 已存在 enableServerPlugins 配置，跳过。" -ForegroundColor Green
    } else {
        $updated = $config.TrimEnd() + "`r`n`r`n# Added by the S2 TTS installer.`r`nenableServerPlugins: true`r`n"
        # Write UTF-8 without a BOM: PowerShell 5.1's `Set-Content -Encoding UTF8`
        # adds one, and a BOM in front of the YAML document breaks the parser.
        [System.IO.File]::WriteAllText($configPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[3/3] 已在 config.yaml 中启用 enableServerPlugins: true" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "安装完成。后续步骤：" -ForegroundColor Cyan
Write-Host "  1) 启动 s2.cpp 服务（参考你的 ComfyUI-FishS2-GGUF 配置，或用扩展设置里的「服务进程」一键启动）"
Write-Host "  2) 重启 SillyTavern"
Write-Host "  3) 打开 扩展设置 -> S2 语音合成，填写服务地址并点「测试连接」"
Write-Host "  4) 选择音色（或上传参考音频 + 对应文本），然后点「试听」"
