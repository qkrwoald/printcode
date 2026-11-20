// 출력 화면 (공용 PC). 복호화한 PDF는 메모리에만 두고, 인쇄가 끝나면 바로 지운다.
// M1은 같은 창에서 인쇄한다. 출력 전용 팝업·WebSocket·무동작 타이머는 M2에서 추가한다.
import { ApiError, fetchBlob, lookup } from './api.js';
import { b64uDecode, b64uEncode, decryptPackage, deriveKeys } from './crypto.js';
import { renderPdf } from './pdfview.js';

const $ = (id) => document.getElementById(id);
const form = $('code-form');
const digits = [...document.querySelectorAll('#code-digits .digit')]; // 코드 6칸
const phraseInput = $('phrase');
const phraseRow = $('phrase-row');
const submitBtn = $('submit');
const statusEl = $('status');
const printArea = $('print-area');

let info = null; // lookup 결과 (salt, kdf, has_phrase)

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

const getCode = () => digits.map((d) => d.value).join('');

function setBusy(busy) {
  digits.forEach((d) => (d.disabled = busy));
  phraseInput.disabled = busy;
  submitBtn.disabled = busy;
}

function resetForm() {
  info = null;
  digits.forEach((d) => (d.value = ''));
  phraseInput.value = '';
  phraseRow.hidden = true;
  submitBtn.textContent = '다음';
  setBusy(false); // 비활성 상태의 칸에는 포커스가 가지 않으므로 먼저 풀어 준다
  digits[0].focus();
}

// 코드를 바꾸면 이전 조회 결과를 버린다.
function invalidateLookup() {
  if (info) {
    info = null;
    phraseRow.hidden = true;
    phraseInput.value = '';
    submitBtn.textContent = '다음';
  }
}

// start칸부터 숫자를 차례로 채운다 (붙여넣기용).
function fillFrom(start, text) {
  const nums = text.replace(/[^0-9]/g, '').slice(0, digits.length - start);
  [...nums].forEach((n, k) => (digits[start + k].value = n));
  digits[Math.min(start + nums.length, digits.length - 1)].focus();
}

digits.forEach((d, i) => {
  // 칸에 들어가면 내용을 선택해, 다시 치면 바로 덮어쓰게 한다.
  d.addEventListener('focus', () => d.select());
  d.addEventListener('input', () => {
    d.value = d.value.replace(/[^0-9]/g, '').slice(-1); // 숫자 한 개만
    if (d.value && i < digits.length - 1) digits[i + 1].focus();
    invalidateLookup();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !d.value && i > 0) {
      e.preventDefault();
      digits[i - 1].value = '';
      digits[i - 1].focus();
      invalidateLookup();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      digits[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < digits.length - 1) {
      digits[i + 1].focus();
    }
  });
  d.addEventListener('paste', (e) => {
    e.preventDefault();
    fillFrom(i, e.clipboardData?.getData('text') ?? '');
    invalidateLookup();
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = getCode();
  if (!/^[0-9]{6}$/.test(code)) {
    setStatus('코드 6자리를 모두 입력하세요.', true);
    (digits.find((d) => !d.value) ?? digits[0]).focus();
    return;
  }

  setBusy(true);
  try {
    if (!info) {
      setStatus('코드를 확인하는 중…');
      info = await lookup(code);
      if (info.has_phrase && !phraseInput.value) {
        // 확인코드를 빠뜨려 시도 횟수를 낭비하지 않도록 입력칸을 먼저 보여준다.
        phraseRow.hidden = false;
        submitBtn.textContent = '출력';
        setStatus('이 파일은 확인코드가 필요합니다.');
        setBusy(false);
        phraseInput.focus();
        return;
      }
    }
    await decryptAndPrint(code, info.has_phrase ? phraseInput.value : '');
  } catch (err) {
    handleError(err);
    setBusy(false);
  }
});

function handleError(err) {
  if (err instanceof ApiError && err.status === 403) {
    if (err.remaining > 0) {
      setStatus(`${err.message} (남은 시도: ${err.remaining}회)`, true);
      phraseInput.value = '';
      phraseInput.focus();
    } else {
      setStatus(err.message, true);
      resetForm();
    }
  } else if (err instanceof ApiError && err.status === 404) {
    setStatus(err.message, true);
    resetForm();
  } else {
    setStatus(err.message || '파일을 열지 못했습니다.', true);
  }
}

async function decryptAndPrint(code, phrase) {
  setStatus('확인 중… (몇 초 걸릴 수 있습니다)');
  const { encKey, authToken } = await deriveKeys(code, phrase, b64uDecode(info.salt), info.kdf);
  const tokenB64u = b64uEncode(authToken);
  authToken.fill(0);

  const blob = await fetchBlob(code, tokenB64u);
  // 서버가 암호문을 내려줬다면 이미 서버에서 삭제됐다 (1회성).
  phraseInput.value = '';

  setStatus('문서를 여는 중…');
  let pdfBytes;
  let view;
  try {
    ({ pdfBytes } = await decryptPackage(blob, encKey));
    view = await renderPdf(pdfBytes, printArea);
  } catch {
    throw new Error('파일을 열 수 없습니다. 손상되었거나 지원하지 않는 PDF입니다.');
  } finally {
    blob.fill(0);
    pdfBytes?.fill(0);
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await view.cleanup();
    } finally {
      resetForm();
      setBusy(false);
      setStatus('출력을 마쳤습니다. 화면과 메모리에서 문서를 지웠습니다.');
    }
  };
  window.addEventListener('afterprint', cleanup, { once: true });

  setStatus(`인쇄 창을 여는 중… (${view.numPages}쪽)`);
  window.print();
  // afterprint가 오지 않는 브라우저 대비 안전장치. print()가 바로 돌아오는 브라우저도 있어
  // 너무 짧으면 인쇄 전에 지워지므로 넉넉히 둔다. (M2에서 2분 무동작 정리로 대체)
  setTimeout(cleanup, 60_000);
}

resetForm();
