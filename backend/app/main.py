import asyncio
import contextlib
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, lifecycle, ratelimit, ws
from .api import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    lifecycle.hub.bind(asyncio.get_running_loop())
    sweeper = asyncio.create_task(lifecycle.sweeper())
    yield
    sweeper.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await sweeper


# API 문서 페이지는 외부 CDN 스크립트를 쓰고 공격 표면만 늘리므로 끈다.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router)
app.include_router(ws.router)

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
    # 다른 사이트 창과 브라우저 문맥을 공유하지 않는다 (우리가 연 같은 사이트 출력 창은 그대로 연결됨)
    "Cross-Origin-Opener-Policy": "same-origin",
    # COOP와 함께 '교차 출처 격리'를 켠다: 문서 변환기(LibreOffice WASM)가 SharedArrayBuffer를 쓰려면 필요.
    # 우리 리소스는 모두 같은 사이트라 영향이 없고, 다른 사이트 리소스는 원래도 쓰지 않는다.
    "Cross-Origin-Embedder-Policy": "require-corp",
    # 우리 파일(스크립트·글꼴·암호문)을 다른 사이트가 끌어다 쓰지 못하게 한다
    "Cross-Origin-Resource-Policy": "same-origin",
    # 쓰지 않는 브라우저 기능은 꺼 둔다. 로컬 글꼴 접근(문서 변환용)은 우리 사이트에만 허용.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), local-fonts=(self)",
}
# HSTS: HTTPS로 접속했을 때만 붙인다 (http에서는 의미 없음). 프록시 뒤에서는 X-Forwarded-Proto로 판단.
HSTS = "max-age=31536000"
# 내용이 바뀌면 이름(해시·버전)도 바뀌는 정적 파일은 오래 캐시해도 안전하다.
# 특히 문서 변환기(약 240MB)는 매번 받지 않도록 캐시한다. 사용자 데이터가 없는 파일만 해당.
IMMUTABLE_PREFIXES = ("/assets/", "/converter/")
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

# 문서 변환기(LibreOffice WASM) 워커 전용 CSP. 변환기 내부(embind)가 실행 중에 함수를 문자열로 만들어
# 실행(new Function)하므로 'unsafe-eval'이 필요하다. 워커는 자기 스크립트 응답의 CSP를 따르므로,
# 이 완화는 /converter/ 아래 워커에만 적용되고 화면(페이지)의 CSP는 그대로 엄격하다.
# 워커는 화면(DOM)·쿠키에 접근할 수 없고, 다루는 것은 사용자가 고른 문서뿐이다.
CONVERTER_CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
        "worker-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
    ]
)


def _cross_site(request: Request) -> bool:
    """다른 사이트에서 보낸 요청인지. 쿠키를 쓰지 않아 CSRF로 얻을 것은 거의 없지만,
    다른 사이트가 사용자 브라우저를 통해 코드를 발급·조회하는 일 자체를 막는다."""
    if request.headers.get("sec-fetch-site") == "cross-site":
        return True
    origin = request.headers.get("origin")
    return bool(origin) and urlsplit(origin).netloc != request.headers.get("host")


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    response = None
    path = request.url.path
    if request.method == "POST" and path.startswith("/api/"):
        # 본문을 읽기 전에 출처와 크기를 먼저 확인해 일찍 거절한다.
        length = request.headers.get("content-length", "")
        if path == "/api/uploads":
            limit = config.MAX_BLOB_BYTES + 16 * 1024 if config.MAX_BLOB_BYTES else None  # 폼 필드 여유분
        else:
            limit = config.MAX_JSON_BYTES
        if _cross_site(request):
            response = JSONResponse({"detail": "Cross-site request blocked."}, status_code=403)
        elif length and not length.isdigit():
            response = JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
        elif limit is not None and not length and path == "/api/uploads":
            response = JSONResponse({"detail": "Content-Length required."}, status_code=411)
        elif limit is not None and length and int(length) > limit:
            response = JSONResponse({"detail": "File too large."}, status_code=413)
    if response is None:
        response = await call_next(request)
    response.headers.update(SECURITY_HEADERS)
    if request.method == "GET" and path.startswith(IMMUTABLE_PREFIXES) and response.status_code == 200:
        response.headers["Cache-Control"] = IMMUTABLE_CACHE
    if path.startswith("/converter/") and path.endswith(".js"):
        response.headers["Content-Security-Policy"] = CONVERTER_CSP
    # 플랫폼 프록시 뒤(PROXY_HOPS>0)에서는 TLS를 프록시가 처리하므로 X-Forwarded-Proto의 마지막 값을 본다.
    # 이 헤더는 HSTS를 붙일지만 정하므로(조작돼도 해가 없음) IP처럼 hops를 세지 않는다.
    forwarded_https = (
        config.PROXY_HOPS > 0
        and request.headers.get("x-forwarded-proto", "").split(",")[-1].strip() == "https"
    )
    if request.url.scheme == "https" or forwarded_https:
        response.headers["Strict-Transport-Security"] = HSTS
    return response


if config.FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="static")
