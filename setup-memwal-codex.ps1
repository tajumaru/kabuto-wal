param(
    [string]$ConfigPath = (Join-Path $HOME ".codex\config.toml")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ConfigPath)) {
    throw "Codex config not found: $ConfigPath"
}

$backupPath = "$ConfigPath.bak-memwal-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $ConfigPath -Destination $backupPath

$text = Get-Content -Raw -LiteralPath $ConfigPath

$text = $text -replace '(?ms)(\[plugins\."memwal@memwal-plugins"\]\s*enabled\s*=\s*)true', '${1}false'

if ($text -notmatch '(?m)^\[mcp_servers\.memwal\]\s*$') {
    $block = @'

[mcp_servers.memwal]
command = "npx"
args = ["-y", "@mysten-incubation/memwal-mcp@0.0.14-dev.6"]
startup_timeout_sec = 120

[mcp_servers.memwal.env]
MEMWAL_AUTO_SAVE = "0"
'@
    $text = $text.TrimEnd() + $block + [Environment]::NewLine
}

Set-Content -LiteralPath $ConfigPath -Value $text -Encoding UTF8

Write-Host "Updated $ConfigPath"
Write-Host "Backup saved to $backupPath"
Write-Host "Restart Codex, then ask the agent to run memwal_health or memwal_login."
