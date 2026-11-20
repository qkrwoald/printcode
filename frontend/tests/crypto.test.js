import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  b64uDecode,
  b64uEncode,
  decryptPackage,
  deriveKeys,
  KDF_DEFAULTS,
  sealFile,
  sha256,
} from '../src/crypto.js';

const CODE = '123456';
const pdf = new TextEncoder().encode('%PDF-1.7\n가짜 PDF 내용\n%%EOF');
const meta = { name: '<script>alert(1)</script>.pdf', size: pdf.length };

// 공용 PC 쪽 흐름을 흉내: salt로 키 유도 → auth_token 해시 비교 → 복호화
async function open(sealed, code, phrase) {
  const { encKey, authToken } = await deriveKeys(code, phrase, sealed.salt, sealed.kdf);
  const authOk = Buffer.from(await sha256(authToken)).equals(Buffer.from(sealed.authHash));
  return { authOk, encKey };
}

test('확인코드 포함 왕복', async () => {
  const sealed = await sealFile({ code: CODE, phrase: '프린터실#2026', pdfBytes: pdf.slice(), meta });
  const { authOk, encKey } = await open(sealed, CODE, '프린터실#2026');
  assert.ok(authOk);
  const out = await decryptPackage(sealed.blob, encKey);
  assert.deepEqual(out.pdfBytes, pdf);
  assert.deepEqual(out.meta, meta);
});

test('확인코드 없음 왕복', async () => {
  const sealed = await sealFile({ code: CODE, phrase: '', pdfBytes: pdf.slice(), meta });
  const { authOk, encKey } = await open(sealed, CODE, '');
  assert.ok(authOk);
  assert.deepEqual((await decryptPackage(sealed.blob, encKey)).pdfBytes, pdf);
});

test('잘못된 확인코드·코드는 인증과 복호화 모두 실패', async () => {
  const sealed = await sealFile({ code: CODE, phrase: 'correct horse', pdfBytes: pdf.slice(), meta });
  for (const [code, phrase] of [
    [CODE, 'wrong horse'],
    [CODE, ''],
    ['654321', 'correct horse'],
  ]) {
    const { authOk, encKey } = await open(sealed, code, phrase);
    assert.equal(authOk, false);
    await assert.rejects(decryptPackage(sealed.blob, encKey));
  }
});

test('한글 NFC/NFD 입력은 같은 키를 만든다', async () => {
  const nfc = '한글확인'.normalize('NFC');
  const nfd = '한글확인'.normalize('NFD');
  assert.notEqual(nfc, nfd);
  const sealed = await sealFile({ code: CODE, phrase: nfd, pdfBytes: pdf.slice(), meta });
  const { authOk } = await open(sealed, CODE, nfc);
  assert.ok(authOk);
});

test('변조된 암호문은 거부', async () => {
  const sealed = await sealFile({ code: CODE, phrase: 'abcd', pdfBytes: pdf.slice(), meta });
  const { encKey } = await open(sealed, CODE, 'abcd');
  const tampered = sealed.blob.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(decryptPackage(tampered, encKey));
});

test('암호문·salt·해시에 평문(파일명·내용)이 드러나지 않음', async () => {
  const sealed = await sealFile({ code: CODE, phrase: '', pdfBytes: pdf.slice(), meta });
  const hay = Buffer.concat([Buffer.from(sealed.blob), Buffer.from(sealed.salt), Buffer.from(sealed.authHash)]);
  assert.equal(hay.includes(Buffer.from('%PDF')), false);
  assert.equal(hay.includes(Buffer.from('script')), false);
});

test('같은 파일도 매번 다른 salt·암호문', async () => {
  const a = await sealFile({ code: CODE, phrase: '', pdfBytes: pdf.slice(), meta });
  const b = await sealFile({ code: CODE, phrase: '', pdfBytes: pdf.slice(), meta });
  assert.notDeepEqual(a.salt, b.salt);
  assert.notDeepEqual(a.blob, b.blob);
});

test('한 글자 확인코드도 사용 가능', async () => {
  const sealed = await sealFile({ code: CODE, phrase: '가', pdfBytes: pdf.slice(), meta });
  assert.ok((await open(sealed, CODE, '가')).authOk);
  assert.equal((await open(sealed, CODE, '')).authOk, false);
});

test('base64url 왕복', () => {
  const bytes = new Uint8Array([0, 255, 62, 63, 250, 1]);
  assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes);
  assert.match(b64uEncode(new Uint8Array(32)), /^[A-Za-z0-9_-]{43}$/);
});

test('Argon2id 기본 파라미터 소요 시간 (참고용)', async () => {
  const t0 = performance.now();
  await deriveKeys(CODE, 'abcd', new Uint8Array(16), KDF_DEFAULTS);
  console.log(`  Argon2id m=${KDF_DEFAULTS.m}KiB t=${KDF_DEFAULTS.t}: ${Math.round(performance.now() - t0)}ms`);
});
