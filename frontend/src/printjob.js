// 인쇄 작업 한 건: 복호화 → 그리기 → 인쇄 → 정리.
// 출력 전용 팝업 창과, 팝업이 막혔을 때의 같은 창 인쇄가 함께 쓴다.
// 복호화한 PDF는 메모리에만 두고 디스크(다운로드 폴더)에는 절대 저장하지 않는다.
import { wsUrl } from './api.js';
import { decryptPackage } from './crypto.js';
import { renderPdf } from './pdfview.js';

// 아무 동작이 없으면 이 시간 뒤 문서를 지운다 (공용 PC에 화면이 남지 않게)
export const IDLE_MS = 2 * 60 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'];

/** 출력 창 WebSocket. 열려 있는 동안만 서버가 '출력 중'으로 유지하고,
 *  'printed'를 받거나 연결이 끊기면 서버가 기록을 지우고 업로더에게 알린다.
 *  연결에 실패해도 인쇄는 진행한다 (서버는 60초 뒤 스스로 정리). */
function openPrintSocket(claimToken) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl('/ws/print'));
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), 5000);
    // 토큰은 URL이 아닌 첫 메시지로 보낸다 (접속 기록에 남지 않게)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ claim_token: claimToken })));
    ws.addEventListener(
      'message',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** 인쇄 창이 닫힌 뒤 보여줄 [ DONE ] [ PRINT AGAIN ] 버튼 묶음. 상태 줄 바로 아래에 넣는다. */
function createConfirmPanel(onDone, onAgain) {
  const panel = document.createElement('div');
  panel.className = 'confirm';
  panel.hidden = true;
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'DONE';
  done.addEventListener('click', onDone);
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'secondary';
  again.textContent = 'PRINT AGAIN';
  again.addEventListener('click', onAgain);
  panel.append(done, again);
  const status = document.getElementById('status');
  status.after(panel);
  return { panel, focus: () => done.focus() };
}

/**
 * 인쇄를 진행하고 결과를 돌려준다: 'printed' | 'idle' | 'closed'
 * 브라우저는 인쇄 창에서 '인쇄'와 '취소'를 구분해 알려주지 않는다(둘 다 afterprint).
 * 그래서 인쇄 창이 닫히면 사용자가 DONE을 눌러야 완료로 처리하고, PRINT AGAIN으로 다시 인쇄할 수 있게 한다.
 */
export async function runPrintJob({ blob, encKey, claimToken, container, onStatus = () => {} }) {
  const socketPromise = openPrintSocket(claimToken);

  onStatus('Opening document…');
  let pdfBytes;
  let view;
  try {
    ({ pdfBytes } = await decryptPackage(blob, encKey));
    view = await renderPdf(pdfBytes, container);
  } catch {
    (await socketPromise)?.close();
    throw new Error('Cannot open file. Damaged or unsupported PDF.');
  } finally {
    // 암호문·평문 사본을 지운다 (JS에서 완전한 삭제는 보장되지 않지만 사본 수를 최소화)
    blob.fill(0);
    pdfBytes?.fill(0);
  }
  const ws = await socketPromise;

  return new Promise((resolve) => {
    let finished = false;
    let idleTimer;

    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), IDLE_MS);
    };
    const printNow = () => {
      onStatus(`Opening print dialog… (${view.numPages} ${view.numPages === 1 ? 'page' : 'pages'})`);
      window.print();
    };
    const confirm = createConfirmPanel(
      () => finish('printed'),
      () => {
        confirm.panel.hidden = true;
        printNow();
      },
    );
    const onAfterPrint = () => {
      if (finished) return;
      onStatus('Printed? Press DONE, or PRINT AGAIN.');
      confirm.panel.hidden = false;
      confirm.focus();
    };
    // 창을 그냥 닫으면 완료 확인을 못 받았으므로 '인쇄 안 됨'으로 처리한다 (보수적으로)
    const onPageHide = () => finish('closed');

    async function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      confirm.panel.remove();
      ACTIVITY_EVENTS.forEach((t) => window.removeEventListener(t, bumpIdle));
      window.removeEventListener('afterprint', onAfterPrint);
      window.removeEventListener('pagehide', onPageHide);
      if (result === 'printed' && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'printed' }));
      }
      try {
        await view.cleanup(); // 캔버스·pdf.js 메모리 해제
      } finally {
        ws?.close(); // 보낸 메시지가 먼저 전달된 뒤 닫힌다
        resolve(result);
      }
    }

    window.addEventListener('afterprint', onAfterPrint);
    window.addEventListener('pagehide', onPageHide);
    ACTIVITY_EVENTS.forEach((t) => window.addEventListener(t, bumpIdle, { passive: true }));
    bumpIdle();
    printNow();
  });
}
