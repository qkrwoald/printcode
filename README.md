# PrintCode

프린터실 공용 PC에 로그인하거나 파일을 내려받지 않고, **6자리 코드로 출력**하는 웹 서비스입니다.

- 내 노트북 브라우저에서 PDF를 **암호화한 뒤** 업로드합니다. 서버에는 암호문만 남습니다.
- 공용 PC에서 코드(+확인코드)를 입력하면 브라우저 메모리에서 복호화해 인쇄 창을 엽니다.
- 출력 PC가 파일을 받아 가는 순간 서버의 암호문은 삭제되고, 같은 코드로는 다시 출력할 수 없습니다.

> 현재 단계: **M2** (출력 전용 창·WebSocket·자동 정리). 출력 설정(M3), 보안 강화(M4),
> docx/pptx(M5), hwp(M6)는 아직입니다. 보안 설계와 한계는 [SECURITY.md](SECURITY.md)를 보세요.

## 사용 흐름

메인(`/`)에서 **UPLOAD** 또는 **PRINT**를 고릅니다.

1. 노트북에서 UPLOAD(`/upload/`) → PDF 선택 → (선택) 확인코드 입력 → **UPLOAD**
2. 화면에 나온 6자리 코드를 기억 (남은 시간이 1초씩 표시됨)
3. 프린터실 PC에서 PRINT(`/print/`) → 코드 6칸 입력 → **NEXT** → (확인코드) → **PRINT**
4. 출력 전용 창이 열려 인쇄 창을 띄웁니다. 인쇄 창이 닫히면 **DONE** / **PRINT AGAIN**을 고릅니다.
   - **DONE**: 문서를 지우고 창이 스스로 닫힙니다.
   - **PRINT AGAIN**: 코드를 다시 입력하지 않고 바로 다시 인쇄합니다 (취소했거나 용지가 걸렸을 때).
   - 팝업이 막혀 있으면 같은 창에서 인쇄합니다.
   - 2분 동안 아무 동작이 없으면 문서와 입력값을 지웁니다.
5. 업로드 화면의 코드 자리에 상태가 실시간으로 표시됩니다: `PRINTING` → `PRINTED`
   (DONE 없이 창이 닫히거나 시간이 지나면 `NOT PRINTED`, 5회 실패 시 `DELETED`, 만료 시 `EXPIRED`)

| 모드 | 외부인의 코드 추측 | 서버 관리자의 열람 |
|---|---|---|
| 확인코드 없음 | 5회 실패 시 삭제 + 30분 만료로 방어 | **막지 못함** (서버가 코드를 앎) |
| 확인코드 있음 | 위와 같음 | 불가 (보안 수준은 확인코드 강도에 비례) |

## 실행 방법 (개발)

필요: Python 3.11 이상, Node.js 20 이상

```powershell
# 최초 1회
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
cd frontend; npm install; cd ..
```

### 빌드한 화면으로 실행 (간단)

```powershell
cd frontend; npm run build; cd ..
python -m uvicorn --app-dir backend app.main:app --port 8000
```

→ http://localhost:8000 (메인), `/upload/` (업로드), `/print/` (출력)

### 프론트 수정하면서 실행

터미널 두 개를 씁니다. Vite가 `/api` 요청을 8000번으로 넘깁니다.

```powershell
python -m uvicorn --app-dir backend app.main:app --port 8000 --reload
```

```powershell
cd frontend; npm run dev
```

→ http://localhost:5173

> Web Crypto API는 HTTPS 또는 `localhost`에서만 동작합니다. 배포 시에는 반드시 HTTPS를 붙이세요.

### 프린터실 PC에서 시험하기 (임시 HTTPS 터널)

노트북의 서버를 Cloudflare 임시 터널로 인터넷에 연결합니다. 계정은 필요 없습니다.

```powershell
# 최초 1회
winget install --id Cloudflare.cloudflared
```

```powershell
.\scripts\tunnel.ps1
```

연결되면 화면에 메인·출력 주소가 초록 상자로 표시되고, 메인 화면이 브라우저로 열리며,
출력 주소(`/print/`)는 클립보드에 복사됩니다. Ctrl+C로 끄면 서버도 함께 종료됩니다.
주소는 실행할 때마다 바뀝니다. cloudflared의 자세한 로그는 `%TEMP%\printcode-tunnel.log`에 남습니다.

- 노트북이 켜져 있고 스크립트가 실행 중일 때만 접속됩니다.
- 요청 횟수 제한(M4) 전이므로 **시험할 때만 켜고 주소를 공개하지 마세요.**
- HTTPS는 Cloudflare에서 끝나므로 Cloudflare는 코드·인증 토큰 같은 요청 내용을 볼 수 있습니다.
  파일은 브라우저에서 암호화된 상태라 내용은 볼 수 없습니다.

## 테스트

```powershell
cd backend; python -m pytest
```

```powershell
cd frontend; npm test
```

## 설정 (환경변수)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PRINTCODE_DATA_DIR` | `./data` | SQLite DB와 암호문 저장 폴더 |
| `PRINTCODE_FILE_TTL` | `1800` | 업로드 파일 유효 시간(초) |
| `PRINTCODE_RESERVE_TTL` | `300` | 코드 예약 후 업로드까지 허용 시간(초) |
| `PRINTCODE_MAX_PDF_MB` | `90` | PDF 최대 크기(MB). `0`이면 제한 없음. 업로드 화면도 이 값을 따름 |

> 기본 90MB는 Cloudflare 임시 터널의 요청 크기 제한(100MB) 때문입니다.
> 직접 운영하는 서버에서는 `0`(제한 없음)으로 둘 수 있지만, 그러면 누구나 서버 디스크를 채울 수 있으므로
> IP별 업로드 횟수 제한(M4)과 함께 쓰세요. 이 경우에도 브라우저가 파일 전체를 메모리에서 한 번에
> 암호화·복호화하므로, 실제 한계는 업로드·출력 PC의 메모리입니다.

## 구조

```
backend/app/   api.py(HTTP 엔드포인트) ws.py(WebSocket) lifecycle.py(상태 알림·정리 작업)
               db.py(SQLite) storage.py(암호문 파일) schemas.py(입력 검증) config.py
frontend/src/  crypto.js(Argon2id·HKDF·AES-GCM) upload.js print.js(출력 화면)
               printwindow.js(출력 전용 창) printjob.js(복호화·인쇄·정리) pdfview.js(pdf.js) api.js
```

암호화 설계: `master = Argon2id(code|phrase, salt)` → HKDF로 `enc_key`(AES-GCM-256)와
`auth_token`을 분리. 서버는 `SHA-256(auth_token)`만 저장하고, 토큰이 맞을 때만 암호문을 내려줍니다.
