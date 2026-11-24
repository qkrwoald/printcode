"""SQLite 접근. 모든 쿼리는 파라미터 바인딩(?)만 사용한다 — 문자열 조립 금지 (SQL 인젝션 방지)."""
import sqlite3
from contextlib import contextmanager

from . import config

# 구조가 바뀌면 올린다. 저장된 데이터는 길어야 30분짜리 임시 파일이므로, 버전이 다르면 지우고 새로 만든다.
SCHEMA_VERSION = 3

SCHEMA = """
CREATE TABLE files (
    code              TEXT PRIMARY KEY,
    -- reserved: 코드 예약됨 / ready: 업로드 완료 / claimed: 출력 PC가 받아 감(출력 중)
    status            TEXT NOT NULL CHECK (status IN ('reserved', 'ready', 'claimed')),
    owner_token_hash  BLOB NOT NULL,     -- 업로더 토큰 해시: 예약자만 업로드하고, 상태 알림을 받게 함
    blob_name         TEXT,              -- 서버가 만든 무작위 파일명 (받아 가면 즉시 삭제 → NULL)
    blob_size         INTEGER NOT NULL DEFAULT 0,  -- 전체 저장 용량 상한 계산용 (받아 가면 0)
    salt              BLOB,
    auth_hash         BLOB,              -- SHA-256(auth_token). auth_token 자체는 저장하지 않음
    kdf_m             INTEGER,
    kdf_t             INTEGER,
    kdf_p             INTEGER,
    has_phrase        INTEGER,
    failed_attempts   INTEGER NOT NULL DEFAULT 0,
    claim_token_hash  BLOB,              -- 출력 창 WebSocket 인증용 (받아 갈 때 발급)
    claimed_at        REAL,
    print_connected   INTEGER NOT NULL DEFAULT 0,
    created_at        REAL NOT NULL,
    expires_at        REAL NOT NULL
);
"""


def init() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.BLOB_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            conn.execute("DROP TABLE IF EXISTS files")
            for f in config.BLOB_DIR.iterdir():
                f.unlink(missing_ok=True)
            conn.executescript(SCHEMA)
            # PRAGMA는 파라미터 바인딩을 받지 않는다. 값은 코드 안의 정수 상수라 안전하다.
            conn.execute(f"PRAGMA user_version = {int(SCHEMA_VERSION)}")


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
