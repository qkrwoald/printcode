// docx·pptx → PDF 변환 (노트북 브라우저 안에서만). 문서는 평문으로 노트북 밖에 나가지 않는다.
// 변환기: LibreOffice WASM(@matbee/libreoffice-converter, MPL-2.0). 우리 서버에서 직접 내려준다.
//
// 글꼴 우선순위 (PDF는 글자 모양을 고정하므로 변환할 때 실제 글꼴 파일이 꼭 있어야 한다)
//   1) 문서에 포함된 글꼴 → LibreOffice가 알아서 사용
//   2) 내 컴퓨터 글꼴 → Local Font Access(Chrome·Edge, 사용자 허락)로 문서가 쓰는 글꼴만 골라 넘김
//   3) 대체 한글 글꼴(Pretendard) → 위 둘이 없을 때 빈칸(□) 대신 쓰임. 이 경우 미리보기 확인을 안내
import converterPkg from '@matbee/libreoffice-converter/package.json' with { type: 'json' };
import converterConfig from '../converter.config.json' with { type: 'json' };

// 변환기 파일은 버전이 들어간 경로에서 내려준다 (scripts/copy-converter.mjs와 같은 규칙)
const BASE = `/converter/${converterPkg.version}-${converterConfig.rev}/`;
const FALLBACK_FONTS = ['Pretendard-Regular.otf', 'Pretendard-Bold.otf'];

/**
 * 변환기 파일(약 240MB)을 미리 받아 브라우저 저장소에 넣는다. 업로드 화면을 열 때만 호출한다.
 * 메인·출력 화면(공용 PC가 거쳐 가는 곳)에서는 받지 않는다 — 공용 PC는 변환을 하지 않으므로.
 * - 화면이 다 뜬 뒤 낮은 우선순위로 받는다 (화면 로딩을 늦추지 않게).
 * - 데이터 절약 모드를 켠 사용자는 받지 않는다 (docx·pptx를 고를 때 받음).
 * - 이미 캐시에 있으면 네트워크를 쓰지 않는다 (서버가 1년 캐시를 허용).
 * extra: 함께 받을 다른 변환기 주소 (hwp 변환기 wasm, 약 28MB — 작으니 먼저 받는다)
 */
export function prefetchConverter(extra = []) {
  if (navigator.connection?.saveData) return;
  const start = async () => {
    // 변환기 파일을 브라우저 저장소에 보관하는 서비스 워커(public/sw.js)를 먼저 켠다.
    // 서비스 워커가 이 화면을 맡은 뒤에 받아야 저장소에 남는다.
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await Promise.race([
            new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        }
      } catch {
        /* 서비스 워커를 못 쓰면 그냥 받는다 (변환은 되지만 매번 받을 수 있음) */
      }
    }
    const files = [
      ...extra,
      'wasm/soffice.wasm',
      'wasm/soffice.data',
      'wasm/soffice.js',
      'browser.worker.global.js',
      ...FALLBACK_FONTS.map((f) => `fonts/${f}`),
    ];
    for (const f of files) {
      try {
        const res = await fetch(f.startsWith('/') ? f : `${BASE}${f}`, { priority: 'low' });
        // 끝까지 읽어야 캐시에 저장된다. 내용은 메모리에 모으지 않고 흘려보낸다.
        await res.body?.pipeTo(new WritableStream());
      } catch {
        return; // 실패해도 괜찮다: 변환할 때 다시 받는다
      }
    }
  };
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', () => setTimeout(start, 0), { once: true });
}

export const OFFICE_EXTENSIONS = ['docx', 'pptx'];

/** 파일 확장자로 변환 대상인지 판단 ('docx' | 'pptx' | null). 매크로 포함 형식(docm 등)은 받지 않는다. */
export function officeKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m?.[1].toLowerCase();
  return OFFICE_EXTENSIONS.includes(ext) ? ext : null;
}

// ── ZIP 읽기 (docx·pptx는 zip). 브라우저 기본 기능만 써서 라이브러리를 늘리지 않는다 ──
const MAX_XML_BYTES = 50 * 1024 * 1024; // 압축 해제 폭탄 방지: 글꼴 이름만 읽으므로 넉넉한 상한

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_XML_BYTES) {
      await reader.cancel();
      throw new Error('Document is too large to read.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** zip 안에서 want(이름)가 true인 파일들을 꺼낸다. 반환: Map<이름, Uint8Array> */
export async function readZip(bytes, want) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 끝에서 '중앙 디렉터리 끝' 표시(0x06054b50)를 찾는다
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid Office file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Not a valid Office file.');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
  }
  return files;
}

// ── 문서가 쓰는 글꼴 이름 ──
const DOCX_PARTS = /^word\/(document|styles|fontTable|numbering|header\d*|footer\d*|footnotes|endnotes)\.xml$|^word\/theme\/theme\d*\.xml$/;
const PPTX_PARTS = /^ppt\/(slides\/slide\d+|slideLayouts\/slideLayout\d+|slideMasters\/slideMaster\d+|theme\/theme\d+|presentation)\.xml$/;

/** 문서에서 글꼴 이름과 '글꼴 포함' 여부를 읽는다. */
export async function documentFonts(bytes, kind) {
  const parts = kind === 'docx' ? DOCX_PARTS : PPTX_PARTS;
  let embedded = false;
  const files = await readZip(bytes, (name) => {
    if (/^(word|ppt)\/fonts\//.test(name)) embedded = true; // 파일에 글꼴이 포함됨
    return parts.test(name);
  });
  const names = new Set();
  const td = new TextDecoder();
  const add = (v) => {
    const s = v.trim();
    if (s && !s.startsWith('+')) names.add(s); // '+mj-lt' 같은 테마 참조는 제외
  };
  for (const data of files.values()) {
    const xml = td.decode(data);
    // Word: <w:rFonts w:ascii="…" w:eastAsia="…">, <w:font w:name="…">
    for (const m of xml.matchAll(/w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g)) add(m[1]);
    for (const m of xml.matchAll(/<w:font w:name="([^"]+)"/g)) add(m[1]);
    // 테마·PowerPoint: 라틴·동아시아·복합 글꼴과 한글(Hang) 글꼴만 (다른 문자권 글꼴 목록은 제외)
    for (const m of xml.matchAll(/<a:(?:latin|ea|cs) typeface="([^"]*)"/g)) add(m[1]);
    for (const m of xml.matchAll(/<a:font script="Hang" typeface="([^"]*)"/g)) add(m[1]);
  }
  return { names: [...names], embedded };
}

// ── 글꼴 이름 맞추기: 문서에는 한글 이름(맑은 고딕), 컴퓨터 글꼴 목록에는 영문 이름(Malgun Gothic)인 경우가 많다 ──
const ALIASES = [
  ['맑은 고딕', 'Malgun Gothic'],
  ['바탕', 'Batang'],
  ['바탕체', 'BatangChe'],
  ['굴림', 'Gulim'],
  ['굴림체', 'GulimChe'],
  ['돋움', 'Dotum'],
  ['돋움체', 'DotumChe'],
  ['궁서', 'Gungsuh'],
  ['궁서체', 'GungsuhChe'],
  ['나눔고딕', 'NanumGothic'],
  ['나눔명조', 'NanumMyeongjo'],
  ['나눔바른고딕', 'NanumBarunGothic'],
  ['나눔스퀘어', 'NanumSquare'],
  ['함초롬바탕', 'HCR Batang'],
  ['함초롬돋움', 'HCR Dotum'],
  ['애플 SD 산돌고딕 Neo', 'Apple SD Gothic Neo'],
];
const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');

/** 이름 하나에 대해 비교할 키들 (자기 자신 + 한·영 별칭) */
export function fontKeys(name) {
  const keys = new Set([norm(name)]);
  for (const pair of ALIASES) {
    if (pair.some((n) => norm(n) === norm(name))) pair.forEach((n) => keys.add(norm(n)));
  }
  return keys;
}

/** 컴퓨터 글꼴 목록(queryLocalFonts 결과)에서 문서가 쓰는 글꼴만 고른다. */
export function matchLocalFonts(names, localFonts) {
  const wanted = new Set(names.flatMap((n) => [...fontKeys(n)]));
  const found = new Set();
  const picked = localFonts.filter((f) => {
    const keys = [f.family, f.fullName, f.postscriptName].filter(Boolean).map(norm);
    const hit = keys.some((k) => wanted.has(k));
    if (hit) names.forEach((n) => [...fontKeys(n)].some((k) => keys.includes(k)) && found.add(n));
    return hit;
  });
  return { picked, missing: names.filter((n) => !found.has(n)) };
}

function fontExtension(data) {
  const tag = new TextDecoder().decode(data.subarray(0, 4));
  return tag === 'OTTO' ? 'otf' : tag === 'ttcf' ? 'ttc' : 'ttf';
}

/** 내 컴퓨터 글꼴 중 문서가 쓰는 것을 가져온다. 브라우저가 지원하지 않거나 거부되면 { available: false } */
async function localFontsFor(names, askPermission) {
  const none = { available: false, fonts: [], missing: names };
  if (typeof window.queryLocalFonts !== 'function') return none; // Firefox·Safari 등
  // 아직 허락 여부를 묻지 않은 상태면, 사용자에게 먼저 물어 그 클릭으로 권한 창을 띄운다
  // (Chrome은 사용자 클릭 직후에만 권한 창을 띄울 수 있다). 이미 허용·거부했으면 묻지 않는다.
  const state = await navigator.permissions
    ?.query({ name: 'local-fonts' })
    .then((p) => p.state)
    .catch(() => 'prompt');
  if (state === 'denied') return none;
  if (state !== 'granted' && !(await askPermission())) return none;
  let all;
  try {
    all = await window.queryLocalFonts();
  } catch {
    return none;
  }
  const { picked, missing } = matchLocalFonts(names, all);
  const fonts = [];
  for (const f of picked) {
    const data = new Uint8Array(await (await f.blob()).arrayBuffer());
    fonts.push({ filename: `${f.postscriptName}.${fontExtension(data)}`, data });
  }
  return { available: true, fonts, missing };
}

// 변환기를 강제 종료한 직후 바로 새 변환기를 띄우면 초기화가 멈추는 경우가 있다(이전 워커 자원이 정리되는 중).
// 그래서 앞 변환기가 끝난 뒤 잠시 기다렸다가 새로 띄운다. (시험: 0초 간격은 멈춤, 3초 이상은 정상)
const COOLDOWN_MS = 5000;
const INIT_TIMEOUT_MS = 20_000; // 정상 초기화는 약 7초. 가끔 멈추는 경우 빨리 재시도하도록
let lastShutdownAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 변환기를 정리한다. destroy()가 응답 없이 멈추는 경우가 있어, 3초 뒤에는 워커를 강제로 끝낸다
 *  (워커가 문서와 약 1GB 메모리를 계속 쥐고 있지 않게). worker는 라이브러리 내부 필드라 없을 수도 있다. */
async function shutdown(converter) {
  const worker = converter.worker;
  await Promise.race([converter.destroy().catch(() => {}), sleep(3000)]);
  worker?.terminate();
  lastShutdownAt = Date.now();
}

async function fallbackFonts() {
  return Promise.all(
    FALLBACK_FONTS.map(async (filename) => {
      const res = await fetch(`${BASE}fonts/${filename}`);
      if (!res.ok) throw new Error('Cannot load converter fonts.');
      return { filename, data: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
}

/**
 * docx·pptx를 PDF로 바꾼다. 반환: { pdfBytes, substituted }
 * substituted: 문서가 쓰는 글꼴 일부를 찾지 못해 대체 글꼴로 바뀌었을 수 있음 (미리보기 확인 안내용)
 */
export async function convertToPdf(bytes, filename, { onStatus = () => {}, askFontPermission = async () => false } = {}) {
  const kind = officeKind(filename);
  if (!kind) throw new Error('Unsupported file type.');

  onStatus('Reading fonts…');
  const { names, embedded } = await documentFonts(bytes, kind);
  const local = await localFontsFor(names, askFontPermission);
  const fonts = [...local.fonts, ...(await fallbackFonts())];
  const substituted = !embedded && local.missing.length > 0;

  try {
    return { pdfBytes: await runConverter(bytes, filename, fonts, onStatus), substituted, localFonts: local.available };
  } finally {
    for (const f of fonts) f.data.fill?.(0);
  }
}

/** 변환기를 띄워 한 번 변환한다. 초기화가 멈추면 한 번만 다시 시도한다. */
async function runConverter(bytes, filename, fonts, onStatus, retry = true) {
  const wait = lastShutdownAt + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    onStatus('Preparing converter…');
    await sleep(wait);
  }
  onStatus('Loading converter… (first time: about 240 MB)');
  const { WorkerBrowserConverter } = await import('@matbee/libreoffice-converter/browser');
  // 글꼴은 초기화 전에만 넣을 수 있어 문서마다 새로 만들고, 끝나면 바로 정리한다 (메모리에 문서를 남기지 않게).
  // 글꼴 버퍼는 워커로 넘어가므로(transfer) 매번 사본을 준다.
  let converting = false;
  let closed = false;
  const converter = new WorkerBrowserConverter({
    sofficeJs: `${BASE}wasm/soffice.js`,
    sofficeWasm: `${BASE}wasm/soffice.wasm`,
    sofficeData: `${BASE}wasm/soffice.data`,
    sofficeWorkerJs: `${BASE}wasm/soffice.worker.js`,
    browserWorkerJs: `${BASE}browser.worker.global.js`,
    fonts: fonts.map((f) => ({ filename: f.filename, data: f.data.slice() })),
    // 진행률: 준비 단계와 변환 단계를 나눠 보여 준다
    onProgress: (p) => {
      if (typeof p?.percent === 'number') {
        onStatus(`${converting ? 'Converting' : 'Loading converter'}… ${p.percent}%`);
      }
    },
  });
  try {
    const started = await Promise.race([
      converter.initialize().then(() => true),
      sleep(INIT_TIMEOUT_MS).then(() => false),
    ]);
    if (!started) {
      closed = true;
      await shutdown(converter);
      if (retry) return runConverter(bytes, filename, fonts, onStatus, false);
      throw new Error('Converter did not start. Reload the page and try again.');
    }
    converting = true;
    onStatus('Converting…');
    const result = await converter.convert(bytes, { outputFormat: 'pdf' }, filename);
    return new Uint8Array(result.data);
  } finally {
    if (!closed) await shutdown(converter);
  }
}
