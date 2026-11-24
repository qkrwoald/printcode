"""WebSocket 엔드포인트.

/ws/upload  업로더 화면이 상태(받아 감·출력 완료·닫힘·삭제·만료)를 실시간으로 받는다.
/ws/print   출력 창이 열려 있는 동안 연결을 유지하고, 인쇄가 끝나면 'printed'를 보낸다.
            '출력 완료'를 받거나 연결이 끊기면 서버는 즉시 기록을 지운다.

토큰은 URL이 아니라 연결 후 첫 메시지로 받는다 — 접속 로그에 남지 않게 하기 위해.
"""
import asyncio
import hashlib
import hmac
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import config, db, lifecycle, ratelimit
from .lifecycle import hub
from .schemas import PrintHello, PrintMessage, UploaderHello, b64u_decode

router = APIRouter()

# 사용자 정의 종료 코드
CLOSE_BAD_REQUEST = 4400
CLOSE_FORBIDDEN = 4403


# IP별 동시 연결 수 (이벤트 루프 안에서만 바뀌므로 잠금이 필요 없다)
_open: dict[str, int] = {}


async def _admit(ws: WebSocket) -> str | None:
    """출처를 확인하고 IP별 동시 연결 수를 넘지 않으면 연결을 받는다. 받으면 IP를 돌려준다."""
    ip = ratelimit.client_ip(ws)
    if not _same_origin(ws) or _open.get(ip, 0) >= config.WS_PER_IP:
        await ws.close(code=CLOSE_FORBIDDEN)  # 수락 전에 닫으면 연결 자체가 거절된다
        return None
    _open[ip] = _open.get(ip, 0) + 1
    await ws.accept()
    return ip


def _release(ip: str) -> None:
    left = _open.get(ip, 1) - 1
    if left > 0:
        _open[ip] = left
    else:
        _open.pop(ip, None)


def _sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def _same_origin(ws: WebSocket) -> bool:
    """다른 사이트의 페이지가 사용자 브라우저를 통해 몰래 연결하는 것(CSWSH)을 막는다.
    WebSocket에는 같은 출처 정책이 적용되지 않으므로 Origin을 직접 확인해야 한다."""
    origin = ws.headers.get("origin")
    host = ws.headers.get("host")
    return bool(origin and host) and urlsplit(origin).netloc == host


async def _hello(ws: WebSocket, model):
    """첫 메시지를 정해진 시간 안에 받아 스키마로 검증한다. 실패하면 None."""
    try:
        data = await asyncio.wait_for(ws.receive_json(), config.WS_HELLO_TIMEOUT)
        return model.model_validate(data)
    except (asyncio.TimeoutError, ValidationError, ValueError, KeyError, WebSocketDisconnect):
        return None


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


def _owner_row(code: str):
    with db.connect() as conn:
        return conn.execute(
            "SELECT status, owner_token_hash FROM files WHERE code = ?", (code,)
        ).fetchone()


def _attach_print(claim_hash: bytes):
    """받아 간 파일에 출력 창을 연결한다. 한 번만 연결할 수 있다 (토큰 재사용 방지)."""
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT code FROM files WHERE claim_token_hash = ? AND status = 'claimed' "
            "AND print_connected = 0",
            (claim_hash,),
        ).fetchone()
        if row is None:
            return None
        conn.execute("UPDATE files SET print_connected = 1 WHERE code = ?", (row["code"],))
        return row["code"]


@router.websocket("/ws/upload")
async def uploader_socket(ws: WebSocket):
    ip = await _admit(ws)
    if ip is None:
        return
    try:
        await _uploader(ws)
    finally:
        _release(ip)


async def _uploader(ws: WebSocket):
    hello = await _hello(ws, UploaderHello)
    if hello is None:
        await _close(ws, CLOSE_BAD_REQUEST)
        return
    row = await asyncio.to_thread(_owner_row, hello.code)
    token_hash = _sha256(b64u_decode(hello.owner_token))
    if row is None or not hmac.compare_digest(row["owner_token_hash"], token_hash):
        await _close(ws, CLOSE_FORBIDDEN)
        return

    hub.add(hello.code, ws)
    try:
        await ws.send_json({"event": "printing" if row["status"] == "claimed" else "waiting"})
        while True:
            await ws.receive_text()  # 업로더가 보내는 메시지는 없다. 연결만 유지한다.
    except WebSocketDisconnect:
        pass
    finally:
        hub.remove(hello.code, ws)


@router.websocket("/ws/print")
async def print_socket(ws: WebSocket):
    ip = await _admit(ws)
    if ip is None:
        return
    try:
        await _printer(ws)
    finally:
        _release(ip)


async def _printer(ws: WebSocket):
    hello = await _hello(ws, PrintHello)
    if hello is None:
        await _close(ws, CLOSE_BAD_REQUEST)
        return
    code = await asyncio.to_thread(_attach_print, _sha256(b64u_decode(hello.claim_token)))
    if code is None:
        await _close(ws, CLOSE_FORBIDDEN)
        return

    event = "closed"  # 'printed'를 받기 전에 끊기면 인쇄 없이 닫힌 것으로 본다
    try:
        await ws.send_json({"ok": True})
        while True:
            try:
                PrintMessage.model_validate(await ws.receive_json())
            except ValidationError:
                continue
            event = "printed"
            break
    except (WebSocketDisconnect, ValueError):
        pass
    finally:
        await asyncio.to_thread(lifecycle.finalize, code, event)
    await _close(ws, 1000)
