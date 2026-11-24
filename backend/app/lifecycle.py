"""파일 수명 관리: 업로더 알림(hub), 출력 종료 처리, 만료·멈춘 출력 정리.

업로더에게 보내는 이벤트
  printing  출력 PC가 파일을 받아 감
  printed   출력 창이 인쇄 완료를 알림
  closed    출력 창이 인쇄 없이 닫히거나 연결이 끊김
  deleted   확인코드를 여러 번 틀려 삭제됨
  expired   유효 시간이 지나 삭제됨
"""
import asyncio
import logging
import time

from fastapi import WebSocket

from . import config, db, ratelimit, storage

log = logging.getLogger("printcode")


class Hub:
    """코드별로 업로더 WebSocket을 모아 두고 이벤트를 보낸다.
    API(스레드풀)와 WebSocket(이벤트 루프) 양쪽에서 호출되므로 루프로 안전하게 넘긴다."""

    def __init__(self) -> None:
        self._subs: dict[str, set[WebSocket]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add(self, code: str, ws: WebSocket) -> None:
        self._subs.setdefault(code, set()).add(ws)

    def remove(self, code: str, ws: WebSocket) -> None:
        subs = self._subs.get(code)
        if subs:
            subs.discard(ws)
            if not subs:
                del self._subs[code]

    def notify(self, code: str, event: str) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        coro = self._send(code, event)
        if running is loop:
            loop.create_task(coro)
        else:
            asyncio.run_coroutine_threadsafe(coro, loop)

    async def _send(self, code: str, event: str) -> None:
        for ws in list(self._subs.get(code, ())):
            try:
                await ws.send_json({"event": event})
            except Exception:
                self.remove(code, ws)


hub = Hub()


def finalize(code: str, event: str) -> None:
    """출력이 끝난(완료·닫힘) 파일 기록을 지우고 업로더에게 알린다. 이미 지워졌으면 아무것도 안 함."""
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT blob_name FROM files WHERE code = ? AND status = 'claimed'", (code,)
        ).fetchone()
        if row is None:
            return
        conn.execute("DELETE FROM files WHERE code = ?", (code,))
    storage.delete(row["blob_name"])  # 보통 받아 갈 때 이미 지워져 NULL
    hub.notify(code, event)


def purge(now: float) -> None:
    """만료된 예약·파일과, 출력 창이 연결되지 않았거나 멈춘 출력을 정리한다."""
    stale_args = (now - config.CLAIM_CONNECT_TIMEOUT, now - config.CLAIM_MAX_SECONDS)
    with db.transaction() as conn:
        expired = conn.execute(
            "SELECT code, status, blob_name FROM files WHERE status != 'claimed' AND expires_at < ?",
            (now,),
        ).fetchall()
        stale = conn.execute(
            "SELECT code FROM files WHERE status = 'claimed' "
            "AND ((print_connected = 0 AND claimed_at < ?) OR claimed_at < ?)",
            stale_args,
        ).fetchall()
        conn.execute("DELETE FROM files WHERE status != 'claimed' AND expires_at < ?", (now,))
        conn.execute(
            "DELETE FROM files WHERE status = 'claimed' "
            "AND ((print_connected = 0 AND claimed_at < ?) OR claimed_at < ?)",
            stale_args,
        )
    for row in expired:
        storage.delete(row["blob_name"])
        if row["status"] == "ready":
            hub.notify(row["code"], "expired")
    for row in stale:
        hub.notify(row["code"], "closed")


async def sweeper() -> None:
    """주기적으로 purge를 실행한다 (앱 수명 동안)."""
    while True:
        await asyncio.sleep(config.SWEEP_INTERVAL)
        try:
            await asyncio.to_thread(purge, time.time())
            ratelimit.prune()  # 오래된 IP 기록 정리 (메모리가 계속 늘지 않게)
        except Exception:
            # 코드·토큰 같은 민감 정보는 남기지 않고 실패 사실만 기록
            log.exception("sweep failed")
