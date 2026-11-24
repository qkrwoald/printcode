// 출력 설정(쪽 범위·부수·모아찍기·방향)을 PDF 자체에 반영한다. 암호화 전에 노트북 브라우저에서만 실행된다.
// pdf-lib(약 500KB)는 설정을 바꿨을 때만 불러온다 (기본값이면 원본을 그대로 올리므로 필요 없음).

export const MAX_COPIES = 20;
export const DEFAULT_SETTINGS = Object.freeze({ pages: '', copies: 1, nup: 1, orientation: 'auto' });

// A4 (pt). 모아찍기 용지는 A4로 고정한다 (학교 프린터 기준).
const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const SHEET_MARGIN = 18; // 용지 가장자리 여백
const CELL_GAP = 10; // 모아찍기 칸 사이 간격

export function isDefaultSettings(s) {
  return s.pages.trim() === '' && s.copies === 1 && s.nup === 1 && s.orientation === 'auto';
}

/**
 * "1-3, 5, 8-" 형식을 0부터 시작하는 쪽 번호 배열로 바꾼다. 비우면 전체.
 * 순서와 중복은 입력한 그대로 둔다 (사용자 의도).
 */
export function parseRanges(text, pageCount) {
  const src = text.trim();
  if (src === '') return Array.from({ length: pageCount }, (_, i) => i);
  const out = [];
  for (const raw of src.split(',')) {
    const part = raw.trim();
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!m) throw new RangeError(`Invalid page range: "${part}". Use e.g. 1-3, 5`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? pageCount : Number(m[2]);
    for (const n of [from, to]) {
      if (n < 1 || n > pageCount) {
        throw new RangeError(`Page ${n} does not exist (1-${pageCount}).`);
      }
    }
    if (from > to) throw new RangeError(`Invalid page range: "${part}".`);
    for (let n = from; n <= to; n++) out.push(n - 1);
  }
  return out;
}

/** 모아찍기 용지 크기와 칸 배치 (가로 칸 수 × 세로 칸 수) */
function sheetLayout(nup, orientation) {
  // 2쪽: 기본 가로 용지에 좌우 배치 / 4쪽: 기본 세로 용지에 2×2
  const landscape = orientation === 'auto' ? nup === 2 : orientation === 'landscape';
  const [w, h] = landscape ? [A4_LONG, A4_SHORT] : [A4_SHORT, A4_LONG];
  if (nup === 2) return { w, h, cols: landscape ? 2 : 1, rows: landscape ? 1 : 2 };
  return { w, h, cols: 2, rows: 2 };
}

/**
 * 감싼 쪽(embedded)을 시계 방향 rot도만큼 돌려, 왼쪽 아래 (x, y)에 배율 s로 그린다.
 * pdf-lib의 rotate는 반시계 방향이므로 -rot을 쓰고, 돌린 뒤 영역이 (x, y)에서 시작하도록 원점을 옮긴다.
 */
function drawRotated(page, emb, rot, x, y, s, degrees) {
  const W = emb.width * s;
  const H = emb.height * s;
  const origin = {
    0: [x, y],
    90: [x, y + W],
    180: [x + W, y + H],
    270: [x + H, y],
  }[rot];
  page.drawPage(emb, { x: origin[0], y: origin[1], xScale: s, yScale: s, rotate: degrees(-rot) });
}

/** 회전을 반영한 보이는 크기 */
const visualSize = (emb, rot) => (rot % 180 === 0 ? [emb.width, emb.height] : [emb.height, emb.width]);

/**
 * 설정을 적용한 새 PDF를 만든다. 반환: { bytes, pageCount }
 * 모든 쪽을 Form XObject로 감싸 배치한다. 여러 부를 만들어도 같은 XObject를 다시 써서 크기가 거의 늘지 않는다.
 * (링크·양식 같은 상호작용 요소는 빠지지만 인쇄 결과에는 영향 없음)
 */
export async function buildPrintPdf(srcBytes, settings) {
  const { PDFDocument, degrees, EncryptedPDFError } = await import('pdf-lib');

  let src;
  let pageCount;
  try {
    // 암호가 걸린 PDF는 pdf-lib이 내용을 풀 수 없으므로 거절한다 (기본 설정으로는 그대로 업로드 가능)
    src = await PDFDocument.load(srcBytes, { updateMetadata: false });
    pageCount = src.getPageCount(); // 쪽 구조는 여기서 처음 읽힌다 (깨진 파일은 여기서 실패)
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new Error("Protected PDF: settings can't be applied. Reset settings to upload as is.");
    }
    throw new Error("Can't apply settings to this PDF. Reset settings to upload as is.");
  }

  const indices = parseRanges(settings.pages, pageCount);
  try {
    return await layoutPages(PDFDocument, degrees, src, indices, settings);
  } catch {
    throw new Error("Can't apply settings to this PDF. Reset settings to upload as is.");
  }
}

async function layoutPages(PDFDocument, degrees, src, indices, settings) {
  const copies = Math.min(Math.max(settings.copies, 1), MAX_COPIES);
  const order = Array.from({ length: copies }, () => indices).flat(); // 한 부씩 묶어서(collated)

  const out = await PDFDocument.create();
  // 같은 쪽은 한 번만 감싼다
  const unique = [...new Set(indices)];
  const srcPages = unique.map((i) => src.getPage(i));
  const boxes = srcPages.map((p) => {
    const b = p.getCropBox(); // 화면에 보이는 영역 기준
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  });
  const embedded = await out.embedPages(srcPages, boxes);
  const items = new Map(
    unique.map((i, k) => [i, { emb: embedded[k], rot: ((srcPages[k].getRotation().angle % 360) + 360) % 360 }]),
  );

  if (settings.nup === 1) {
    for (const i of order) {
      const { emb, rot } = items.get(i);
      let total = rot;
      const [vw, vh] = visualSize(emb, rot);
      // 방향을 고르면, 방향이 다른 쪽만 시계 방향으로 90° 돌린다 (용지 크기는 원본 유지)
      if (settings.orientation !== 'auto' && vw > vh !== (settings.orientation === 'landscape')) {
        total = (rot + 90) % 360;
      }
      const [pw, ph] = visualSize(emb, total);
      const page = out.addPage([pw, ph]);
      drawRotated(page, emb, total, 0, 0, 1, degrees);
    }
  } else {
    const L = sheetLayout(settings.nup, settings.orientation);
    const cellW = (L.w - 2 * SHEET_MARGIN - (L.cols - 1) * CELL_GAP) / L.cols;
    const cellH = (L.h - 2 * SHEET_MARGIN - (L.rows - 1) * CELL_GAP) / L.rows;
    const perSheet = L.cols * L.rows;
    let page;
    // 부마다 새 장에서 시작한다 (한 장에 1부의 끝과 2부의 시작이 섞이지 않게)
    const slots = order.map((_, n) => (n % indices.length) % perSheet);
    order.forEach((i, n) => {
      const slot = slots[n];
      if (slot === 0) page = out.addPage([L.w, L.h]);
      const col = slot % L.cols;
      const row = Math.floor(slot / L.cols); // 위에서부터 (PDF 좌표는 아래가 0)
      const cellX = SHEET_MARGIN + col * (cellW + CELL_GAP);
      const cellY = L.h - SHEET_MARGIN - (row + 1) * cellH - row * CELL_GAP;
      const { emb, rot } = items.get(i);
      const [vw, vh] = visualSize(emb, rot);
      const s = Math.min(cellW / vw, cellH / vh); // 비율 유지
      const x = cellX + (cellW - vw * s) / 2; // 칸 가운데
      const y = cellY + (cellH - vh * s) / 2;
      drawRotated(page, emb, rot, x, y, s, degrees);
    });
  }

  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pageCount: out.getPageCount() };
}
