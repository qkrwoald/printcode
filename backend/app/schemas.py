"""API 입력 스키마. 모든 입력은 여기서 형식·길이를 검증한 뒤에만 사용한다."""
import base64
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Code = Annotated[str, StringConstraints(pattern=r"^[0-9]{6}$")]
# base64url(패딩 없음). 16바이트 → 22자, 32바이트 → 43자
B64u16 = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{22}$")]
B64u32 = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{43}$")]


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class UploadForm(BaseModel):
    code: Code
    upload_token: B64u32
    salt: B64u16
    auth_hash: B64u32
    # Argon2id 파라미터 범위 제한: 너무 약한 값(보안)과 너무 큰 값(공용 PC 마비)을 둘 다 막는다.
    kdf_m: int = Field(ge=19 * 1024, le=256 * 1024)  # KiB
    kdf_t: int = Field(ge=1, le=10)
    kdf_p: int = Field(ge=1, le=4)
    has_phrase: bool


class LookupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Code


class FetchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Code
    auth_token: B64u32
