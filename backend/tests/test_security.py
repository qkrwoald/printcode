"""M4: 남용 방지(횟수 제한·추측 차단), 출처·본문 검사, 보안 헤더, 저장 용량 상한, 로그."""
import hashlib
import logging
import os

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import config, db, ratelimit
from app.main import app
from app.schemas import b64u_encode

ORIGIN = {"origin": "http://testserver"}


def upload(client, blob=None):
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
        files={"blob": ("blob", blob or b"\x01" + os.urandom(500), "application/octet-stream")},
    )
    return res, reserved, auth_token


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(ratelimit, "clock", c)
    return c


def other_ip(ip="10.0.0.2"):
    return TestClient(app, client=(ip, 50000))


# ── 횟수 제한 ──
def test_code_issuing_is_rate_limited_per_ip(client, clock):
    limit, seconds = config.RATE_UPLOAD
    for _ in range(limit):
        assert client.post("/api/codes").status_code == 201
    res = client.post("/api/codes")
    assert res.status_code == 429
    assert res.headers["retry-after"] == str(seconds)
    # 다른 IP는 영향 없음
    assert other_ip().post("/api/codes").status_code == 201
    # 시간이 지나면 다시 허용
    clock.t += seconds + 1
    assert client.post("/api/codes").status_code == 201


def test_lookup_is_rate_limited_per_ip(client, clock):
    _, reserved, _ = upload(client)
    limit, _ = config.RATE_LOOKUP
    for _ in range(limit):
        assert client.post("/api/lookup", json={"code": reserved["code"]}).status_code == 200
    assert client.post("/api/lookup", json={"code": reserved["code"]}).status_code == 429


def test_guessing_codes_gets_blocked(client, clock):
    """없는 코드를 여러 번 조회하면(=추측) 한동안 정상 코드도 조회할 수 없다."""
    _, reserved, _ = upload(client)
    limit, _ = config.MISS_LIMIT
    misses = 0
    for n in range(1_000_000):
        guess = f"{n:06d}"
        if guess == reserved["code"]:
            continue
        clock.t += 61  # 분당 제한은 피하고, 실패 횟수만 쌓이게
        assert client.post("/api/lookup", json={"code": guess}).status_code == 404
        misses += 1
        if misses == limit + 1:
            break
    # 차단됨: 맞는 코드도 거절
    assert client.post("/api/lookup", json={"code": reserved["code"]}).status_code == 429
    assert other_ip().post("/api/lookup", json={"code": reserved["code"]}).status_code == 200
    # 차단 시간이 지나면 풀림
    clock.t += config.MISS_BLOCK_SECONDS + 1
    assert client.post("/api/lookup", json={"code": reserved["code"]}).status_code == 200


def test_websocket_connections_capped_per_ip(client, monkeypatch):
    monkeypatch.setattr(config, "WS_PER_IP", 2)
    a = client.websocket_connect("/ws/upload", headers=ORIGIN)
    b = client.websocket_connect("/ws/upload", headers=ORIGIN)
    a.__enter__()
    b.__enter__()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/upload", headers=ORIGIN) as c:
            c.receive_json()
    a.__exit__(None, None, None)
    b.__exit__(None, None, None)


# ── 출처·본문 ──
@pytest.mark.parametrize(
    "headers",
    [{"origin": "https://evil.example"}, {"sec-fetch-site": "cross-site"}],
)
def test_cross_site_post_blocked(client, headers):
    assert client.post("/api/codes", headers=headers).status_code == 403
    assert client.post("/api/lookup", json={"code": "123456"}, headers=headers).status_code == 403


def test_same_origin_post_allowed(client):
    assert client.post("/api/codes", headers=ORIGIN).status_code == 201


def test_oversized_json_rejected(client):
    body = '{"code": "123456", "x": "' + "a" * (config.MAX_JSON_BYTES + 10) + '"}'
    res = client.post("/api/lookup", content=body, headers={"content-type": "application/json"})
    assert res.status_code == 413


# ── 헤더 ──
def test_security_headers(client):
    h = client.get("/api/config").headers
    assert h["cross-origin-opener-policy"] == "same-origin"
    assert h["cross-origin-resource-policy"] == "same-origin"
    assert "camera=()" in h["permissions-policy"]
    assert "strict-transport-security" not in h  # http에서는 붙이지 않음


def test_hsts_on_https():
    with TestClient(app, base_url="https://testserver") as c:
        assert c.get("/api/config").headers["strict-transport-security"].startswith("max-age=")


# ── 저장 용량 상한 ──
def used_bytes():
    """다른 테스트가 남긴 파일까지 포함한 현재 사용량"""
    with db.connect() as conn:
        return conn.execute("SELECT COALESCE(SUM(blob_size), 0) FROM files").fetchone()[0]


def test_total_storage_cap(client, monkeypatch):
    before = len(list(config.BLOB_DIR.iterdir()))
    monkeypatch.setattr(config, "MAX_TOTAL_BYTES", used_bytes() + 2000)
    res, _, _ = upload(client, b"\x01" + os.urandom(1200))
    assert res.status_code == 201
    res, _, _ = upload(client, b"\x01" + os.urandom(1200))
    assert res.status_code == 507
    assert len(list(config.BLOB_DIR.iterdir())) == before + 1  # 거절된 파일은 남지 않음


def test_claimed_file_frees_storage(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_TOTAL_BYTES", used_bytes() + 2000)
    res, reserved, token = upload(client, b"\x01" + os.urandom(1200))
    assert res.status_code == 201
    client.post("/api/fetch", json={"code": reserved["code"], "auth_token": b64u_encode(token)})
    res, _, _ = upload(client, b"\x01" + os.urandom(1200))
    assert res.status_code == 201  # 받아 간 파일은 용량에서 빠진다


# ── 로그 ──
def test_secrets_never_logged(client, caplog):
    caplog.set_level(logging.DEBUG)
    res, reserved, token = upload(client)
    client.post("/api/lookup", json={"code": reserved["code"]})
    client.post("/api/fetch", json={"code": reserved["code"], "auth_token": b64u_encode(os.urandom(32))})
    client.post("/api/fetch", json={"code": reserved["code"], "auth_token": b64u_encode(token)})
    for secret in (reserved["code"], reserved["upload_token"], b64u_encode(token)):
        assert secret not in caplog.text
