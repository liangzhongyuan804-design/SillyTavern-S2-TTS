<#
.SYNOPSIS
    Creates the three-level voice classification used by the tag based voice
    selection (gender / personality / tone).

.DESCRIPTION
    The folders of the voice directory ARE the tags: a reply that starts with
    "小雅·女·妩媚·生气·：" is spoken with the .s2voice file that sits in
    voices\女\妩媚\生气.s2voice.

    This script creates that folder structure. Every file it writes is a copy
    of one existing profile, so nothing new is synthesized — it only shows
    how the classification works. Replace the copies with your own profiles
    afterwards.

.EXAMPLE
    .\make-demo-voice-tree.ps1 -VoiceDir 'F:\s2\s2.cpp\voices'

.EXAMPLE
    .\make-demo-voice-tree.ps1 -VoiceDir 'F:\s2\s2.cpp\voices' -Source 'F:\s2\s2.cpp\voices\sao.s2voice'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VoiceDir,

    # Profile to copy. Without it the first .s2voice in the directory is used.
    [string]$Source = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $VoiceDir)) {
    throw "音色目录不存在：$VoiceDir"
}

if (-not $Source) {
    $Source = Get-ChildItem -LiteralPath $VoiceDir -Filter '*.s2voice' -File |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Source) {
        throw "目录里没有 .s2voice 音色可供复制：$VoiceDir"
    }
}
elseif (-not (Test-Path -LiteralPath $Source)) {
    throw "样板音色不存在：$Source"
}

Write-Host "样板音色：$Source" -ForegroundColor Cyan
Write-Host "目标目录：$VoiceDir" -ForegroundColor Cyan
Write-Host ""

# gender\personality\tone
$layout = @(
    '女\妩媚\生气.s2voice'
    '女\妩媚\温柔.s2voice'
    '女\妩媚\撒娇.s2voice'
    '女\高冷\默认.s2voice'
    '女\高冷\生气.s2voice'
    '女\活泼\开心.s2voice'
    '女\活泼\平静.s2voice'
    '男\阳光\默认.s2voice'
    '男\阳光\开心.s2voice'
    '男\沉稳\生气.s2voice'
    '男\沉稳\平静.s2voice'
)

$created = 0
$skipped = 0
foreach ($relative in $layout) {
    $target = Join-Path $VoiceDir $relative
    $folder = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
    if (Test-Path -LiteralPath $target) {
        Write-Host "  跳过（已存在）$relative" -ForegroundColor DarkGray
        $skipped++
        continue
    }
    Copy-Item -LiteralPath $Source -Destination $target -Force
    Write-Host "  新建 $relative" -ForegroundColor Green
    $created++
}

Write-Host ""
Write-Host "完成：新建 $created 个，跳过 $skipped 个。" -ForegroundColor Cyan
Write-Host ""
Write-Host "现在可以在回复里写标签了：" -ForegroundColor Cyan
Write-Host "  小雅·女·妩媚·生气·：“你怎么才来！”" -ForegroundColor White
Write-Host ""
Write-Host "冒号后面才是会被朗读的内容，标签本身不会被念出来。" -ForegroundColor DarkGray
Write-Host "把这些样板换成你自己的音色即可。" -ForegroundColor DarkGray
