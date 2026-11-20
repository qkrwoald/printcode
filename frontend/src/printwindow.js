// 출력 전용 창. 출력 화면(opener)이 window.open으로 열고, 암호문과 키를 postMessage로 넘긴다.
// 스크립트가 연 창이라 인쇄가 끝나면 스스로 닫을 수 있다.
import { runPrintJob } from './printjob.js';

const statusEl = document.getElementById('status');
const printArea = document.getElementById('print-area');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

const opener = window.opener;

if (!opener) {
  setStatus('Open this window from the PRINT page.', true);
} else {
  let started = false;
  // 작업이 오지 않으면 빈 창이 남지 않게 닫는다
  const noJobTimer = setTimeout(() => window.close(), 30_000);

  window.addEventListener('message', async (e) => {
    // 같은 사이트의 opener가 보낸 메시지만 받는다
    if (e.origin !== location.origin || e.source !== opener) return;
    if (e.data?.type !== 'printcode:job' || started) return;
    started = true;
    clearTimeout(noJobTimer);

    const { blob, encKey, claimToken } = e.data;
    let result;
    let message = '';
    try {
      result = await runPrintJob({ blob, encKey, claimToken, container: printArea, onStatus: setStatus });
    } catch (err) {
      result = 'error';
      message = err.message;
    }
    try {
      opener.postMessage({ type: 'printcode:done', result, message }, location.origin);
    } catch {
      /* opener가 이미 닫힘 */
    }
    window.close();
  });

  opener.postMessage({ type: 'printcode:ready' }, location.origin);
}
