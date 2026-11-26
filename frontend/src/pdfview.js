// pdf.js로 PDF를 캔버스에 그린다. 파일은 메모리에서만 다루고 디스크에 저장하지 않는다.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// 워커도 우리 서버에서 내려준다 (CSP: 외부 스크립트 금지)
GlobalWorkerOptions.workerSrc = workerUrl;

// 인쇄 해상도: PDF 단위(72dpi) × 2 ≈ 144dpi. 문서 출력에 충분하면서 메모리를 아낀다.
const RENDER_SCALE = 2;

/**
 * pdfBytes를 container 안에 페이지별 캔버스로 그리고, 정리 함수를 돌려준다.
 * pdf.js에 넘긴 버퍼는 워커로 이동(transfer)되므로 사본을 넘기고 원본은 호출한 쪽에서 지운다.
 * 옵션: scale(배율), maxPages(앞에서부터 몇 쪽만 그릴지, 썸네일용), className
 */
export async function renderPdf(
  pdfBytes,
  container,
  { scale = RENDER_SCALE, maxPages = Infinity, pages = null, className = 'pdf-page' } = {},
) {
  const task = getDocument({
    data: pdfBytes.slice(),
    // pdf.js v6는 eval 기반 폰트 렌더링(isEvalSupported)을 제거했고, PDF 내부 JavaScript는
    // 스크립팅 샌드박스를 붙이지 않는 한 실행되지 않는다. CSP도 eval을 막는다.
    enableXfa: false, // XFA 양식(동적 폼) 렌더링 금지
    useWasm: false, // 외부 리소스(wasm 디코더)를 추가로 불러오지 않음
    stopAtErrors: false,
  });
  const pdf = await task.promise;
  const canvases = [];
  try {
    // pages: 특정 쪽만 그릴 때 (예: 크게 보기). 없으면 앞에서부터 maxPages장까지
    const list = pages ?? Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);
    for (const n of list.filter((p) => p >= 1 && p <= pdf.numPages)) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // 쪽 방향 클래스: 인쇄할 때 쪽마다 용지 방향(@page)을 맞추는 데 쓴다 (style.css)
      canvas.className = `${className} ${viewport.width > viewport.height ? 'landscape' : 'portrait'}`;
      container.append(canvas);
      canvases.push(canvas);
      // intent 'print': 인쇄용 주석 표시를 따르고, requestAnimationFrame 없이 바로 그린다
      // (창이 백그라운드여도 렌더링이 멈추지 않음).
      await page.render({ canvas, viewport, intent: 'print' }).promise;
      page.cleanup();
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  async function cleanup() {
    for (const c of canvases) {
      // 캔버스 픽셀 버퍼를 비우고(크기 0) DOM에서 제거한다.
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    canvases.length = 0;
    // 문서·워커 메모리 해제 (v6에서는 loadingTask 쪽에서 destroy)
    await task.destroy();
  }

  return { numPages: pdf.numPages, cleanup };
}
