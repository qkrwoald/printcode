"""암호문 덩어리 저장소. 서버는 내용을 해석하지 않고 바이트만 보관한다."""
import secrets
from pathlib import Path
from typing import BinaryIO

from . import config


class TooLarge(Exception):
    pass


def _path(blob_name: str) -> Path:
    # blob_name은 항상 서버가 만든 hex 문자열이다. 그래도 경로 조작을 한 번 더 막는다.
    if not (len(blob_name) == 32 and all(c in "0123456789abcdef" for c in blob_name)):
        raise ValueError("invalid blob name")
    return config.BLOB_DIR / blob_name


def save(src: BinaryIO, max_bytes: int | None) -> tuple[str, int]:
    """src를 무작위 이름 파일로 복사하고 (파일명, 크기)를 돌려준다. 사용자 파일명은 쓰지 않는다."""
    blob_name = secrets.token_hex(16)
    path = _path(blob_name)
    written = 0
    try:
        with open(path, "xb") as dst:
            while chunk := src.read(1024 * 1024):
                written += len(chunk)
                if max_bytes is not None and written > max_bytes:
                    raise TooLarge()
                dst.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return blob_name, written


def read(blob_name: str) -> bytes:
    return _path(blob_name).read_bytes()


def delete(blob_name: str | None) -> None:
    if blob_name:
        _path(blob_name).unlink(missing_ok=True)
