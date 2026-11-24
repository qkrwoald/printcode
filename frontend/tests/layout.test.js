import assert from 'node:assert/strict';
import { test } from 'node:test';

import { degrees, PDFDocument } from 'pdf-lib';

import { buildPrintPdf, DEFAULT_SETTINGS, isDefaultSettings, parseRanges } from '../src/layout.js';

const A4 = [595.28, 841.89];

/** 테스트용 PDF: sizes 배열의 크기로 쪽을 만들고, rotations가 있으면 /Rotate 설정 */
async function makePdf(sizes, rotations = []) {
  const doc = await PDFDocument.create();
  sizes.forEach((size, i) => {
    const page = doc.addPage(size);
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  });
  return doc.save();
}

async function info(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width), Math.round(height)];
  });
}

const settings = (s) => ({ ...DEFAULT_SETTINGS, ...s });
const round = ([w, h]) => [Math.round(w), Math.round(h)];

test('쪽 범위 해석', () => {
  assert.deepEqual(parseRanges('', 3), [0, 1, 2]);
  assert.deepEqual(parseRanges('1-3, 5', 6), [0, 1, 2, 4]);
  assert.deepEqual(parseRanges(' 4 - , 1', 6), [3, 4, 5, 0]); // "4-" = 끝까지, 순서 유지
  assert.deepEqual(parseRanges('2,2', 3), [1, 1]); // 중복 허용
});

test('잘못된 쪽 범위는 거절', () => {
  for (const bad of ['0', '7', '3-1', 'a', '1;2', '1-2-3', '-2', "1' OR '1'='1"]) {
    assert.throws(() => parseRanges(bad, 6), RangeError, bad);
  }
});

test('기본 설정 판별', () => {
  assert.ok(isDefaultSettings(DEFAULT_SETTINGS));
  assert.ok(isDefaultSettings(settings({ pages: '  ' })));
  assert.equal(isDefaultSettings(settings({ copies: 2 })), false);
  assert.equal(isDefaultSettings(settings({ nup: 2 })), false);
  assert.equal(isDefaultSettings(settings({ orientation: 'portrait' })), false);
});

test('쪽 선택 + 여러 부 (한 부씩 묶어서)', async () => {
  const src = await makePdf([A4, A4, A4, A4]);
  const one = await buildPrintPdf(src, settings({ pages: '2-3' }));
  assert.equal(one.pageCount, 2);
  const three = await buildPrintPdf(src, settings({ pages: '2-3', copies: 3 }));
  assert.equal(three.pageCount, 6);
  // 같은 쪽을 다시 쓰므로 3부여도 크기가 3배로 늘지 않는다
  assert.ok(three.bytes.length < one.bytes.length * 1.5);
});

test('부수 상한 20', async () => {
  const src = await makePdf([A4]);
  assert.equal((await buildPrintPdf(src, settings({ copies: 999 }))).pageCount, 20);
});

test('2쪽 모아찍기: A4 가로, 5쪽 → 3장', async () => {
  const src = await makePdf(Array(5).fill(A4));
  const r = await buildPrintPdf(src, settings({ nup: 2 }));
  assert.equal(r.pageCount, 3);
  assert.deepEqual(await info(r.bytes), Array(3).fill(round([A4[1], A4[0]])));
});

test('모아찍기 + 여러 부: 부마다 새 장에서 시작', async () => {
  // 3쪽 × 2부, 2쪽 모아찍기 → 부마다 [1 2][3 _] → 4장 (섞이면 3장)
  const src = await makePdf([A4, A4, A4]);
  assert.equal((await buildPrintPdf(src, settings({ nup: 2, copies: 2 }))).pageCount, 4);
  // 4쪽 × 2부, 4쪽 모아찍기 → 2장
  const src4 = await makePdf([A4, A4, A4, A4]);
  assert.equal((await buildPrintPdf(src4, settings({ nup: 4, copies: 2 }))).pageCount, 2);
});

test('2쪽 모아찍기 + 세로 지정: A4 세로', async () => {
  const src = await makePdf([A4, A4]);
  const r = await buildPrintPdf(src, settings({ nup: 2, orientation: 'portrait' }));
  assert.deepEqual(await info(r.bytes), [round(A4)]);
});

test('4쪽 모아찍기: A4 세로, 5쪽 → 2장 / 가로 지정 시 A4 가로', async () => {
  const src = await makePdf(Array(5).fill(A4));
  const r = await buildPrintPdf(src, settings({ nup: 4 }));
  assert.deepEqual(await info(r.bytes), Array(2).fill(round(A4)));
  const l = await buildPrintPdf(src, settings({ nup: 4, orientation: 'landscape' }));
  assert.deepEqual(await info(l.bytes), Array(2).fill(round([A4[1], A4[0]])));
});

test('방향 지정: 다른 방향의 쪽만 90° 돌림 (용지 크기는 원본 유지)', async () => {
  const letter = [612, 792];
  const src = await makePdf([letter, [792, 612]]);
  const r = await buildPrintPdf(src, settings({ orientation: 'landscape' }));
  assert.deepEqual(await info(r.bytes), [
    [792, 612],
    [792, 612],
  ]);
});

test('원본에 /Rotate가 있으면 보이는 방향 기준으로 처리', async () => {
  // 세로 용지 + 90° 회전 = 화면에서는 가로
  const src = await makePdf([A4], [90]);
  const r = await buildPrintPdf(src, settings({ copies: 2 }));
  assert.deepEqual(await info(r.bytes), Array(2).fill(round([A4[1], A4[0]])));
  // 이미 가로로 보이므로 가로 지정은 그대로
  const l = await buildPrintPdf(src, settings({ orientation: 'landscape' }));
  assert.deepEqual(await info(l.bytes), [round([A4[1], A4[0]])]);
});

test('PDF가 아니거나 깨진 파일은 안내 메시지와 함께 실패', async () => {
  await assert.rejects(
    buildPrintPdf(new TextEncoder().encode('%PDF-1.7\n깨진 파일'), settings({ copies: 2 })),
    /Can't apply settings/,
  );
});
