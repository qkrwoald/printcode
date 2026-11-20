// 업로드 화면 (내 노트북). 사용자 입력은 textContent로만 화면에 넣는다 (XSS 방지).
import { getConfig, reserveCode, uploadBlob } from './api.js';
import { b64uEncode, normalizePhrase, sealFile } from './crypto.js';

// 최대 크기는 서버 설정을 따른다 (null = 제한 없음). 서버도 같은 값으로 다시 검사한다.
let maxPdfBytes = null;
const toMB = (bytes) => Math.round(bytes / (1024 * 1024));

const $ = (id) => document.getElementById(id);
const form = $('upload-form');
const fileInput = $('file');
const phraseInput = $('phrase');
const statusEl = $('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setFormDisabled(disabled) {
  form.querySelectorAll('input, button').forEach((el) => (el.disabled = disabled));
}

// 파일을 고르기 전에는 아무것도 표시하지 않고, 고르면 파일 이름만 보여준다.
fileInput.addEventListener('change', () => {
  $('file-name').textContent = fileInput.files[0]?.name ?? '';
});

getConfig()
  .then((cfg) => {
    maxPdfBytes = cfg.max_pdf_bytes;
  })
  .catch(() => {
    /* 서버가 업로드 때 다시 검사하므로 여기서 실패해도 진행 가능 */
  });

async function readPdf(file) {
  if (!file) throw new Error('Select a PDF file.');
  if (maxPdfBytes && file.size > maxPdfBytes) {
    throw new Error(`File too large (max ${toMB(maxPdfBytes)} MB).`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 확장자만 믿지 않고 PDF 시그니처를 확인한다.
  const sig = new TextDecoder().decode(bytes.subarray(0, 5));
  if (sig !== '%PDF-') throw new Error('Not a PDF file.');
  return bytes;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 확인코드는 길이 제한 없음 (비우면 사용 안 함). 짧을수록 서버 관리자의 오프라인 대입에 약하다.
  const phrase = normalizePhrase(phraseInput.value);

  const file = fileInput.files[0];
  setFormDisabled(true);
  let pdfBytes;
  try {
    pdfBytes = await readPdf(file);

    setStatus('Issuing code…');
    const reserved = await reserveCode();

    setStatus('Encrypting…');
    const t0 = performance.now();
    const { salt, authHash, blob, kdf } = await sealFile({
      code: reserved.code,
      phrase,
      pdfBytes,
      meta: { name: file.name, size: file.size, type: 'application/pdf', createdAt: Date.now() },
    });
    console.info(`Argon2id+encrypt: ${Math.round(performance.now() - t0)}ms`);

    setStatus('Uploading…');
    const uploaded = await uploadBlob(
      {
        code: reserved.code,
        upload_token: reserved.upload_token,
        salt: b64uEncode(salt),
        auth_hash: b64uEncode(authHash),
        kdf_m: kdf.m,
        kdf_t: kdf.t,
        kdf_p: kdf.p,
        has_phrase: phrase.length > 0,
      },
      blob,
    );

    showResult(reserved.code, uploaded.expires_in);
  } catch (err) {
    setStatus(err.message || 'Upload failed.', true);
    setFormDisabled(false);
  } finally {
    pdfBytes?.fill(0);
  }
});

function showResult(code, expiresIn) {
  phraseInput.value = '';
  form.hidden = true;
  setStatus('');
  $('code').textContent = code;
  $('result').hidden = false;
  startCountdown(Date.now() + expiresIn * 1000);
}

// 만료까지 남은 시간을 1초마다 표시한다. 탭이 백그라운드에서 느려져도 어긋나지 않도록
// 매번 마감 시각과의 차이로 다시 계산한다.
function startCountdown(deadline) {
  const timer = $('timer');
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    timer.textContent = `${mm}:${ss}`;
    if (left === 0) {
      clearInterval(id);
      timer.classList.add('expired'); // 만료: 빨간 취소선
    }
  };
  const id = setInterval(tick, 1000);
  tick();
}

$('again').addEventListener('click', () => location.reload());
