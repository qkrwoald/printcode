"""설정값. 환경변수로 덮어쓸 수 있다."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]

DATA_DIR = Path(os.environ.get("PRINTCODE_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "printcode.db"
BLOB_DIR = DATA_DIR / "blobs"
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"

# 업로드된 파일의 유효 시간 (기본 30분)
FILE_TTL_SECONDS = int(os.environ.get("PRINTCODE_FILE_TTL", 30 * 60))
# 코드를 예약한 뒤 업로드까지 허용하는 시간
RESERVE_TTL_SECONDS = int(os.environ.get("PRINTCODE_RESERVE_TTL", 5 * 60))
# PDF 최대 크기(MB). 0이면 제한 없음.
# 기본 90MB: Cloudflare 임시 터널이 요청 하나를 100MB까지만 받기 때문.
MAX_PDF_MB = int(os.environ.get("PRINTCODE_MAX_PDF_MB", 90))
MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024 if MAX_PDF_MB > 0 else None
# 암호문 최대 크기: PDF + 헤더·메타데이터·GCM 태그 여유분. None이면 제한 없음.
MAX_BLOB_BYTES = MAX_PDF_BYTES + 64 * 1024 if MAX_PDF_BYTES else None
# 코드별 인증 실패 허용 횟수. 이 횟수에 도달하면 파일을 즉시 삭제한다.
MAX_FAILED_ATTEMPTS = 5
