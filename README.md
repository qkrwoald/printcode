# PrintCode

프린터실 공용 PC에 로그인하거나 파일을 내려받지 않고, **6자리 코드로 출력**하는 웹 서비스입니다.

- 내 노트북 브라우저에서 PDF를 **암호화한 뒤** 업로드합니다. 서버에는 암호문만 남습니다.
- 공용 PC에서 코드(+확인코드)를 입력하면 브라우저 메모리에서 복호화해 인쇄 창을 엽니다.
- 출력 PC가 파일을 받아 가는 순간 서버의 암호문은 삭제되고, 같은 코드로는 다시 출력할 수 없습니다.

> 현재 단계: **M6** (hwp·hwpx 브라우저 변환, 실험 기능).
> 보안 설계와 한계는 [SECURITY.md](SECURITY.md)를 보세요.

## 사용 흐름

메인(`/`)에서 **UPLOAD** 또는 **PRINT**를 고릅니다. 화면은 영어이고, 입력 칸 라벨(`01 / 파일` 등)만 한글입니다. 글꼴은 Pretendard(한글)와 IBM Plex Mono(영문·숫자)이고, 둘 다 OFL이며 서버에서 직접 내려줍니다.

1. 노트북에서 UPLOAD(`/upload/`) → PDF·docx·pptx·hwp·hwpx 선택 → (선택) 확인코드 → (필요하면) `03 / 출력 설정`을 눌러 펼치고 설정·미리보기 확인 → **UPLOAD**
   - **쪽 범위**: 비우면 전체, `1-3, 5`, `4-`(끝까지)
   - **부수**: 1~20부, 한 부씩 묶어서
   - **모아찍기**: 1 / 2 / 4쪽 모아찍기 (A4 고정. 2쪽은 가로, 4쪽은 세로가 기본. 부마다 새 장에서 시작)
   - **방향**: 자동(원본) / 세로 / 가로 (방향이 다른 쪽만 90° 회전)
   - 미리보기는 1부만 보여 주고 `× N COPIES`로 표시합니다.
   - 미리보기에 보이는 PDF가 그대로 암호화되어 올라갑니다. 기본 설정이면 원본을 그대로 올립니다.
   - 썸네일을 누르면 한 장씩 크게 봅니다(화면 높이에 맞춤, ‹ › 버튼이나 ← → 키로 넘기기, 바탕이나 Esc로 닫기).
   - 양면 인쇄는 웹에서 지정할 수 없어 인쇄 창에서 직접 고릅니다.
2. 화면에 나온 6자리 코드를 기억 (남은 시간이 1초씩 표시됨)
3. 프린터실 PC에서 PRINT(`/print/`) → 코드 6칸 입력 (6자리가 차면 자동으로 확인) → (확인코드) → **PRINT** 한 번
4. 출력 전용 창이 열려 인쇄 창을 띄웁니다. 인쇄 창이 닫히면 **DONE** / **PRINT AGAIN**을 고릅니다.
   - **DONE**: 문서를 지우고 창이 스스로 닫힙니다.
   - **PRINT AGAIN**: 코드를 다시 입력하지 않고 바로 다시 인쇄합니다 (취소했거나 용지가 걸렸을 때).
   - 팝업이 막혀 있으면 같은 창에서 인쇄합니다.
   - 2분 동안 아무 동작이 없으면 문서와 입력값을 지웁니다.
5. 업로드 화면의 코드 자리에 상태가 실시간으로 표시됩니다: `PRINTING` → `CODE EXPIRED`
   (출력·창 닫힘·만료 모두 `CODE EXPIRED`. 브라우저가 인쇄와 취소를 구분하지 못해 인쇄 여부는 표시하지 않습니다.
   확인코드 5회 실패로 지워졌을 때만 빨간 `DELETED`)

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
- 정식 운영용이 아닙니다. **시험할 때만 켜고 주소를 공개하지 마세요.**
- HTTPS는 Cloudflare에서 끝나므로 Cloudflare는 코드·인증 토큰 같은 요청 내용을 볼 수 있습니다.
  파일은 브라우저에서 암호화된 상태라 내용은 볼 수 없습니다.

## Railway에 배포하기 (지금 쓰는 방법)

저장소: https://github.com/qkrwoald/printcode — push하면 Railway가 `Dockerfile`로 빌드해 자동으로 다시 띄웁니다.
HTTPS 주소(`xxx.up.railway.app`)는 Railway가 붙여 줍니다.

### 처음 한 번 (Railway 화면에서)

1. [railway.com](https://railway.com)에 GitHub 계정으로 로그인 → New Project → **Deploy from GitHub repo** → `printcode`
2. 서비스에 **Volume** 추가, Mount path `/data` (암호문·DB 저장). 볼륨 크기를 확인해 둡니다.
3. 서비스 **Variables**:

   | 이름 | 값 | 설명 |
   |---|---|---|
   | `PRINTCODE_PROXY_HOPS` | `1` | Railway 프록시가 붙인 접속자 IP를 씀 (아래 주의) |
   | `PRINTCODE_MAX_PDF_MB` | `0` | 파일 크기 제한 없음 |
   | `PRINTCODE_MAX_TOTAL_MB` | 볼륨 크기의 80% 정도 | 예: 볼륨 500MB → `400` |

   `PRINTCODE_DATA_DIR=/data`는 `Dockerfile`에 이미 들어 있습니다.
4. Settings → Networking → **Generate Domain**
5. 접속해서 메인 화면이 뜨면 아래 "배포 후 점검"을 합니다.

- 인스턴스는 반드시 **1개**로 둡니다(횟수 제한·WebSocket 알림이 메모리에 있음). `railway.json`에 빌드·상태 확인 설정이 있습니다.
- 다시 배포하면 열려 있던 인쇄·대기 화면 연결이 끊깁니다. 올라와 있는 암호문·코드는 볼륨에 남습니다.
- **`PRINTCODE_PROXY_HOPS` 주의:** 이 값은 "앞에 믿을 프록시가 몇 개인지"입니다. 틀리면 모든 사람이 한 IP로 묶이거나
  (값이 너무 큼) 접속자가 IP를 속여 횟수 제한을 피할 수 있습니다(프록시 없는 서버에서 켬). Railway에서는 `1`로 시작하고,
  배포 후 점검에서 실제 동작을 확인합니다. Oracle·VPS처럼 같은 서버의 Caddy 뒤에서는 `0`(기본)입니다.
- 체험(30일·5달러)이 끝나면 Hobby 요금제로 올리거나, 아래 Oracle 방법으로 옮깁니다.

## Oracle Cloud에 배포하기 (무료 서버, 대안)

구성: `인터넷 ─HTTPS→ Caddy(인증서 자동) → uvicorn 1개(127.0.0.1:8000) → SQLite + 암호문 폴더`
서버는 변환하지 않고 암호문만 보관하므로 무료 서버(ARM 1코어·6GB)로 충분합니다.

### 1. Oracle 화면에서 (처음 한 번)

1. [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/) 가입. **홈 리전은 바꿀 수 없습니다**(한국이 없으면 도쿄·오사카).
   가입 후 **Pay As You Go**로 올려 두면 무료 범위는 그대로이고, 사용량이 적은 무료 서버를 회수하는 정책을 피할 수 있습니다.
2. 노트북에서 SSH 키 만들기 (PowerShell):
   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\printcode
   ```
   ```powershell
   Get-Content $HOME\.ssh\printcode.pub
   ```
   출력된 한 줄(공개키)을 다음 단계에서 붙여 넣습니다. `printcode`(비밀키) 파일은 절대 공유하지 마세요.
3. Compute → Instances → Create: 이미지 **Ubuntu 24.04**, Shape **VM.Standard.A1.Flex**(1 OCPU / 6GB),
   부트 디스크 50GB, SSH 키는 2의 공개키. "Out of capacity"면 다른 Availability Domain이나 나중에 다시 시도.
4. 인스턴스의 공인 IP를 **Reserved Public IP**로 바꾸기 (재시작해도 주소 유지).
5. 인스턴스의 VCN → Security List → Ingress Rules에 **TCP 80, 443** (Source `0.0.0.0/0`) 추가.
6. [DuckDNS](https://www.duckdns.org)에서 이름(예: `printcode-xx`)을 만들고 4의 IP를 입력 → 주소 `printcode-xx.duckdns.org`.

### 2. 서버에 설치 (처음 한 번)

```powershell
ssh -i $HOME\.ssh\printcode ubuntu@<서버 IP>
```

서버에 접속한 뒤 (`<저장소 주소>`, `<주소>`를 바꿔서):

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone <저장소 주소> /opt/printcode
sudo chown -R "$USER": /opt/printcode
sudo bash /opt/printcode/deploy/setup.sh <주소>
```

`deploy/setup.sh`가 하는 일: Caddy·Node 22·Python 설치 → 서버 안 방화벽(iptables) 80·443 열기
(Oracle 우분투는 VCN 규칙과 별개로 막혀 있음) → 전용 계정 `printcode` → 가상환경·프론트 빌드 →
`/etc/printcode.env`, systemd 서비스, `/etc/caddy/Caddyfile` 설치 → 시작. 끝나면 `https://<주소>`로 접속합니다.

- 설정 바꾸기: `sudo nano /etc/printcode.env` → `sudo systemctl restart printcode` (항목은 `deploy/printcode.env.example`)
- 기본값: 파일 크기 제한 없음(`MAX_PDF_MB=0`), 전체 보관 20GB(`MAX_TOTAL_MB=20480`)
- 로그 보기: `journalctl -u printcode -n 50` (접속 기록은 남기지 않고 오류만 남습니다)

### 3. 업데이트

노트북에서 GitHub에 push한 뒤, 서버에서:

```bash
bash /opt/printcode/deploy/update.sh
```

재시작하는 동안 열려 있던 인쇄·대기 화면의 연결이 끊기므로 사용자가 없을 때 하세요.
올라와 있는 암호문·코드는 그대로 남습니다. `deploy/Caddyfile`을 바꿨다면 `setup.sh`를 다시 실행하세요.

### 4. 배포 후 점검

- `https://<주소>`가 열리고 `http://`는 `https://`로 넘어가는지
- 응답 헤더에 `Strict-Transport-Security`, `Content-Security-Policy`, `Cross-Origin-Embedder-Policy`가 있는지
- 노트북에서 PDF·docx·hwp 업로드 → **프린터실 PC**에서 코드로 출력 (학교 필터가 주소를 막으면 허용 요청)
- 업로드 화면의 상태가 `PRINTING` → `CODE EXPIRED`로 바뀌는지 (WebSocket)

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
| `PRINTCODE_MAX_TOTAL_MB` | `5120` | 서버에 동시에 보관하는 암호문 전체 크기(MB). `0`이면 제한 없음 |
| `PRINTCODE_PROXY_HOPS` | `0` | 앞단 프록시 수. Railway처럼 주소가 바뀌는 플랫폼 프록시 뒤에서만 `1`. 프록시 없이 공개된 서버에서 켜면 IP 위조 가능 |

> 기본 90MB는 Cloudflare 임시 터널의 요청 크기 제한(100MB) 때문입니다.
> 직접 운영하는 서버에서는 `0`(제한 없음)으로 둘 수 있지만, 그러면 누구나 서버 디스크를 채울 수 있으므로
> IP별 업로드 횟수 제한(M4)과 함께 쓰세요. 이 경우에도 브라우저가 파일 전체를 메모리에서 한 번에
> 암호화·복호화하므로, 실제 한계는 업로드·출력 PC의 메모리입니다.

## docx·pptx 변환 (노트북 브라우저 안에서만)

- docx·pptx를 고르면 **노트북 브라우저 안에서** LibreOffice WASM(`@matbee/libreoffice-converter`, MPL-2.0)으로
  PDF로 바꾼 뒤, PDF와 같은 흐름(출력 설정 → 미리보기 → 암호화 → 업로드)으로 이어집니다. 문서는 평문으로 노트북 밖에 나가지 않습니다.
- 변환기(약 240MB)는 **업로드 화면을 열면 미리 받아** 둡니다(데이터 절약 모드면 받지 않음). 메인·출력 화면에서는 받지 않아, 공용 PC에는 받지 않습니다.
  브라우저의 일반 캐시는 이렇게 큰 파일을 보관하지 않아서, 서비스 워커(`public/sw.js`)가 `/converter/` 파일만
  브라우저 저장소(Cache Storage)에 보관합니다. 그래서 같은 브라우저에서는 처음 한 번만 받습니다.
- 매크로 형식(docm·pptm)과 옛 형식(doc·ppt)은 받지 않습니다.
- 글꼴 우선순위: ① 문서에 포함된 글꼴 → ② 내 컴퓨터 글꼴(Chrome·Edge, 처음에 `USE MY FONTS`로 허락) → ③ 대체 한글 글꼴(Pretendard).
  ①·②로 찾지 못한 글꼴이 있으면 `Some fonts were replaced. Check the preview.`라고 안내하고 미리보기를 펼칩니다.
- 빌드하면 `scripts/copy-converter.mjs`가 변환기 파일을 `dist/converter/<버전>-<rev>/`로 복사합니다.
  서버가 이 파일들에 주는 헤더를 바꾸면 `frontend/converter.config.json`의 `rev`를 올리세요(브라우저가 1년간 캐시).

## hwp·hwpx 변환 (실험 기능, 노트북 브라우저 안에서만)

- hwp(HWP 5.0·3.x)·hwpx를 고르면 **노트북 브라우저 안에서** rhwp(`@rhwp/core`, MIT, Rust+WASM)로 쪽마다 그려
  PDF로 만든 뒤 같은 흐름으로 이어집니다. 변환 뒤에는 `Converted from HWP. Check the preview.`를 띄우고 미리보기를 펼칩니다.
- 변환기 wasm(약 28MB)도 업로드 화면을 열면 미리 받아 서비스 워커가 보관합니다(`/converter/rhwp-<버전>-<rev>/`).
- 글꼴: 노트북에 설치된 글꼴(한컴 글꼴 포함)을 그대로 씁니다. 없으면 비슷한 명조·고딕 계열로 그립니다.
- 암호 걸린 문서와 300쪽을 넘는 문서는 받지 않습니다. 글자가 그림으로 들어가 PDF가 큽니다(17쪽에 약 4MB).
- rhwp는 0.x라 버전을 고정(`0.9.1`)해 둡니다. 올릴 때는 실제 학교 문서 몇 개로 미리보기를 다시 확인하세요.

## 구조

```
backend/app/   api.py(HTTP 엔드포인트) ws.py(WebSocket) lifecycle.py(상태 알림·정리 작업)
               db.py(SQLite) storage.py(암호문 파일) schemas.py(입력 검증) config.py
frontend/src/  crypto.js(Argon2id·HKDF·AES-GCM) layout.js(출력 설정, pdf-lib) convert.js(docx·pptx 변환) hwp.js(hwp·hwpx 변환) upload.js print.js(출력 화면)
               printwindow.js(출력 전용 창) printjob.js(복호화·인쇄·정리) pdfview.js(pdf.js) api.js
Dockerfile railway.json  Railway(컨테이너) 배포
deploy/        setup.sh(서버 처음 설치) update.sh(업데이트) Caddyfile printcode.service printcode.env.example
```

암호화 설계: `master = Argon2id(code|phrase, salt)` → HKDF로 `enc_key`(AES-GCM-256)와
`auth_token`을 분리. 서버는 `SHA-256(auth_token)`만 저장하고, 토큰이 맞을 때만 암호문을 내려줍니다.
