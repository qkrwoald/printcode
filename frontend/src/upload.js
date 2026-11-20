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
  if (!file) throw new Error('PDF 파일을 선택하세요.');
  if (maxPdfBytes && file.size > maxPdfBytes) {
    throw new Error(`파일은 ${toMB(maxPdfBytes)}MB 이하만 올릴 수 있습니다.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 확장자만 믿지 않고 PDF 시그니처를 확인한다.
  const sig = new TextDecoder().decode(bytes.subarray(0, 5));
  if (sig !== '%PDF-') throw new Error('PDF 파일이 아닙니다.');
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

    setStatus('코드를 발급받는 중…');
    const reserved = await reserveCode();

    setStatus('브라우저에서 암호화하는 중…');
    const t0 = performance.now();
    const { salt, authHash, blob, kdf } = await sealFile({
      code: reserved.code,
      phrase,
      pdfBytes,
      meta: { name: file.name, size: file.size, type: 'application/pdf', createdAt: Date.now() },
    });
    console.info(`Argon2id+암호화: ${Math.round(performance.now() - t0)}ms`);

    setStatus('암호문을 올리는 중…');
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

    showResult(reserved.code, uploaded.expires_in, phrase.length > 0);
  } catch (err) {
    setStatus(err.message || '업로드하지 못했습니다.', true);
    setFormDisabled(false);
  } finally {
    pdfBytes?.fill(0);
  }
});

function showResult(code, expiresIn, hasPhrase) {
  phraseInput.value = '';
  form.hidden = true;
  setStatus('');
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  $('code').textContent = code;
  $('result-note').textContent =
    `${expiresAt}까지 한 번만 출력할 수 있습니다.` + (hasPhrase ? ' 출력할 때 확인코드도 입력하세요.' : '');
  $('result').hidden = false;
}

$('again').addEventListener('click', () => location.reload());
