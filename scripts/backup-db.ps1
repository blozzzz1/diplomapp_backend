# Бэкап БД Supabase через pg_dump.
# Требуется: PostgreSQL client (pg_dump в PATH), DATABASE_URL в backend/.env
#
# Только схема (таблицы, без данных):
#   .\backend\scripts\backup-db.ps1 -SchemaOnly
# Полный бэкап (схема + данные):
#   .\backend\scripts\backup-db.ps1
#
# DATABASE_URL в backend/.env — см. docs/BACKUP_SUPABASE.md

param([switch]$SchemaOnly)

$ErrorActionPreference = "Stop"
$backendDir = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { ".." }
$envPath = Join-Path $backendDir ".env"
$outDir = Join-Path $backendDir "backups"
$date = Get-Date -Format "yyyyMMdd_HHmm"
$suffix = if ($SchemaOnly) { "schema" } else { "full" }
$outFile = Join-Path $outDir "supabase_${suffix}_$date.sql"

if (-not (Test-Path $envPath)) {
    Write-Error "Файл не найден: $envPath. Добавь DATABASE_URL в backend/.env (см. docs/BACKUP_SUPABASE.md)."
    exit 1
}

$dbUrl = Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)$') {
        $matches[1].Trim().Trim('"').Trim("'")
    }
} | Where-Object { $_ } | Select-Object -First 1

if (-not $dbUrl) {
    Write-Error "В $envPath не задан DATABASE_URL. Пример: DATABASE_URL=postgresql://postgres.xxx:PASSWORD@...pooler.supabase.com:6543/postgres"
    exit 1
}

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    Write-Error "pg_dump не найден. Установи PostgreSQL (https://www.postgresql.org/download/windows/) и добавь bin в PATH."
    exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$schemaArg = if ($SchemaOnly) { @("--schema-only") } else { @() }
Write-Host "Бэкап в: $outFile" $(if ($SchemaOnly) { "(только схема)" } else { "(схема + данные)" })
& pg_dump $dbUrl --no-owner --no-acl -F p $schemaArg -f $outFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "pg_dump завершился с ошибкой."
    exit $LASTEXITCODE
}
Write-Host "Готово. Размер: $((Get-Item $outFile).Length / 1MB) MB"
