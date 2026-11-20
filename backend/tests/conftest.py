import os
import tempfile

# 앱을 import하기 전에 테스트용 임시 데이터 폴더를 지정한다 (실제 data/를 건드리지 않음)
os.environ["PRINTCODE_DATA_DIR"] = tempfile.mkdtemp(prefix="printcode-test-")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
