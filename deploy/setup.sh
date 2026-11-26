#!/usr/bin/env bash
# PrintCode 서버 처음 설치 (Ubuntu 24.04, Oracle Cloud ARM 기준). 한 번만 실행한다.
#
# 사용법 (README "Oracle에 배포하기" 참고):
#   sudo git clone https://github.com/<계정>/<저장소>.git /opt/printcode
#   sudo chown -R "$USER": /opt/printcode
#   sudo bash /opt/printcode/deploy/setup.sh <주소>      예: printcode-xx.duckdns.org
#
# 하는 일: 패키지 설치(Caddy·Node 22·Python) → 서버 안 방화벽 80·443 열기 → 전용 계정 →
#          Python 가상환경·프론트 빌드 → 설정 파일 설치 → 서비스 시작
set -euo pipefail

DOMAIN="${1:-}"
APP=/opt/printcode
BUILDER="${SUDO_USER:-}" # 빌드는 root가 아닌 일반 계정으로 (npm 스크립트를 root로 돌리지 않기 위해)

if [[ $EUID -ne 0 ]]; then echo "sudo로 실행하세요."; exit 1; fi
if [[ -z "$DOMAIN" || ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "주소를 넣으세요. 예: sudo bash setup.sh printcode-xx.duckdns.org"; exit 1; fi
if [[ -z "$BUILDER" || "$BUILDER" == root ]]; then echo "일반 계정에서 sudo로 실행하세요 (예: ubuntu)."; exit 1; fi
if [[ ! -d "$APP/.git" ]]; then echo "$APP 에 저장소가 없습니다. 먼저 git clone 하세요."; exit 1; fi

echo "== 1/6 패키지 설치"
apt-get update
apt-get install -y python3-venv git curl gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent
# Caddy (공식 저장소)
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
# Node.js 22 (우분투 기본 Node 18은 Vite 8에 너무 오래됨) — NodeSource 공식 저장소
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== 2/6 서버 안 방화벽(iptables) 80·443 열기"
# Oracle 우분투 이미지는 VCN 보안 목록과 별개로 iptables가 22번 말고는 다 막는다(REJECT 규칙).
# REJECT 규칙 바로 앞에 허용 규칙을 넣고 저장한다 (재부팅 후에도 유지).
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    pos=$(iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
  fi
done
netfilter-persistent save

echo "== 3/6 전용 계정 printcode (로그인 불가)"
id printcode >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/printcode --shell /usr/sbin/nologin printcode

echo "== 4/6 Python 가상환경·프론트 빌드 ($BUILDER 계정으로)"
chown -R "$BUILDER": "$APP"
sudo -u "$BUILDER" bash -c "cd '$APP' && python3 -m venv .venv && .venv/bin/pip install -q -r backend/requirements.txt"
sudo -u "$BUILDER" bash -c "cd '$APP/frontend' && npm ci --no-audit --no-fund && npm run build"

echo "== 5/6 설정 파일"
[[ -f /etc/printcode.env ]] || install -m 0640 -o root -g printcode "$APP/deploy/printcode.env.example" /etc/printcode.env
install -m 0644 "$APP/deploy/printcode.service" /etc/systemd/system/printcode.service
sed "s/^PRINTCODE_DOMAIN {/$DOMAIN {/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== 6/6 서비스 시작"
systemctl daemon-reload
systemctl enable --now printcode
systemctl reload caddy || systemctl restart caddy
sleep 2
systemctl --no-pager --lines=5 status printcode || true

echo
echo "완료: https://$DOMAIN (인증서 발급에 1분 정도 걸릴 수 있음)"
echo "업데이트할 때: bash $APP/deploy/update.sh"
