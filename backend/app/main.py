from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .api import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    yield


# API 문서 페이지는 외부 CDN 스크립트를 쓰고 공격 표면만 늘리므로 끈다.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router)

# 엄격한 CSP: 우리 서버의 스크립트만 실행. 인라인 스크립트·외부 CDN 금지 (XSS 방지)
# 'wasm-unsafe-eval'은 hash-wasm(Argon2id)의 WebAssembly 실행에만 필요하다 (JS eval은 여전히 금지).
CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    # 공용 PC에서 뒤로 가기·캐시로 화면이나 데이터가 복구되지 않도록 저장 금지
    "Cache-Control": "no-store",
}
# HSTS는 HTTPS에서만 의미가 있으므로 배포 단계(리버스 프록시)에서 붙인다.


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    response = None
    if (
        request.method == "POST"
        and request.url.path == "/api/uploads"
        and config.MAX_BLOB_BYTES is not None
    ):
        # 본문을 읽기 전에 크기를 먼저 확인해 큰 업로드를 일찍 거절한다.
        length = request.headers.get("content-length", "")
        if not length.isdigit():
            response = JSONResponse({"detail": "Content-Length가 필요합니다."}, status_code=411)
        elif int(length) > config.MAX_BLOB_BYTES + 16 * 1024:  # 폼 필드 여유분
            response = JSONResponse({"detail": "파일이 너무 큽니다."}, status_code=413)
    if response is None:
        response = await call_next(request)
    response.headers.update(SECURITY_HEADERS)
    return response


if config.FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="static")
