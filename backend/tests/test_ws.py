"""M2: 받아 감(claim) → 출력 창 WebSocket → 완료/닫힘 처리와 업로더 알림 테스트."""
import hashlib
import os
import sqlite3
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from app import config, lifecycle
from app.schemas import b64u_encode

ORIGIN = {"origin": "http://testserver"}


def upload(client):
    """예약 → 업로드. (code, owner_token, auth_token) 반환."""
    reserved = client.post("/api/codes").json()
    auth_token = os.urandom(32)
    res = client.post(
        "/api/uploads",
        data={
            "code": reserved["code"],
            "upload_token": reserved["upload_token"],
            "salt": b64u_encode(os.urandom(16)),
            "auth_hash": b64u_encode(hashlib.sha256(auth_token).digest()),
            "kdf_m": 65536,
            "kdf_t": 3,
            "kdf_p": 1,
            "has_phrase": "false",
        },
        files={"blob": ("blob", b"\x01" + os.urandom(500), "application/octet-stream")},
    )
    assert res.status_code == 201
    return reserved["code"], reserved["upload_token"], auth_token


def claim(client, code, auth_token):
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(auth_token)})
    assert res.status_code == 200
    return res.headers["x-claim-token"]


def subscribe(client, code, owner_token):
    ws = client.websocket_connect("/ws/upload", headers=ORIGIN)
    sock = ws.__enter__()
    sock.send_json({"code": code, "owner_token": owner_token})
    return ws, sock


def row(code):
    with sqlite3.connect(config.DB_PATH) as conn:
        return conn.execute("SELECT status FROM files WHERE code = ?", (code,)).fetchone()


def blob_count():
    return len(list(config.BLOB_DIR.iterdir()))


def test_claim_locks_file_and_deletes_ciphertext(client):
    code, _, auth = upload(client)
    before = blob_count()
    token = claim(client, code, auth)
    assert len(token) == 43
    assert row(code)[0] == "claimed"
    assert blob_count() == before - 1  # 받아 가는 즉시 서버 암호문 삭제
    # 받아 간 파일은 다시 조회·수령 불가
    assert client.post("/api/lookup", json={"code": code}).status_code == 404
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(auth)})
    assert res.status_code == 404


def test_print_done_notifies_uploader(client):
    code, owner, auth = upload(client)
    ctx, up = subscribe(client, code, owner)
    assert up.receive_json() == {"event": "waiting"}

    token = claim(client, code, auth)
    assert up.receive_json() == {"event": "printing"}

    with client.websocket_connect("/ws/print", headers=ORIGIN) as pr:
        pr.send_json({"claim_token": token})
        assert pr.receive_json() == {"ok": True}
        pr.send_json({"type": "printed"})
    assert up.receive_json() == {"event": "printed"}
    assert row(code) is None
    ctx.__exit__(None, None, None)


def test_print_window_closed_without_printing(client):
    code, owner, auth = upload(client)
    ctx, up = subscribe(client, code, owner)
    up.receive_json()
    token = claim(client, code, auth)
    up.receive_json()
    with client.websocket_connect("/ws/print", headers=ORIGIN) as pr:
        pr.send_json({"claim_token": token})
        pr.receive_json()
        # 'printed' 없이 창이 닫힘(연결 끊김)
    assert up.receive_json() == {"event": "closed"}
    assert row(code) is None
    ctx.__exit__(None, None, None)


def test_claim_token_works_only_once(client):
    code, _, auth = upload(client)
    token = claim(client, code, auth)
    with client.websocket_connect("/ws/print", headers=ORIGIN) as pr:
        pr.send_json({"claim_token": token})
        pr.receive_json()
        # 같은 토큰으로 두 번째 출력 창은 연결할 수 없다
        with client.websocket_connect("/ws/print", headers=ORIGIN) as pr2:
            pr2.send_json({"claim_token": token})
            with pytest.raises(WebSocketDisconnect) as e:
                pr2.receive_json()
            assert e.value.code == 4403


def test_unconnected_claim_is_swept(client):
    code, owner, auth = upload(client)
    ctx, up = subscribe(client, code, owner)
    up.receive_json()
    claim(client, code, auth)
    up.receive_json()
    lifecycle.purge(time.time() + config.CLAIM_CONNECT_TIMEOUT + 1)
    assert up.receive_json() == {"event": "closed"}
    assert row(code) is None
    ctx.__exit__(None, None, None)


def test_expired_file_notifies_uploader(client):
    code, owner, _ = upload(client)
    ctx, up = subscribe(client, code, owner)
    up.receive_json()
    lifecycle.purge(time.time() + config.FILE_TTL_SECONDS + 1)
    assert up.receive_json() == {"event": "expired"}
    assert row(code) is None
    ctx.__exit__(None, None, None)


def test_too_many_failures_notifies_uploader(client):
    code, owner, _ = upload(client)
    ctx, up = subscribe(client, code, owner)
    up.receive_json()
    for _ in range(config.MAX_FAILED_ATTEMPTS):
        client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(os.urandom(32))})
    assert up.receive_json() == {"event": "deleted"}
    ctx.__exit__(None, None, None)


def test_uploader_wrong_token_rejected(client):
    code, _, _ = upload(client)
    with client.websocket_connect("/ws/upload", headers=ORIGIN) as ws:
        ws.send_json({"code": code, "owner_token": b64u_encode(os.urandom(32))})
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4403


def test_bad_hello_rejected(client):
    with client.websocket_connect("/ws/print", headers=ORIGIN) as ws:
        ws.send_json({"claim_token": "' OR 1=1 --"})
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4400


@pytest.mark.parametrize("headers", [{}, {"origin": "https://evil.example"}])
def test_cross_origin_socket_rejected(client, headers):
    for path in ("/ws/upload", "/ws/print"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path, headers=headers) as ws:
                ws.receive_json()
