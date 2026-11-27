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


# ── 문서 변환기(M5) 관련 헤더 ──
def test_cross_origin_isolation_and_local_fonts(client):
    h = client.get("/api/config").headers
    assert h["cross-origin-embedder-policy"] == "require-corp"  # SharedArrayBuffer용 격리
    assert "local-fonts=(self)" in h["permissions-policy"]


def test_converter_csp_relaxed_only_for_converter_scripts(tmp_path):
    """'unsafe-eval'은 /converter/ 아래 .js(변환기 워커)에만 붙고, 페이지·API는 엄격한 CSP 그대로.
    변환기 파일은 오래 캐시된다 (약 240MB를 매번 받지 않게)."""
    from fastapi.staticfiles import StaticFiles
    from starlette.routing import Mount

    from app import main

    (tmp_path / "w.js").write_text("//")
    route = Mount("/converter/test", app=StaticFiles(directory=tmp_path))
    main.app.router.routes.insert(0, route)  # dist 없이도 실제 경로처럼 요청하기 위한 테스트용 마운트
    try:
        with TestClient(main.app) as c:
            r = c.get("/converter/test/w.js")
            assert r.status_code == 200
            assert "'unsafe-eval'" in r.headers["content-security-policy"]
            assert r.headers["cache-control"].startswith("public, max-age=")
            api = c.get("/api/config")
            assert "'unsafe-eval'" not in api.headers["content-security-policy"]
            assert api.headers["cache-control"] == "no-store"
    finally:
        main.app.router.routes.remove(route)


# ── 플랫폼 프록시(Railway 등) 뒤의 접속자 IP ──

def test_forwarded_for_ignored_by_default(client, clock):
    """PROXY_HOPS=0(기본): 접속자가 X-Forwarded-For를 바꿔 보내도 같은 IP로 센다 (IP 위조로 제한 회피 불가)."""
    limit, _ = config.RATE_UPLOAD
    for n in range(limit):
        assert client.post("/api/codes", headers={"X-Forwarded-For": f"10.0.0.{n}"}).status_code == 201
    assert client.post("/api/codes", headers={"X-Forwarded-For": "10.9.9.9"}).status_code == 429


def test_proxy_hops_uses_rightmost_entry(client, clock, monkeypatch):
    """PROXY_HOPS=1: 프록시가 덧붙인 맨 끝 값만 접속자 IP로 쓴다. 앞쪽(접속자가 적은 값)을 바꿔도 소용없다."""
    monkeypatch.setattr(config, "PROXY_HOPS", 1)
    limit, _ = config.RATE_UPLOAD
    for n in range(limit):
        spoofed = {"X-Forwarded-For": f"10.0.0.{n}, 203.0.113.7"}
        assert client.post("/api/codes", headers=spoofed).status_code == 201
    assert client.post("/api/codes", headers={"X-Forwarded-For": "1.1.1.1, 203.0.113.7"}).status_code == 429
    # 프록시가 본 실제 IP가 다르면 다른 사람으로 센다
    assert client.post("/api/codes", headers={"X-Forwarded-For": "203.0.113.8"}).status_code == 201


def test_proxy_hops_two_like_railway(client, clock, monkeypatch):
    """Railway: X-Forwarded-For = [접속자가 적은 값…], 실제 접속자 IP, 중계 서버 IP(여러 대). hops=2로 실제 IP만 센다."""
    monkeypatch.setattr(config, "PROXY_HOPS", 2)
    limit, _ = config.RATE_UPLOAD
    for n in range(limit):
        # 가짜 값과 중계 서버 IP가 매번 달라도 같은 사람으로 센다
        h = {"X-Forwarded-For": f"10.0.0.{n}, 198.51.100.5, 100.64.0.{n % 3}"}
        assert client.post("/api/codes", headers=h).status_code == 201
    assert client.post("/api/codes", headers={"X-Forwarded-For": "198.51.100.5, 100.64.0.9"}).status_code == 429
    assert client.post("/api/codes", headers={"X-Forwarded-For": "198.51.100.6, 100.64.0.1"}).status_code == 201


def test_proxy_hops_hsts_from_forwarded_proto(client, monkeypatch):
    """프록시가 HTTPS를 처리하고 http로 넘겨줘도, PROXY_HOPS가 켜져 있으면 X-Forwarded-Proto로 HSTS를 붙인다."""
    assert "strict-transport-security" not in client.get("/api/config", headers={"X-Forwarded-Proto": "https"}).headers
    # Railway처럼 프록시가 2단이어도 X-Forwarded-Proto는 한 값만 온다
    for hops in (1, 2):
        monkeypatch.setattr(config, "PROXY_HOPS", hops)
        assert "strict-transport-security" in client.get("/api/config", headers={"X-Forwarded-Proto": "https"}).headers
    assert "strict-transport-security" not in client.get("/api/config", headers={"X-Forwarded-Proto": "http"}).headers
