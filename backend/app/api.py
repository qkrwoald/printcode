"""API 엔드포인트.

코드는 URL에 넣지 않고 항상 POST 본문으로만 받는다 — 접속 로그·브라우저 기록에 남지 않게 하기 위해.
서버는 암호문을 해석하지 않으며, 코드·토큰·확인코드를 로그에 남기지 않는다.
"""
import hashlib
import hmac
import secrets
import sqlite3
import time
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from . import config, db, storage
from .schemas import FetchIn, LookupIn, UploadForm, b64u_decode, b64u_encode

router = APIRouter(prefix="/api")

NOT_FOUND = "코드가 없거나 만료되었습니다."
# 암호문 최소 크기: 버전(1) + IV(12) + GCM 태그(16)
MIN_BLOB_BYTES = 1 + 12 + 16


def _sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def purge_expired(now: float) -> None:
    """만료된 예약·파일을 삭제한다. (M4에서 주기 작업으로도 실행 예정)"""
    with db.transaction() as conn:
        rows = conn.execute("SELECT blob_name FROM files WHERE expires_at < ?", (now,)).fetchall()
        conn.execute("DELETE FROM files WHERE expires_at < ?", (now,))
    for row in rows:
        storage.delete(row["blob_name"])


def _get_ready(conn: sqlite3.Connection, code: str, now: float):
    return conn.execute(
        "SELECT * FROM files WHERE code = ? AND status = 'ready' AND expires_at >= ?",
        (code, now),
    ).fetchone()


@router.post("/codes", status_code=201)
def reserve_code():
    """활성 코드와 겹치지 않는 6자리 코드를 예약한다."""
    now = time.time()
    purge_expired(now)  # 만료된 코드를 먼저 지워 재사용 가능하게 함
    # 예약한 브라우저만 업로드할 수 있도록 일회용 토큰을 주고, 서버에는 해시만 저장한다.
    upload_token = secrets.token_bytes(32)
    for _ in range(20):
        # secrets: 예측 불가능한 난수 (random 모듈은 예측 가능해서 쓰지 않음)
        code = f"{secrets.randbelow(10**6):06d}"
        try:
            with db.connect() as conn:
                conn.execute(
                    "INSERT INTO files (code, status, upload_token_hash, created_at, expires_at) "
                    "VALUES (?, 'reserved', ?, ?, ?)",
                    (code, _sha256(upload_token), now, now + config.RESERVE_TTL_SECONDS),
                )
        except sqlite3.IntegrityError:
            continue  # 이미 사용 중인 코드 → 다시 뽑기
        return {
            "code": code,
            "upload_token": b64u_encode(upload_token),
            "expires_in": config.RESERVE_TTL_SECONDS,
        }
    raise HTTPException(503, "지금은 코드를 발급할 수 없습니다. 잠시 후 다시 시도하세요.")


@router.post("/uploads", status_code=201)
def upload(form: Annotated[UploadForm, Form()], blob: UploadFile):
    now = time.time()
    token_hash = _sha256(b64u_decode(form.upload_token))
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT upload_token_hash, expires_at FROM files WHERE code = ? AND status = 'reserved'",
            (form.code,),
        ).fetchone()
        # compare_digest: 비교 시간이 일치 길이에 따라 달라지지 않게 해 타이밍 공격을 막는다.
        if (
            row is None
            or row["expires_at"] < now
            or not hmac.compare_digest(row["upload_token_hash"], token_hash)
        ):
            raise HTTPException(403, "업로드 권한이 없거나 예약이 만료되었습니다.")

        try:
            blob_name, size = storage.save(blob.file, config.MAX_BLOB_BYTES)
        except storage.TooLarge:
            raise HTTPException(413, "파일이 너무 큽니다.")
        if size < MIN_BLOB_BYTES:
            storage.delete(blob_name)
            raise HTTPException(422, "잘못된 파일입니다.")

        try:
            conn.execute(
                "UPDATE files SET status = 'ready', upload_token_hash = NULL, blob_name = ?, "
                "salt = ?, auth_hash = ?, kdf_m = ?, kdf_t = ?, kdf_p = ?, has_phrase = ?, "
                "expires_at = ? WHERE code = ?",
                (
                    blob_name,
                    b64u_decode(form.salt),
                    b64u_decode(form.auth_hash),
                    form.kdf_m,
                    form.kdf_t,
                    form.kdf_p,
                    int(form.has_phrase),
                    now + config.FILE_TTL_SECONDS,
                    form.code,
                ),
            )
        except BaseException:
            storage.delete(blob_name)
            raise
    return {"expires_in": config.FILE_TTL_SECONDS}


@router.post("/lookup")
def lookup(body: LookupIn):
    """키 유도에 필요한 공개값(salt, KDF 파라미터)만 돌려준다. 암호문은 주지 않는다."""
    with db.connect() as conn:
        row = _get_ready(conn, body.code, time.time())
    if row is None:
        raise HTTPException(404, NOT_FOUND)
    return {
        "salt": b64u_encode(row["salt"]),
        "kdf": {"m": row["kdf_m"], "t": row["kdf_t"], "p": row["kdf_p"]},
        # 확인코드 입력을 빼먹어 시도 횟수를 낭비하지 않도록 알려준다 (SECURITY.md에 명시할 작은 노출)
        "has_phrase": bool(row["has_phrase"]),
    }


@router.post("/fetch")
def fetch(body: FetchIn):
    """auth_token이 맞을 때만 암호문을 내려준다.
    암호문을 먼저 주면 확인코드를 오프라인으로 무한 대입할 수 있으므로, 서버에서 시도 횟수를 제한한다."""
    presented = _sha256(b64u_decode(body.auth_token))
    data = None
    remaining = None
    with db.transaction() as conn:
        row = _get_ready(conn, body.code, time.time())
        if row is None:
            raise HTTPException(404, NOT_FOUND)
        blob_name = row["blob_name"]
        if hmac.compare_digest(row["auth_hash"], presented):
            data = storage.read(blob_name)
            # M1: 내려준 즉시 삭제해 1회만 출력되게 한다. (M2에서 WebSocket 기반으로 변경)
            conn.execute("DELETE FROM files WHERE code = ?", (body.code,))
        else:
            failed = row["failed_attempts"] + 1
            remaining = config.MAX_FAILED_ATTEMPTS - failed
            if remaining <= 0:
                conn.execute("DELETE FROM files WHERE code = ?", (body.code,))
            else:
                conn.execute(
                    "UPDATE files SET failed_attempts = ? WHERE code = ?", (failed, body.code)
                )

    # 파일 삭제는 DB 커밋 뒤에 한다 (커밋이 실패하면 파일이 남아 있어야 함)
    if data is not None:
        storage.delete(blob_name)
        return Response(content=data, media_type="application/octet-stream")
    if remaining <= 0:
        storage.delete(blob_name)
        return JSONResponse(
            {"detail": "확인코드를 여러 번 틀려 파일이 삭제되었습니다.", "remaining": 0},
            status_code=403,
        )
    return JSONResponse(
        {"detail": "코드 또는 확인코드가 맞지 않습니다.", "remaining": remaining},
        status_code=403,
    )
