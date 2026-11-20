# 시험용: 프론트를 빌드하고, 로컬 서버를 띄운 뒤 Cloudflare 임시 터널로 HTTPS 주소를 연다.
# 사용: 프로젝트 폴더에서  .\scripts\tunnel.ps1
# 종료: Ctrl+C (서버도 함께 종료됨)
#
# 주의: M4(요청 횟수 제한) 전이므로 시험할 때만 켜고, 주소를 공개적으로 퍼뜨리지 않는다.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$port = 8000

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host 'cloudflared가 없습니다. 먼저 설치하세요:  winget install --id Cloudflare.cloudflared' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $python)) {
    Write-Host '.venv가 없습니다. README의 "최초 1회" 단계를 먼저 실행하세요.' -ForegroundColor Red
    exit 1
}

Write-Host '[1/3] 프론트엔드 빌드' -ForegroundColor Cyan
Push-Location (Join-Path $root 'frontend')
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }
} finally {
    Pop-Location
}

Write-Host "[2/3] 서버 시작 (127.0.0.1:$port)" -ForegroundColor Cyan
# 127.0.0.1에만 열어 같은 네트워크의 다른 기기가 직접 접속하지 못하게 하고, 외부 접속은 터널로만 받는다.
# --proxy-headers: 터널이 붙이는 X-Forwarded-* 헤더로 실제 접속자 IP를 알 수 있게 한다 (M4 IP 제한 대비).
$server = Start-Process -FilePath $python -PassThru -NoNewWindow -ArgumentList @(
    '-m', 'uvicorn', '--app-dir', (Join-Path $root 'backend'), 'app.main:app',
    '--host', '127.0.0.1', '--port', $port,
    '--proxy-headers', '--forwarded-allow-ips', '127.0.0.1'
)

try {
    Start-Sleep -Seconds 2
    if ($server.HasExited) { throw '서버가 시작되지 않았습니다. 포트 8000을 다른 프로그램이 쓰고 있는지 확인하세요.' }

    Write-Host '[3/3] 터널 연결 — 아래 로그에 나오는 https://....trycloudflare.com 주소로 접속하세요' -ForegroundColor Cyan
    Write-Host '      업로드: <주소>/      출력: <주소>/print/' -ForegroundColor Cyan
    cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port"
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Write-Host '서버를 종료했습니다.' -ForegroundColor Cyan
}
