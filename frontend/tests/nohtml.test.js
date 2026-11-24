// XSS 방지 규칙 검사: 사용자 입력을 HTML로 해석하는 API를 쓰지 않는다 (textContent만 사용).
// CSP도 인라인 스크립트·eval을 막지만, 코드에서부터 쓰지 않도록 확인한다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const srcDir = join(root, 'src');
const htmlFiles = ['index.html', 'upload/index.html', 'print/index.html', 'print/window/index.html'];

// 주석은 검사에서 뺀다 (설명 글에 단어가 나올 수 있음)
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('JS에서 HTML 해석·동적 코드 실행 API를 쓰지 않는다', () => {
  const banned = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/;
  for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.js'))) {
    const code = stripComments(readFileSync(join(srcDir, f), 'utf8'));
    assert.equal(banned.test(code), false, `${f}: ${code.match(banned)?.[0]}`);
  }
});

test('HTML에 인라인 스크립트·이벤트 속성·style 속성이 없다 (CSP와 맞춤)', () => {
  for (const f of htmlFiles) {
    const html = readFileSync(join(root, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    // src 없는 <script>
    assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), false, `${f}: inline <script>`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${f}: on* 이벤트 속성`);
    assert.equal(/\sstyle\s*=/i.test(html), false, `${f}: style 속성`);
  }
});
