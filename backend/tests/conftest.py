import os
import tempfile

# 앱을 import하기 전에 테스트용 임시 데이터 폴더를 지정한다 (실제 data/를 건드리지 않음)
os.environ["PRINTCODE_DATA_DIR"] = tempfile.mkdtemp(prefix="printcode-test-")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import ratelimit, ws  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_limits():
    """테스트끼리 IP별 횟수 제한 기록이 섞이지 않게 매번 비운다."""
    ratelimit.reset_all()
    ws._open.clear()
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
