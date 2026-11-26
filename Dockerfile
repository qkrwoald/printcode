# PrintCode 이미지 (Railway 등 컨테이너 플랫폼용). Oracle·VPS에 직접 설치할 때는 deploy/setup.sh를 쓴다.
# 1단계: 프론트 빌드 (Node는 빌드에만 쓰고 최종 이미지에는 넣지 않는다)
FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2단계: 서버 (Python + 빌드된 화면 파일만)
FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PRINTCODE_DATA_DIR=/data
WORKDIR /app
COPY backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt \
 && useradd --system --no-create-home --shell /usr/sbin/nologin printcode
COPY backend/ backend/
COPY --from=web /app/frontend/dist frontend/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
