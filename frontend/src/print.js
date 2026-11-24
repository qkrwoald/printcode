// 출력 화면 (공용 PC). 코드 확인·인증까지만 하고, 복호화와 인쇄는 출력 전용 팝업 창이 한다.
// 팝업이 막히면 이 창에서 같은 방식으로 인쇄한다 (예비 경로).
import { ApiError, fetchBlob, lookup } from './api.js';
import { b64uDecode, b64uEncode, deriveKeys } from './crypto.js';
import { IDLE_MS, runPrintJob } from './printjob.js';

const WINDOW_URL = '/print/window/';
const WINDOW_FEATURES = 'popup,width=920,height=720';

const $ = (id) => document.getElementById(id);
const form = $('code-form');
const digits = [...document.querySelectorAll('#code-digits .digit')]; // 코드 6칸
const phraseInput = $('phrase');
const phraseRow = $('phrase-row');
const submitBtn = $('submit');
const statusEl = $('status');
const printArea = $('print-area');

let info = null; // lookup 결과 (salt, kdf, has_phrase)
let busy = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

const getCode = () => digits.map((d) => d.value).join('');

function setBusy(on) {
  busy = on;
  digits.forEach((d) => (d.disabled = on));
  phraseInput.disabled = on;
  submitBtn.disabled = on;
}

let lookupPending = null; // { code, promise } 진행 중인 코드 확인

function resetForm() {
  info = null;
  lookupPending = null;
  digits.forEach((d) => (d.value = ''));
  phraseInput.value = '';
  phraseRow.hidden = true;
  submitBtn.textContent = 'NEXT';
  setBusy(false); // 비활성 상태의 칸에는 포커스가 가지 않으므로 먼저 풀어 준다
  digits[0].focus();
}

// 코드를 바꾸면 이전 조회 결과를 버리고, 6자리가 다 차면 바로 코드를 확인한다.
// 미리 확인해 두면 버튼을 누르는 순간(기다림 없이) 출력 창을 열 수 있다 — 팝업은 클릭 직후에만 열린다.
function invalidateLookup() {
  info = null;
  lookupPending = null;
  phraseRow.hidden = true;
  phraseInput.value = '';
  submitBtn.textContent = 'NEXT';
  const code = getCode();
  if (/^[0-9]{6}$/.test(code)) startLookup(code);
}

function startLookup(code) {
  const promise = lookup(code).then((res) => ({ code, ...res }));
  lookupPending = { code, promise };
  setStatus('Checking code…');
  promise.then(
    (res) => lookupPending?.promise === promise && applyLookup(res),
    (err) => {
      if (lookupPending?.promise !== promise) return; // 그새 코드가 바뀜
      lookupPending = null;
      // 오타일 수 있으니 입력한 코드는 지우지 않는다
      setStatus(err.message || 'Could not check code.', true);
    },
  );
}

function applyLookup(res) {
  info = res;
  lookupPending = null;
  submitBtn.textContent = 'PRINT';
  if (res.has_phrase) {
    // 확인코드를 빠뜨려 시도 횟수를 낭비하지 않도록 입력칸을 먼저 보여준다.
    phraseRow.hidden = false;
    setStatus('Phrase required.');
    phraseInput.focus();
  } else {
    setStatus('Ready. Press PRINT.');
    submitBtn.focus();
  }
}

// 출력 전용 창. 반드시 클릭 처리 안에서 await 전에 열어야 팝업 차단에 걸리지 않는다.
// 창이 '준비됨'을 보내는 시점을 놓치지 않도록, 여는 즉시 기다리기 시작한다.
function openPrintWindow() {
  const popup = window.open(WINDOW_URL, 'printcode-print', WINDOW_FEATURES);
  const ready = popup ? waitForPopup(popup, 'printcode:ready', 15_000) : Promise.resolve(null);
  return {
    popup,
    ready,
    close: () => popup?.close(),
  };
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
    setStatus('Enter all 6 digits.', true);
    (digits.find((d) => !d.value) ?? digits[0]).focus();
    return;
  }

  // 이미 확인된 코드: 확인코드가 필요 없거나 입력했으면 바로 출력 창을 연다.
  if (info?.code === code) {
    if (info.has_phrase && !phraseInput.value) {
      setStatus('Phrase required.', true);
      phraseInput.focus();
      return;
    }
    const win = openPrintWindow();
    setBusy(true);
    try {
      await startPrint(code, info.has_phrase ? phraseInput.value : '', win);
    } catch (err) {
      handleError(err);
      if (busy) setBusy(false);
    }
    return;
  }

  // 아직 확인 전에 눌렀다: 클릭한 지금 출력 창부터 열어 두고 확인한다.
  // 확인코드가 필요한 파일이면 창을 닫고 확인코드 칸을 보여준다.
  const win = openPrintWindow();
  setBusy(true);
  try {
    const pending = lookupPending;
    lookupPending = null; // 자동 확인 쪽 처리와 겹치지 않게 여기서 이어받는다
    const res =
      pending?.code === code ? await pending.promise : await lookup(code).then((r) => ({ code, ...r }));
    if (res.has_phrase) {
      win.close();
      setBusy(false);
      applyLookup(res);
      return;
    }
    info = res;
    await startPrint(code, '', win);
  } catch (err) {
    win.close();
    handleError(err);
    if (busy) setBusy(false);
  }
});

function handleError(err) {
  if (err instanceof ApiError && err.status === 403) {
    if (err.remaining > 0) {
      setStatus(`${err.message} (${err.remaining} ${err.remaining === 1 ? 'attempt' : 'attempts'} left)`, true);
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
    setStatus(err.message || 'Could not open file.', true);
  }
}

// 팝업이 준비됐다고 알려 올 때까지 기다린다. 닫히거나 15초가 지나면 false.
function waitForPopup(popup, type, timeoutMs) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (e) => {
      // 우리가 연 팝업(같은 사이트)이 보낸 메시지만 받는다
      if (e.origin === location.origin && e.source === popup && e.data?.type === type) done(e.data);
    };
    window.addEventListener('message', onMessage);
    const poll = setInterval(() => popup.closed && done(null), 500);
    const timer = timeoutMs ? setTimeout(() => done(null), timeoutMs) : null;
  });
}

const RESULT_MESSAGES = {
  printed: 'Done. Document cleared from screen and memory.',
  idle: 'Timed out. Document cleared from screen and memory.',
  closed: 'Print window closed. Document cleared.',
};

async function startPrint(code, phrase, win) {
  const { popup, ready: popupReady } = win;

  let job;
  try {
    setStatus('Verifying… (may take a few seconds)');
    const { encKey, authToken } = await deriveKeys(code, phrase, b64uDecode(info.salt), info.kdf);
    const tokenB64u = b64uEncode(authToken);
    authToken.fill(0);
    const { blob, claimToken } = await fetchBlob(code, tokenB64u);
    // 여기서부터 서버의 암호문은 이미 지워졌고, 이 코드는 다시 쓸 수 없다 (1회성)
    phraseInput.value = '';
    job = { blob, encKey, claimToken };
  } catch (err) {
    popup?.close();
    throw err;
  }

  let result;
  try {
    if (popup && !popup.closed && (await popupReady)) {
      // 암호문 버퍼는 복사하지 않고 팝업으로 넘긴다(transfer). 키는 꺼낼 수 없는 CryptoKey 그대로 전달.
      popup.postMessage({ type: 'printcode:job', ...job }, location.origin, [job.blob.buffer]);
      setStatus('Printing in the print window…');
      const done = await waitForPopup(popup, 'printcode:done', 0);
      if (done?.result === 'error') throw new Error(done.message || 'Could not open file.');
      result = done?.result ?? 'closed';
    } else {
      // 팝업이 막힘 → 이 창에서 인쇄 (예비 경로)
      popup?.close();
      result = await runPrintJob({ ...job, container: printArea, onStatus: setStatus });
    }
  } finally {
    resetForm(); // 이미 받아 간 코드는 다시 쓸 수 없으므로 성공·실패와 관계없이 첫 화면으로
  }
  setStatus(RESULT_MESSAGES[result] ?? RESULT_MESSAGES.closed);
}

// 2분 동안 아무 동작이 없으면 입력한 코드·확인코드를 지우고 첫 화면으로 돌아간다.
let idleTimer;
function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!busy && (getCode() || phraseInput.value)) {
      resetForm();
      setStatus('');
    }
  }, IDLE_MS);
}
['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach((t) =>
  window.addEventListener(t, bumpIdle, { passive: true }),
);
bumpIdle();

resetForm();
