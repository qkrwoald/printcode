import assert from 'node:assert/strict';
import { test } from 'node:test';

import { documentFonts, fontKeys, matchLocalFonts, officeKind, readZip } from '../src/convert.js';
import { makeDocx, makePptxParts, makeZip } from './fixtures/office.js';

test('변환 대상 판별: docx·pptx만 (매크로·옛 형식 제외)', () => {
  assert.equal(officeKind('보고서.DOCX'), 'docx');
  assert.equal(officeKind('발표.pptx'), 'pptx');
  for (const n of ['a.pdf', 'a.docm', 'a.pptm', 'a.doc', 'a.ppt', 'a.hwp', 'docx']) {
    assert.equal(officeKind(n), null, n);
  }
});

test('zip 읽기: 원하는 파일만 꺼낸다', async () => {
  const zip = makeZip({ 'a.xml': '<a/>', 'b/c.xml': '한글' });
  const files = await readZip(zip, (n) => n === 'b/c.xml');
  assert.deepEqual([...files.keys()], ['b/c.xml']);
  assert.equal(new TextDecoder().decode(files.get('b/c.xml')), '한글');
});

test('zip이 아니면 거절', async () => {
  await assert.rejects(readZip(new TextEncoder().encode('not a zip at all, just text'), () => true));
});

test('docx에서 글꼴 이름 읽기', async () => {
  const { names, embedded } = await documentFonts(makeDocx({ eastAsiaFont: '바탕' }), 'docx');
  assert.deepEqual(names.sort(), ['Arial', '바탕'].sort());
  assert.equal(embedded, false);
});

test('pptx에서 글꼴 이름 읽기: 테마 참조(+mj-lt)·다른 문자권 제외, 포함 글꼴 감지', async () => {
  const { names, embedded } = await documentFonts(makePptxParts(), 'pptx');
  assert.deepEqual(names.sort(), ['Calibri Light', '나눔고딕', '맑은 고딕'].sort());
  assert.equal(embedded, true);
});

test('한·영 글꼴 이름 맞추기', () => {
  assert.ok(fontKeys('맑은 고딕').has('malgungothic'));
  const local = [
    { family: 'Malgun Gothic', fullName: 'Malgun Gothic', postscriptName: 'MalgunGothicRegular' },
    { family: 'Malgun Gothic', fullName: 'Malgun Gothic Bold', postscriptName: 'MalgunGothicBold' },
    { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT' },
    { family: 'Batang', fullName: 'Batang', postscriptName: 'Batang' },
  ];
  const { picked, missing } = matchLocalFonts(['맑은 고딕', 'Arial', '없는글꼴'], local);
  assert.deepEqual(
    picked.map((f) => f.postscriptName),
    ['MalgunGothicRegular', 'MalgunGothicBold', 'ArialMT'],
  );
  assert.deepEqual(missing, ['없는글꼴']);
});
