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

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from . import config, db, lifecycle, ratelimit, storage
from .lifecycle import hub
from .schemas import FetchIn, LookupIn, UploadForm, b64u_decode, b64u_encode

router = APIRouter(prefix="/api")

NOT_FOUND = "Code not found or expired."
# 암호문 최소 크기: 버전(1) + IV(12) + GCM 태그(16)
MIN_BLOB_BYTES = 1 + 12 + 16


def _sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def _get_ready(conn: sqlite3.Connection, code: str, now: float):
    return conn.execute(
        "SELECT * FROM files WHERE code = ? AND status = 'ready' AND expires_at >= ?",
        (code, now),
    ).fetchone()


@router.get("/config")
def get_config():
    """업로드 화면이 미리 크기를 확인할 수 있도록 공개 설정값을 알려준다. null이면 제한 없음."""
    return {"max_pdf_bytes": config.MAX_PDF_BYTES}


@router.post("/codes", status_code=201, dependencies=[Depends(ratelimit.limit_upload)])
def reserve_code():
    """활성 코드와 겹치지 않는 6자리 코드를 예약한다."""
    now = time.time()
    lifecycle.purge(now)  # 만료된 코드를 먼저 지워 재사용 가능하게 함
    # 예약한 브라우저만 업로드하고 상태 알림을 받을 수 있도록 토큰을 주고, 서버에는 해시만 저장한다.
    upload_token = secrets.token_bytes(32)
    for _ in range(20):
        # secrets: 예측 불가능한 난수 (random 모듈은 예측 가능해서 쓰지 않음)
        code = f"{secrets.randbelow(10**6):06d}"
        try:
            with db.connect() as conn:
                conn.execute(
                    "INSERT INTO files (code, status, owner_token_hash, created_at, expires_at) "
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
    raise HTTPException(503, "Cannot issue a code right now. Try again later.")


@router.post("/uploads", status_code=201, dependencies=[Depends(ratelimit.limit_upload)])
def upload(form: Annotated[UploadForm, Form()], blob: UploadFile):
    now = time.time()
    token_hash = _sha256(b64u_decode(form.upload_token))
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT owner_token_hash, expires_at FROM files WHERE code = ? AND status = 'reserved'",
            (form.code,),
        ).fetchone()
        # compare_digest: 비교 시간이 일치 길이에 따라 달라지지 않게 해 타이밍 공격을 막는다.
        # status='reserved' 조건 때문에 같은 토큰으로 두 번 업로드할 수는 없다.
        if (
            row is None
            or row["expires_at"] < now
            or not hmac.compare_digest(row["owner_token_hash"], token_hash)
        ):
            raise HTTPException(403, "Upload not allowed or reservation expired.")

        try:
            blob_name, size = storage.save(blob.file, config.MAX_BLOB_BYTES)
        except storage.TooLarge:
            raise HTTPException(413, "File too large.")
        if size < MIN_BLOB_BYTES:
            storage.delete(blob_name)
            raise HTTPException(422, "Invalid file.")
        if config.MAX_TOTAL_BYTES is not None:
            # 서버 디스크가 가득 차지 않도록 동시에 보관하는 암호문 전체 크기를 제한한다.
            used = conn.execute("SELECT COALESCE(SUM(blob_size), 0) FROM files").fetchone()[0]
            if used + size > config.MAX_TOTAL_BYTES:
                storage.delete(blob_name)
                raise HTTPException(507, "Server is full. Try again later.")

        try:
            conn.execute(
                "UPDATE files SET status = 'ready', blob_name = ?, blob_size = ?, "
                "salt = ?, auth_hash = ?, kdf_m = ?, kdf_t = ?, kdf_p = ?, has_phrase = ?, "
                "expires_at = ? WHERE code = ?",
                (
                    blob_name,
                    size,
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


@router.post("/lookup", dependencies=[Depends(ratelimit.limit_lookup)])
def lookup(body: LookupIn, request: Request):
    """키 유도에 필요한 공개값(salt, KDF 파라미터)만 돌려준다. 암호문은 주지 않는다."""
    with db.connect() as conn:
        row = _get_ready(conn, body.code, time.time())
    if row is None:
        ratelimit.record_miss(request)  # 없는 코드 = 추측 시도일 수 있어 따로 센다
        raise HTTPException(404, NOT_FOUND)
    return {
        "salt": b64u_encode(row["salt"]),
        "kdf": {"m": row["kdf_m"], "t": row["kdf_t"], "p": row["kdf_p"]},
        # 확인코드 입력을 빼먹어 시도 횟수를 낭비하지 않도록 알려준다 (SECURITY.md에 명시할 작은 노출)
        "has_phrase": bool(row["has_phrase"]),
    }


@router.post("/fetch", dependencies=[Depends(ratelimit.limit_lookup)])
def fetch(body: FetchIn, request: Request):
    """auth_token이 맞을 때만 암호문을 내려준다.
    암호문을 먼저 주면 확인코드를 오프라인으로 무한 대입할 수 있으므로, 서버에서 시도 횟수를 제한한다."""
    presented = _sha256(b64u_decode(body.auth_token))
    data = None
    remaining = None
    claim_token = None
    now = time.time()
    with db.transaction() as conn:
        row = _get_ready(conn, body.code, now)
        if row is None:
            ratelimit.record_miss(request)
            raise HTTPException(404, NOT_FOUND)
        blob_name = row["blob_name"]
        if hmac.compare_digest(row["auth_hash"], presented):
            data = storage.read(blob_name)
            # 받아 간 파일은 'claimed'로 바꿔 다른 사람이 다시 받을 수 없게 한다.
            # 암호문은 출력 창이 이미 갖고 있으므로 서버 사본은 바로 지운다 (서버 보관 시간 최소화).
            # 기록은 출력 창 WebSocket이 끝날 때까지 남겨 업로더에게 결과를 알리는 데 쓴다.
            claim_token = secrets.token_bytes(32)
            conn.execute(
                "UPDATE files SET status = 'claimed', blob_name = NULL, blob_size = 0, claim_token_hash = ?, "
                "claimed_at = ?, print_connected = 0 WHERE code = ?",
                (_sha256(claim_token), now, body.code),
            )
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
        hub.notify(body.code, "printing")
        # 출력 창이 WebSocket 인증에 쓸 토큰. 본문은 암호문이라 헤더로 함께 보낸다.
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"X-Claim-Token": b64u_encode(claim_token)},
        )
    if remaining <= 0:
        storage.delete(blob_name)
        hub.notify(body.code, "deleted")
        return JSONResponse(
            {"detail": "Too many wrong attempts. File deleted.", "remaining": 0},
            status_code=403,
        )
    return JSONResponse(
        {"detail": "Wrong code or phrase.", "remaining": remaining},
        status_code=403,
    )
