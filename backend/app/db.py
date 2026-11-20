"""SQLite 접근. 모든 쿼리는 파라미터 바인딩(?)만 사용한다 — 문자열 조립 금지 (SQL 인젝션 방지)."""
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    code              TEXT PRIMARY KEY,
    status            TEXT NOT NULL CHECK (status IN ('reserved', 'ready')),
    upload_token_hash BLOB,              -- 예약자만 업로드하도록. 업로드 후 NULL
    blob_name         TEXT,              -- 서버가 만든 무작위 파일명
    salt              BLOB,
    auth_hash         BLOB,              -- SHA-256(auth_token). auth_token 자체는 저장하지 않음
    kdf_m             INTEGER,
    kdf_t             INTEGER,
    kdf_p             INTEGER,
    has_phrase        INTEGER,
    failed_attempts   INTEGER NOT NULL DEFAULT 0,
    created_at        REAL NOT NULL,
    expires_at        REAL NOT NULL
);
"""


def init() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.BLOB_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect():
    # 요청마다 새 연결. isolation_level=None + 명시적 BEGIN으로 트랜잭션 범위를 직접 관리한다.
    conn = sqlite3.connect(config.DB_PATH, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction():
    """BEGIN IMMEDIATE: 쓰기 잠금을 먼저 잡아, 같은 코드에 대한 동시 요청이
    둘 다 성공하는 경쟁 상태(예: 1회용 파일을 두 번 받기)를 막는다."""
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
