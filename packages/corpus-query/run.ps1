param(
  [int]$Port = 8089,
  [string]$ListenHost = "127.0.0.1",
  [string]$DbPath = (Join-Path $PSScriptRoot "corpus.sqlite")
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$serverScript = Join-Path $repoRoot "dist\mcp\server.js"
$proxyScript = Join-Path $repoRoot "node_modules\mcp-proxy\dist\bin\mcp-proxy.mjs"

if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "Built MCP server not found at $serverScript. Run 'pnpm build' first."
}

if (-not (Test-Path -LiteralPath $proxyScript)) {
  throw "mcp-proxy is not installed at $proxyScript. Run 'pnpm add mcp-proxy' first."
}

$resolvedDbPath = [System.IO.Path]::GetFullPath($DbPath)
if (-not (Test-Path -LiteralPath $resolvedDbPath)) {
  throw "Corpus database not found at $resolvedDbPath."
}

$env:BW_REPLAY_DB_PATH = $resolvedDbPath

Write-Host "Starting bw_replay MCP bridge"
Write-Host "MCP URL: http://$ListenHost`:$Port/mcp"
Write-Host "Corpus: $resolvedDbPath"
Write-Host ""

& node $proxyScript --host $ListenHost --port $Port --server stream -- node $serverScript
