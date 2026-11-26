// 업로드 화면 (내 노트북). 사용자 입력은 textContent로만 화면에 넣는다 (XSS 방지).
import { getConfig, reserveCode, uploadBlob, wsUrl } from './api.js';
import { b64uEncode, normalizePhrase, sealFile } from './crypto.js';
import { convertToPdf, officeKind, prefetchConverter } from './convert.js';
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
let fileSeq = 0;
let reading = false; // 파일을 읽거나 docx·pptx를 변환하는 중
let previewPdf = null; // 미리보기로 그린 PDF (썸네일을 눌러 크게 볼 때 다시 그림)
let sourceNote = ''; // 변환 안내 (예: 글꼴이 바뀌었을 수 있음)

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
  previewPdf = null;
  closeZoom();
  await p?.cleanup();
  $('thumbs').replaceChildren();
}

// ── 썸네일을 누르면 그 장을 크게 본다 (글꼴이 바뀐 곳 등을 확인하기 위해). 아무 곳이나 누르거나 Esc로 닫는다 ──
// 한 장이 화면 높이에 맞게 보이고(CSS), ‹ › 버튼·화살표 키로 이전·다음 장을 넘긴다.
let zoomView = null;
let zoomPage = 0;
let zoomSeq = 0;
const zoomTotal = () => preview?.numPages ?? 0;

async function openZoom(pageNumber) {
  if (!previewPdf || pageNumber < 1 || pageNumber > zoomTotal()) return;
  const seq = ++zoomSeq;
  zoomPage = pageNumber;
  $('zoom').hidden = false;
  $('zoom-count').textContent = `${pageNumber} / ${zoomTotal()}`;
  $('zoom-prev').disabled = pageNumber <= 1;
  $('zoom-next').disabled = pageNumber >= zoomTotal();
  // 새 장을 다 그린 뒤 이전 장을 지운다 (넘길 때 깜빡이지 않게). 선명하도록 화면 배율도 반영
  const box = document.createElement('div');
  const view = await renderPdf(previewPdf, box, {
    scale: 2 * (window.devicePixelRatio || 1),
    pages: [pageNumber],
    className: 'zoom-canvas',
  });
  if (seq !== zoomSeq || $('zoom').hidden) return view.cleanup(); // 그사이 넘기거나 닫힘
  const old = zoomView;
  zoomView = view;
  $('zoom-page').replaceChildren(...box.childNodes);
  old?.cleanup();
}
function closeZoom() {
  zoomSeq++;
  $('zoom').hidden = true;
  zoomView?.cleanup();
  zoomView = null;
  $('zoom-page').replaceChildren();
}
$('thumbs').addEventListener('click', (e) => {
  const thumbs = [...$('thumbs').querySelectorAll('canvas')];
  const i = thumbs.indexOf(e.target);
  if (i >= 0) openZoom(i + 1);
});
$('zoom-prev').addEventListener('click', () => openZoom(zoomPage - 1));
$('zoom-next').addEventListener('click', () => openZoom(zoomPage + 1));
// 바탕(문서 밖)을 누르면 닫힌다. 문서·버튼을 누를 때는 닫지 않는다.
$('zoom').addEventListener('click', (e) => {
  if (e.target === $('zoom') || e.target === $('zoom-page')) closeZoom();
});
document.addEventListener('keydown', (e) => {
  if ($('zoom').hidden) return;
  if (e.key === 'Escape') closeZoom();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') openZoom(zoomPage + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') openZoom(zoomPage - 1);
});

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
    previewPdf = previewBytes;
    prepared = { bytes, pages: view.numPages * settings.copies, settings };
    const more = view.numPages > PREVIEW_MAX ? ` · FIRST ${PREVIEW_MAX} SHOWN` : '';
    const copies = settings.copies > 1 ? ` × ${settings.copies} COPIES` : '';
    $('preview-head').textContent = `PREVIEW · ${view.numPages} ${view.numPages === 1 ? 'SHEET' : 'SHEETS'}${copies}${more}`;
    setStatus(sourceNote);
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
  $('preview-head').textContent = 'PREVIEW';
  $('settings').hidden = true;
  sourceNote = '';
  fontAnswer?.(false); // 묻는 도중 다른 파일을 고르면 이전 질문은 '아니오'로 끝낸다
  const seq = ++fileSeq; // 변환 중 다른 파일을 고르면 이전 결과는 버린다
  const isCurrent = () => seq === fileSeq;
  setReading(false);
  if (!file) return;
  setReading(true);
  try {
    const { bytes, substituted } = await readSource(file, isCurrent);
    if (!isCurrent()) return bytes.fill(0);
    source = { bytes, name: file.name, size: file.size };
    $('settings').hidden = false;
    if (substituted) {
      // 문서의 글꼴 일부를 찾지 못해 대체 글꼴로 바뀌었을 수 있다 → 미리보기를 펼쳐 확인하게 한다
      sourceNote = 'Some fonts were replaced. Check the preview.';
      openSettings(true);
    }
    schedulePreview(0);
  } catch (err) {
    if (!isCurrent()) return;
    setStatus(err.message || 'Cannot read this file.', true);
  } finally {
    if (isCurrent()) setReading(false);
  }
});

// 읽기·변환 중에는 UPLOAD를 막는다 (아직 올릴 PDF가 없으므로)
function setReading(on) {
  reading = on;
  form.querySelector('button[type="submit"]').disabled = on;
}

// 설정을 바꾸면 잠시 뒤(입력이 멈추면) 미리보기를 다시 그린다.
$('settings-body').addEventListener('input', () => schedulePreview(300));
$('settings-body').addEventListener('change', () => schedulePreview(300));

// 출력 설정은 접혀 있다가 누르면 펼쳐진다.
function openSettings(open) {
  $('settings-body').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open)); // 화살표 방향은 CSS가 이 값을 보고 바꾼다
}
$('settings-toggle').addEventListener('click', () => openSettings($('settings-body').hidden));

function stepCopies(delta) {
  const now = Number($('copies').value);
  const base = Number.isInteger(now) ? now : 1;
  $('copies').value = String(Math.min(Math.max(base + delta, 1), MAX_COPIES));
  schedulePreview(300);
}
$('copies-down').addEventListener('click', () => stepCopies(-1));
$('copies-up').addEventListener('click', () => stepCopies(1));

prefetchConverter(); // docx·pptx 변환을 빠르게: 화면을 열면 변환기를 미리 받아 둔다

getConfig()
  .then((cfg) => {
    maxPdfBytes = cfg.max_pdf_bytes;
  })
  .catch(() => {
    /* 서버가 업로드 때 다시 검사하므로 여기서 실패해도 진행 가능 */
  });

// 내 컴퓨터 글꼴을 써도 되는지 묻는다. 누른 버튼의 클릭으로 바로 권한 창이 뜬다.
let fontAnswer = null; // 대답을 기다리는 중이면 그 resolve 함수
function askFontPermission() {
  setStatus('Use the fonts on this computer for an accurate layout?');
  $('font-ask').hidden = false;
  $('font-yes').focus();
  return new Promise((resolve) => {
    fontAnswer = (yes) => {
      fontAnswer = null;
      $('font-ask').hidden = true;
      resolve(yes);
    };
  });
}
$('font-yes').addEventListener('click', () => fontAnswer?.(true));
$('font-no').addEventListener('click', () => fontAnswer?.(false));

function checkSize(size) {
  if (maxPdfBytes && size > maxPdfBytes) {
    throw new Error(`File too large (max ${toMB(maxPdfBytes)} MB).`);
  }
}

/** 고른 파일을 PDF 바이트로 만든다. docx·pptx는 브라우저 안에서 변환한다. 반환: { bytes, substituted } */
async function readSource(file, isCurrent) {
  checkSize(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(bytes.subarray(0, 5));
  if (officeKind(file.name)) {
    // 확장자만 믿지 않고 zip 시그니처(PK)를 확인한다.
    if (!head.startsWith('PK')) throw new Error('Not a valid Office file.');
    try {
      const { pdfBytes, substituted } = await convertToPdf(bytes, file.name, {
        onStatus: (s) => isCurrent() && setStatus(s),
        askFontPermission,
      });
      checkSize(pdfBytes.length);
      return { bytes: pdfBytes, substituted };
    } finally {
      bytes.fill(0); // 원본 문서 사본은 변환 후 바로 지운다
    }
  }
  // 확장자만 믿지 않고 PDF 시그니처를 확인한다.
  if (head !== '%PDF-') throw new Error('Not a PDF file.');
  return { bytes, substituted: false };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 확인코드는 길이 제한 없음 (비우면 사용 안 함). 짧을수록 서버 관리자의 오프라인 대입에 약하다.
  const phrase = normalizePhrase(phraseInput.value);

  if (reading) {
    setStatus('Wait until the file is ready.');
    return;
  }
  if (!source) {
    setStatus('Select a file.', true);
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
