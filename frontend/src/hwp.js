// hwp·hwpx → PDF 변환 (노트북 브라우저 안에서만, 실험 기능). 문서는 평문으로 노트북 밖에 나가지 않는다.
// 변환기: rhwp(@rhwp/core, MIT, Rust+WASM). 쪽마다 캔버스에 그린 뒤 PNG로 PDF에 넣는다.
// - 글자가 그림으로 들어가므로 PDF 안의 글자를 고를 수는 없지만, 인쇄 결과는 미리보기와 같다.
// - 글꼴: 캔버스는 노트북에 설치된 글꼴을 이름으로 바로 쓴다(한컴 글꼴이 있으면 그대로).
//   없으면 rhwp가 정한 대체 글꼴(명조·고딕 계열)로 그린다. 그래서 변환 후 미리보기 확인을 안내한다.
import rhwpPkg from '@rhwp/core/package.json' with { type: 'json' };
import converterConfig from '../converter.config.json' with { type: 'json' };
import { readZip } from './convert.js';

// wasm(약 28MB)은 docx 변환기처럼 버전이 들어간 /converter/ 경로에서 내려준다 (scripts/copy-converter.mjs).
// 브라우저 일반 캐시는 이렇게 큰 파일을 보관하지 않아, 서비스 워커(public/sw.js)가 /converter/ 파일만 저장해 둔다.
export const HWP_WASM_URL = `/converter/rhwp-${rhwpPkg.version}-${converterConfig.rev}/rhwp_bg.wasm`;

export const HWP_EXTENSIONS = ['hwp', 'hwpx'];
const SCALE = 2; // 화면 px(96dpi) × 2 ≈ 192dpi. 인쇄에 충분한 선명도
const MAX_PAGES = 300; // 메모리 보호: 이보다 긴 문서는 받지 않는다
const PX_TO_PT = 0.75; // 96dpi px → 72dpi pt

/** 파일 확장자로 hwp 계열인지 판단 ('hwp' | 'hwpx' | null) */
export function hwpKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m?.[1].toLowerCase();
  return HWP_EXTENSIONS.includes(ext) ? ext : null;
}

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // HWP 5.0 (MS 복합 문서 형식)
const HWP3 = 'HWP Document File'; // 옛 HWP 3.x

/** 확장자만 믿지 않고 파일 앞부분(시그니처)으로 형식을 확인한다. 맞지 않으면 오류. */
export async function checkHwpSignature(bytes, kind) {
  if (kind === 'hwp') {
    const isCfb = CFB.every((b, i) => bytes[i] === b);
    const isHwp3 = new TextDecoder().decode(bytes.subarray(0, HWP3.length)) === HWP3;
    if (!isCfb && !isHwp3) throw new Error('Not a valid HWP file.');
    return;
  }
  // hwpx: zip이고, 첫 항목 mimetype이 'application/hwp+zip'
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a valid HWPX file.');
  let files;
  try {
    files = await readZip(bytes, (name) => name === 'mimetype');
  } catch {
    throw new Error('Not a valid HWPX file.');
  }
  const mime = files.get('mimetype');
  if (!mime || new TextDecoder().decode(mime).trim() !== 'application/hwp+zip') {
    throw new Error('Not a valid HWPX file.');
  }
}

// rhwp는 줄바꿈·정렬 계산에 글자 폭이 필요해 이 전역 함수를 부른다 (WASM 안에서는 글꼴을 못 보므로).
// 초기화 전에 등록해야 한다.
let measureCtx = null;
let lastFont = '';
function measureTextWidth(font, text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (font !== lastFont) {
    measureCtx.font = font;
    lastFont = font;
  }
  return measureCtx.measureText(text).width;
}

let ready = null; // 변환기는 한 번만 불러온다 (이후 문서마다 재사용)
function loadRhwp() {
  ready ??= (async () => {
    globalThis.measureTextWidth = measureTextWidth;
    const mod = await import('@rhwp/core');
    // wasm은 우리 서버에서 내려준다 (CSP 'wasm-unsafe-eval'로 허용된 컴파일만 사용, eval 없음)
    await mod.default({ module_or_path: HWP_WASM_URL });
    return mod;
  })().catch((err) => {
    ready = null; // 실패하면 다음에 다시 시도
    throw err;
  });
  return ready;
}

/**
 * hwp·hwpx를 PDF로 바꾼다. 반환: PDF 바이트(Uint8Array)
 * onStatus: 진행 상황 표시 함수
 */
export async function hwpToPdf(bytes, { onStatus = () => {} } = {}) {
  onStatus('Loading converter…');
  const { HwpDocument } = await loadRhwp();
  const { PDFDocument } = await import('pdf-lib');

  let doc;
  try {
    doc = new HwpDocument(bytes);
  } catch {
    throw new Error('Cannot open this file. Password-protected or damaged files are not supported.');
  }
  const canvas = document.createElement('canvas');
  try {
    const total = doc.pageCount();
    if (total < 1) throw new Error('This document has no pages.');
    if (total > MAX_PAGES) throw new Error(`Too many pages (max ${MAX_PAGES}).`);

    const pdf = await PDFDocument.create();
    for (let i = 0; i < total; i++) {
      onStatus(`Converting… ${i + 1} / ${total}`);
      const { width, height } = JSON.parse(doc.getPageInfo(i)); // 쪽 크기 (96dpi px)
      doc.renderPageToCanvas(i, canvas, SCALE);
      // toBlob은 비동기라 쪽 사이에 화면이 멈추지 않고 진행 표시가 갱신된다
      const png = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Cannot draw this page.'))), 'image/png'),
      );
      const image = await pdf.embedPng(await png.arrayBuffer());
      const w = width * PX_TO_PT;
      const h = height * PX_TO_PT;
      pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    }
    return await pdf.save();
  } finally {
    // 문서 메모리(WASM)와 캔버스 픽셀을 바로 비운다
    doc.free();
    canvas.width = 0;
    canvas.height = 0;
  }
}
