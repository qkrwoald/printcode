// 업로드 화면 (내 노트북). 사용자 입력은 textContent로만 화면에 넣는다 (XSS 방지).
import { getConfig, reserveCode, uploadBlob, wsUrl } from './api.js';
import { b64uEncode, normalizePhrase, sealFile } from './crypto.js';
import { buildPrintPdf, isDefaultSettings, MAX_COPIES } from './layout.js';
import { renderPdf } from './pdfview.js';

const PREVIEW_SCALE = 0.4; // 썸네일 배율 (A4 기준 약 240px 폭)
const PREVIEW_MAX = 12; // 미리보기로 그릴 최대 장수

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

// ── 파일 선택 → 출력 설정 → 미리보기 ──
let source = null; // { bytes, name, size } 고른 원본
let prepared = null; // { bytes, pages, settings } 미리보기로 확인된 최종 PDF (이것을 암호화해 올림)
let preview = null; // 썸네일 정리 함수
let previewJob = Promise.resolve();
let previewSeq = 0;
let previewTimer;

function readSettings() {
  const copies = Number($('copies').value);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    throw new RangeError(`Copies must be 1-${MAX_COPIES}.`);
  }
  return {
    pages: $('pages').value,
    copies,
    nup: Number(form.elements.nup.value),
    orientation: form.elements.orientation.value,
  };
}

async function clearPreview() {
  const p = preview;
  preview = null;
  await p?.cleanup();
  $('thumbs').replaceChildren();
}

// 설정을 적용한 PDF를 만들고 썸네일을 그린다. 늦게 끝난 이전 작업은 버린다(seq 비교).
async function refreshPreview() {
  const seq = ++previewSeq;
  prepared = null;
  if (!source) return;
  setStatus('Preparing preview…');
  try {
    const settings = readSettings();
    // 미리보기는 1부만 보여준다 (여러 부는 같은 내용의 반복이라 '× N부'로 표시)
    const oneCopy = { ...settings, copies: 1 };
    // 기본 설정이면 원본을 그대로 쓴다 (pdf-lib을 거치지 않아 어떤 PDF든 안전)
    const previewBytes = isDefaultSettings(oneCopy)
      ? source.bytes
      : (await buildPrintPdf(source.bytes, oneCopy)).bytes;
    // 실제로 올릴 PDF: 부수까지 반영 (부마다 새 장에서 시작하므로 장수 = 1부 장수 × 부수)
    const bytes =
      settings.copies === 1 ? previewBytes : (await buildPrintPdf(source.bytes, settings)).bytes;
    if (seq !== previewSeq) return;
    await clearPreview();
    const view = await renderPdf(previewBytes, $('thumbs'), {
      scale: PREVIEW_SCALE,
      maxPages: PREVIEW_MAX,
      className: 'thumb',
    });
    if (seq !== previewSeq) {
      await view.cleanup();
      return;
    }
    preview = view;
    prepared = { bytes, pages: view.numPages * settings.copies, settings };
    const more = view.numPages > PREVIEW_MAX ? ` · FIRST ${PREVIEW_MAX} SHOWN` : '';
    const copies = settings.copies > 1 ? ` × ${settings.copies} COPIES` : '';
    $('preview-head').textContent = `PREVIEW · ${view.numPages} ${view.numPages === 1 ? 'SHEET' : 'SHEETS'}${copies}${more}`;
    setStatus('');
  } catch (err) {
    if (seq !== previewSeq) return;
    await clearPreview();
    $('preview-head').textContent = 'PREVIEW';
    setStatus(err.message || 'Cannot preview this PDF.', true);
  }
}

function schedulePreview(delay) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    previewJob = refreshPreview();
  }, delay);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  // 파일을 고르기 전에는 아무것도 표시하지 않고, 고르면 파일 이름만 보여준다.
  $('file-name').textContent = file?.name ?? '';
  source?.bytes.fill(0);
  source = null;
  prepared = null;
  await clearPreview();
  $('settings').hidden = !file;
  if (!file) return;
  try {
    source = { bytes: await readPdf(file), name: file.name, size: file.size };
    schedulePreview(0);
  } catch (err) {
    $('settings').hidden = true;
    setStatus(err.message, true);
  }
});

// 설정을 바꾸면 잠시 뒤(입력이 멈추면) 미리보기를 다시 그린다.
$('settings-body').addEventListener('input', () => schedulePreview(300));
$('settings-body').addEventListener('change', () => schedulePreview(300));

// 출력 설정은 접혀 있다가 누르면 펼쳐진다.
$('settings-toggle').addEventListener('click', () => {
  const open = $('settings-body').hidden;
  $('settings-body').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open)); // 화살표 방향은 CSS가 이 값을 보고 바꾼다
});

function stepCopies(delta) {
  const now = Number($('copies').value);
  const base = Number.isInteger(now) ? now : 1;
  $('copies').value = String(Math.min(Math.max(base + delta, 1), MAX_COPIES));
  schedulePreview(300);
}
$('copies-down').addEventListener('click', () => stepCopies(-1));
$('copies-up').addEventListener('click', () => stepCopies(1));

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

  if (!source) {
    setStatus('Select a PDF file.', true);
    return;
  }
  setFormDisabled(true);
  try {
    // 설정을 막 바꿨다면 미리보기가 끝날 때까지 기다린다: 미리보기로 확인한 PDF만 올린다.
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
      previewJob = refreshPreview();
    }
    await previewJob;
    if (!prepared) throw new Error(statusEl.textContent || 'Cannot preview this PDF.');
    const { bytes: pdfBytes, pages, settings } = prepared;

    setStatus('Issuing code…');
    const reserved = await reserveCode();

    setStatus('Encrypting…');
    const t0 = performance.now();
    // 파일 이름·쪽수·설정도 암호문 안에만 넣는다 (서버는 모름)
    const { salt, authHash, blob, kdf } = await sealFile({
      code: reserved.code,
      phrase,
      pdfBytes,
      meta: {
        name: source.name,
        size: source.size,
        type: 'application/pdf',
        pages,
        settings,
        createdAt: Date.now(),
      },
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
    watchStatus(reserved.code, reserved.upload_token);
    // 올린 뒤에는 노트북 메모리의 평문 사본도 지운다 (실패하면 다시 시도할 수 있게 남겨 둔다)
    await clearPreview();
    pdfBytes.fill(0);
    source.bytes.fill(0);
    source = null;
    prepared = null;
  } catch (err) {
    setStatus(err.message || 'Upload failed.', true);
    setFormDisabled(false);
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
let countdownId = null;
function startCountdown(deadline) {
  const timer = $('timer');
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    timer.textContent = `${mm}:${ss}`;
    if (left === 0) {
      clearInterval(countdownId);
      timer.classList.add('expired'); // 만료: 빨간 취소선
    }
  };
  countdownId = setInterval(tick, 1000);
  tick();
}

// 서버가 알려주는 상태를 코드 자리에 크게 표시한다.
// 받아 간 뒤에는 코드를 다시 쓸 수 없으므로 코드와 타이머는 감춘다.
// 브라우저가 인쇄와 취소를 구분하지 못해 '인쇄됨' 여부는 확실히 알 수 없으므로,
// 끝난 상태는 '코드를 더 쓸 수 없음'만 알린다. 확인코드 대입 실패로 지워진 경우만 따로 경고한다.
const STATUS_LABELS = {
  printing: 'PRINTING',
  printed: 'CODE EXPIRED',
  closed: 'CODE EXPIRED',
  expired: 'CODE EXPIRED',
  deleted: 'DELETED', // 확인코드를 여러 번 틀림 → 누군가 추측했을 수 있음
};
const ALERT_EVENTS = new Set(['deleted']);

function showStatus(event) {
  const label = STATUS_LABELS[event];
  if (!label) return; // 'waiting' 등은 코드·타이머를 그대로 둔다
  clearInterval(countdownId);
  const code = $('code');
  $('result-head').textContent = 'STATUS';
  code.textContent = label;
  code.classList.add('state');
  code.classList.toggle('alert', ALERT_EVENTS.has(event));
  $('timer-row').hidden = true;
}

// 업로더 WebSocket: 토큰은 URL이 아닌 첫 메시지로 보낸다 (접속 기록에 남지 않게).
function watchStatus(code, ownerToken) {
  let ws;
  try {
    ws = new WebSocket(wsUrl('/ws/upload'));
  } catch {
    return; // 상태 알림 없이도 업로드 자체는 끝났다
  }
  ws.addEventListener('open', () => ws.send(JSON.stringify({ code, owner_token: ownerToken })));
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    showStatus(msg.event);
    if (msg.event !== 'waiting' && msg.event !== 'printing') ws.close(); // 끝난 상태
  });
}

$('again').addEventListener('click', () => location.reload());
