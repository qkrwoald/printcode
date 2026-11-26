#!/usr/bin/env bash
# PrintCode 업데이트: 최신 코드 받기 → 의존성·빌드 → 재시작.  사용법: bash /opt/printcode/deploy/update.sh
# 재시작하면 지금 열린 WebSocket(인쇄 중·대기 중 화면)이 끊기므로 사용자가 없을 때 하세요.
# 이미 올라와 있는 암호문·코드는 디스크(DB)에 있어 그대로 남는다. 횟수 제한 기록은 초기화된다.
set -euo pipefail
cd /opt/printcode
git pull --ff-only
.venv/bin/pip install -q -r backend/requirements.txt
(cd frontend && npm ci --no-audit --no-fund && npm run build)
sudo install -m 0644 deploy/printcode.service /etc/systemd/system/printcode.service
sudo systemctl daemon-reload
sudo systemctl restart printcode
sleep 2
systemctl --no-pager --lines=5 status printcode
