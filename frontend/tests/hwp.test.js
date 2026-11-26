import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkHwpSignature, hwpKind } from '../src/hwp.js';
import { makeZip } from './fixtures/office.js';

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

test('hwp 계열 판별: hwp·hwpx만', () => {
  assert.equal(hwpKind('보고서.HWP'), 'hwp');
  assert.equal(hwpKind('방배치도.hwpx'), 'hwpx');
  for (const n of ['a.pdf', 'a.docx', 'a.hwt', 'a.hml', 'hwp', 'a.hwp.exe']) {
    assert.equal(hwpKind(n), null, n);
  }
});

test('hwp 시그니처: HWP 5.0(CFB)·HWP 3.x는 통과, 나머지는 거부', async () => {
  await checkHwpSignature(new Uint8Array([...CFB, 0, 0]), 'hwp');
  await checkHwpSignature(new TextEncoder().encode('HWP Document File V3.00'), 'hwp');
  await assert.rejects(checkHwpSignature(new TextEncoder().encode('%PDF-1.7'), 'hwp'), /Not a valid HWP/);
  await assert.rejects(checkHwpSignature(makeZip({ mimetype: 'application/hwp+zip' }), 'hwp'), /Not a valid HWP/);
});

test('hwpx 시그니처: zip + mimetype application/hwp+zip만 통과', async () => {
  await checkHwpSignature(makeZip({ mimetype: 'application/hwp+zip', 'Contents/section0.xml': '<x/>' }), 'hwpx');
  // docx(zip이지만 mimetype 없음), 다른 mimetype, zip이 아님, 깨진 zip
  await assert.rejects(checkHwpSignature(makeZip({ '[Content_Types].xml': '<x/>' }), 'hwpx'), /Not a valid HWPX/);
  await assert.rejects(
    checkHwpSignature(makeZip({ mimetype: 'application/vnd.oasis.opendocument.text' }), 'hwpx'),
    /Not a valid HWPX/,
  );
  await assert.rejects(checkHwpSignature(new Uint8Array([...CFB]), 'hwpx'), /Not a valid HWPX/);
  await assert.rejects(checkHwpSignature(new Uint8Array([0x50, 0x4b, 1, 2, 3]), 'hwpx'), /Not a valid HWPX/);
});
