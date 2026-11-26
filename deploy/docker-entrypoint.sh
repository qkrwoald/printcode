#!/bin/sh
# 컨테이너 시작: 데이터 폴더(볼륨) 권한을 맞춘 뒤 root 권한을 버리고 전용 계정으로 서버를 띄운다.
# 왜: 플랫폼 볼륨은 root 소유로 붙는 경우가 많아, 일반 계정으로 바로 띄우면 DB·암호문을 쓸 수 없다.
#     그렇다고 서버를 root로 돌리면 침해 시 피해가 커지므로, 폴더 권한만 root로 고치고 바로 내려간다.
set -eu
mkdir -p "$PRINTCODE_DATA_DIR"
chown -R printcode:printcode "$PRINTCODE_DATA_DIR"
chmod 700 "$PRINTCODE_DATA_DIR"
# 반드시 프로세스 1개: 횟수 제한·추측 차단·WebSocket 알림이 메모리에 있다.
# --no-access-log: 요청마다 접속 IP를 기록하지 않는다 (오류는 기록).
exec setpriv --reuid=printcode --regid=printcode --init-groups --inh-caps=-all \
  python -m uvicorn --app-dir backend app.main:app \
  --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 \
  --no-access-log --no-server-header
