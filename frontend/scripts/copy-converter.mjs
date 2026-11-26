// 빌드 후 실행: 문서 변환기(LibreOffice WASM)와 대체 한글 글꼴을 dist/converter/<버전>/에 복사한다.
// 외부 CDN이 아니라 우리 서버에서 내려주기 위해서다 (CSP·외부 요청 없음 원칙).
// 경로에 버전을 넣어, 파일이 바뀌지 않는 한 브라우저가 오래 캐시해도 안전하게 한다 (약 240MB를 매번 받지 않게).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = `${root}node_modules/@matbee/libreoffice-converter/`;
const { version } = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'));
const { rev } = JSON.parse(readFileSync(`${root}converter.config.json`, 'utf8'));
const out = `${root}dist/converter/${version}-${rev}/`;

mkdirSync(`${out}wasm`, { recursive: true });
mkdirSync(`${out}fonts`, { recursive: true });
for (const f of ['soffice.js', 'soffice.wasm', 'soffice.data', 'soffice.worker.js']) {
  cpSync(`${pkgDir}wasm/${f}`, `${out}wasm/${f}`);
}
cpSync(`${pkgDir}dist/browser.worker.global.js`, `${out}browser.worker.global.js`);

// 대체 한글 글꼴: 문서에도, 내 컴퓨터에도 글꼴이 없을 때 쓴다 (Pretendard, OFL)
const pretendard = `${root}node_modules/pretendard/dist/public/static/`;
for (const f of ['Pretendard-Regular.otf', 'Pretendard-Bold.otf']) {
  cpSync(`${pretendard}${f}`, `${out}fonts/${f}`);
}
console.log(`converter → dist/converter/${version}-${rev}/`);

// hwp·hwpx 변환기(rhwp WASM, MIT). 주소 규칙은 src/hwp.js의 HWP_WASM_URL과 같다.
const rhwpDir = `${root}node_modules/@rhwp/core/`;
const rhwpVersion = JSON.parse(readFileSync(`${rhwpDir}package.json`, 'utf8')).version;
const rhwpOut = `${root}dist/converter/rhwp-${rhwpVersion}-${rev}/`;
mkdirSync(rhwpOut, { recursive: true });
cpSync(`${rhwpDir}rhwp_bg.wasm`, `${rhwpOut}rhwp_bg.wasm`);
console.log(`hwp converter → dist/converter/rhwp-${rhwpVersion}-${rev}/`);

// rhwp의 JS에는 wasm 기본 주소(new URL('rhwp_bg.wasm', import.meta.url))가 있어 Vite가 dist/assets/에도
// 같은 wasm(28MB)을 복사한다. 우리는 항상 위 /converter/ 주소를 넘겨 쓰므로 이 사본은 쓰이지 않는다 → 지운다.
for (const f of readdirSync(`${root}dist/assets/`)) {
  if (/^rhwp_bg-.*\.wasm$/.test(f)) rmSync(`${root}dist/assets/${f}`);
}

// 오픈소스 고지: 브라우저로 내려보내는 패키지의 라이선스 원문을 dist/licenses/에 함께 둔다 (public/licenses.txt에서 안내)
cpSync(`${rhwpDir}notices/`, `${root}dist/licenses/rhwp/`, { recursive: true });
cpSync(`${rhwpDir}LICENSE`, `${root}dist/licenses/rhwp/LICENSE`);
cpSync(`${root}node_modules/@fontsource/ibm-plex-mono/LICENSE`, `${root}dist/licenses/ibm-plex-mono-LICENSE`);
console.log('licenses → dist/licenses/');
