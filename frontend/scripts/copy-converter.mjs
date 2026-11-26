// 빌드 후 실행: 문서 변환기(LibreOffice WASM)와 대체 한글 글꼴을 dist/converter/<버전>/에 복사한다.
// 외부 CDN이 아니라 우리 서버에서 내려주기 위해서다 (CSP·외부 요청 없음 원칙).
// 경로에 버전을 넣어, 파일이 바뀌지 않는 한 브라우저가 오래 캐시해도 안전하게 한다 (약 240MB를 매번 받지 않게).
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
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
