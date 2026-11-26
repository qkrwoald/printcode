"""IP별 요청 횟수 제한 (메모리 기반, 서버 프로세스 하나 기준).

- Window: 최근 window초 동안 limit번까지 허용 (슬라이딩 윈도).
- MissGuard: 없는 코드 조회(=코드 추측)를 세다가 한도를 넘으면 한동안 조회를 막는다.
  코드는 6자리뿐이라, 실패를 엄격히 세는 것이 대입 공격을 늦추는 핵심이다.

여러 프로세스로 띄우면 프로세스마다 따로 센다 (배포 시 단일 프로세스 권장 — SECURITY.md).
IP 원문은 메모리에만 두고 기록(로그)하지 않는다.
"""
import threading
import time
from collections import deque

from fastapi import HTTPException, Request

from . import config

# 테스트에서 시간을 앞당길 수 있도록 시계를 바꿔 끼울 수 있게 둔다.
clock = time.monotonic


class Window:
    def __init__(self, limit: int, seconds: int) -> None:
        self.limit = limit
        self.seconds = seconds
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        """한 번 사용을 기록한다. 한도를 넘으면 기록하지 않고 False."""
        now = clock()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - self.seconds:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def prune(self) -> None:
        now = clock()
        with self._lock:
            for key in [k for k, q in self._hits.items() if not q or q[-1] <= now - self.seconds]:
                del self._hits[key]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


class MissGuard:
    def __init__(self, limit: int, seconds: int, block_seconds: int) -> None:
        self._misses = Window(limit, seconds)
        self._blocked: dict[str, float] = {}
        self._block = block_seconds
        self._lock = threading.Lock()

    def blocked(self, key: str) -> bool:
        with self._lock:
            until = self._blocked.get(key)
            if until is None:
                return False
            if until <= clock():
                del self._blocked[key]
                return False
            return True

    def miss(self, key: str) -> None:
        if not self._misses.hit(key):
            with self._lock:
                self._blocked[key] = clock() + self._block

    def prune(self) -> None:
        self._misses.prune()
        now = clock()
        with self._lock:
            for key in [k for k, until in self._blocked.items() if until <= now]:
                del self._blocked[key]

    def reset(self) -> None:
        self._misses.reset()
        with self._lock:
            self._blocked.clear()


upload_limit = Window(*config.RATE_UPLOAD)
lookup_limit = Window(*config.RATE_LOOKUP)
miss_guard = MissGuard(*config.MISS_LIMIT, config.MISS_BLOCK_SECONDS)


def forwarded_entry(conn, header: str) -> str | None:
    """PROXY_HOPS가 켜져 있을 때, 프록시 헤더에서 '오른쪽에서 PROXY_HOPS번째' 값을 꺼낸다.

    왜 오른쪽부터인가: 접속자는 X-Forwarded-For에 아무 값이나 미리 적어 보낼 수 있고,
    프록시는 자기가 본 실제 접속 IP를 '맨 끝에 덧붙인다'. 그래서 왼쪽 값은 조작될 수 있고,
    우리가 믿는 프록시 수(hops)만큼 오른쪽에서 센 값만 조작할 수 없다.
    """
    hops = config.PROXY_HOPS
    if hops <= 0:
        return None
    parts = [p.strip() for p in conn.headers.get(header, "").split(",") if p.strip()]
    return parts[-hops] if len(parts) >= hops else None


def client_ip(conn) -> str:
    """접속자 IP.
    - 같은 서버의 프록시(Caddy·터널) 뒤: uvicorn --proxy-headers가 127.0.0.1에서 온 값만 믿고 바꿔 준다.
    - 주소가 바뀌는 플랫폼 프록시(Railway 등) 뒤: PRINTCODE_PROXY_HOPS로 믿을 프록시 수를 정한다.
    """
    return forwarded_entry(conn, "x-forwarded-for") or (conn.client.host if conn.client else "unknown")


def _too_many(seconds: int) -> HTTPException:
    return HTTPException(
        429, "Too many requests. Try again later.", headers={"Retry-After": str(seconds)}
    )


def limit_upload(request: Request) -> None:
    if not upload_limit.hit(client_ip(request)):
        raise _too_many(upload_limit.seconds)


def limit_lookup(request: Request) -> None:
    ip = client_ip(request)
    if miss_guard.blocked(ip):
        raise _too_many(config.MISS_BLOCK_SECONDS)
    if not lookup_limit.hit(ip):
        raise _too_many(lookup_limit.seconds)


def record_miss(request: Request) -> None:
    miss_guard.miss(client_ip(request))


def prune() -> None:
    for item in (upload_limit, lookup_limit, miss_guard):
        item.prune()


def reset_all() -> None:
    for item in (upload_limit, lookup_limit, miss_guard):
        item.reset()
