"""M1 흐름 테스트. 서버는 암호를 풀지 않으므로, 클라이언트 쪽 값(auth_token 등)은 무작위 바이트로 흉내낸다."""
import hashlib
import os
import sqlite3

import pytest

from app import config
from app.schemas import b64u_encode


def make_upload(client, blob=None):
    """코드 예약 → 업로드까지 하고 (code, auth_token, blob)을 돌려준다."""
    res = client.post("/api/codes")
    assert res.status_code == 201
    reserved = res.json()
    auth_token = os.urandom(32)
    blob = blob if blob is not None else b"\x01" + os.urandom(12 + 1000)
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
            "has_phrase": "true",
        },
        files={"blob": ("blob", blob, "application/octet-stream")},
    )
    assert res.status_code == 201, res.text
    return reserved["code"], auth_token, blob


def blob_count():
    return len(list(config.BLOB_DIR.iterdir()))


def test_full_flow_and_one_time(client):
    before = blob_count()
    code, token, blob = make_upload(client)
    assert blob_count() == before + 1

    res = client.post("/api/lookup", json={"code": code})
    assert res.status_code == 200
    assert res.json()["kdf"] == {"m": 65536, "t": 3, "p": 1}
    assert res.json()["has_phrase"] is True

    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(token)})
    assert res.status_code == 200
    assert res.content == blob
    assert res.headers["cache-control"] == "no-store"

    # 1회 출력 후 재접근 불가, 암호문 파일도 삭제됨
    assert client.post("/api/lookup", json={"code": code}).status_code == 404
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(token)})
    assert res.status_code == 404
    assert blob_count() == before


def test_wrong_token_five_times_deletes(client):
    code, token, _ = make_upload(client)
    before = blob_count()
    for expected_remaining in [4, 3, 2, 1, 0]:
        res = client.post(
            "/api/fetch", json={"code": code, "auth_token": b64u_encode(os.urandom(32))}
        )
        assert res.status_code == 403
        assert res.json()["remaining"] == expected_remaining
    # 5회 실패 후에는 올바른 토큰으로도 받을 수 없음
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(token)})
    assert res.status_code == 404
    assert blob_count() == before - 1


def test_expired_file_not_accessible(client):
    code, token, _ = make_upload(client)
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE files SET expires_at = 0 WHERE code = ?", (code,))
    assert client.post("/api/lookup", json={"code": code}).status_code == 404
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(token)})
    assert res.status_code == 404


def test_upload_requires_reservation_token(client):
    reserved = client.post("/api/codes").json()
    res = client.post(
        "/api/uploads",
        data={
            "code": reserved["code"],
            "upload_token": b64u_encode(os.urandom(32)),  # 다른 토큰
            "salt": b64u_encode(os.urandom(16)),
            "auth_hash": b64u_encode(os.urandom(32)),
            "kdf_m": 65536,
            "kdf_t": 3,
            "kdf_p": 1,
            "has_phrase": "false",
        },
        files={"blob": ("blob", b"x" * 100, "application/octet-stream")},
    )
    assert res.status_code == 403


def test_codes_are_six_digits_and_unique(client):
    codes = [client.post("/api/codes").json()["code"] for _ in range(30)]
    assert all(len(c) == 6 and c.isdigit() for c in codes)
    assert len(set(codes)) == len(codes)


@pytest.mark.parametrize(
    "code",
    ["' OR 1=1 --", "12345", "1234567", "abcdef", "12345\n", "<script>", "１２３４５６"],
)
def test_malformed_code_rejected(client, code):
    assert client.post("/api/lookup", json={"code": code}).status_code == 422
    res = client.post("/api/fetch", json={"code": code, "auth_token": "A" * 43})
    assert res.status_code == 422


def test_extra_fields_rejected(client):
    res = client.post("/api/lookup", json={"code": "123456", "admin": True})
    assert res.status_code == 422


def test_oversize_upload_rejected(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_BLOB_BYTES", 1024)
    reserved = client.post("/api/codes").json()
    before = blob_count()
    res = client.post(
        "/api/uploads",
        data={
            "code": reserved["code"],
            "upload_token": reserved["upload_token"],
            "salt": b64u_encode(os.urandom(16)),
            "auth_hash": b64u_encode(os.urandom(32)),
            "kdf_m": 65536,
            "kdf_t": 3,
            "kdf_p": 1,
            "has_phrase": "false",
        },
        files={"blob": ("blob", b"x" * 100_000, "application/octet-stream")},
    )
    assert res.status_code == 413
    assert blob_count() == before


def test_config_reports_limit(client, monkeypatch):
    assert client.get("/api/config").json() == {"max_pdf_bytes": 90 * 1024 * 1024}
    monkeypatch.setattr(config, "MAX_PDF_BYTES", None)
    assert client.get("/api/config").json() == {"max_pdf_bytes": None}


def test_unlimited_size_accepts_large_upload(client, monkeypatch):
    # 0(제한 없음)으로 설정하면 기본 상한을 넘는 업로드도 받는다
    monkeypatch.setattr(config, "MAX_BLOB_BYTES", None)
    big = b"\x01" + os.urandom(200_000)
    code, token, blob = make_upload(client, blob=big)
    res = client.post("/api/fetch", json={"code": code, "auth_token": b64u_encode(token)})
    assert res.content == big


def test_security_headers(client):
    res = client.post("/api/lookup", json={"code": "000000"})
    assert "frame-ancestors 'none'" in res.headers["content-security-policy"]
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["referrer-policy"] == "no-referrer"
