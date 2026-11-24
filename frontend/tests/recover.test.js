// 서버 관리자 입장에서: 서버가 가진 값만으로 파일을 복원할 수 있는가?
// 서버가 갖는 것 = 코드(DB 기본 키), salt, KDF 파라미터, SHA-256(auth_token), 확인코드 사용 여부, 암호문.
// (확인코드·auth_token·키는 서버로 가지 않는다)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decryptPackage, deriveKeys, sealFile, sha256 } from '../src/crypto.js';

const CODE = '482913';
const PHRASE = '프린터실-가을학기#7';
const pdf = new TextEncoder().encode('%PDF-1.7\n비밀 과제 내용 SECRET-CONTENT\n%%EOF');
const meta = { name: '기말보고서_홍길동.pdf', size: pdf.length };

/** 업로드 후 서버 DB·저장 폴더에 남는 것만 모은다 */
async function serverView(phrase) {
  const sealed = await sealFile({ code: CODE, phrase, pdfBytes: pdf.slice(), meta });
  return {
    code: CODE,
    salt: sealed.salt,
    kdf: sealed.kdf,
    authHash: sealed.authHash,
    hasPhrase: phrase.length > 0,
    blob: sealed.blob,
  };
}

/** 관리자가 확인코드 후보로 복원을 시도한다 (인증 해시로 먼저 맞는지 확인) */
async function tryRecover(view, phrase) {
  const { encKey, authToken } = await deriveKeys(view.code, phrase, view.salt, view.kdf);
  const match = Buffer.from(await sha256(authToken)).equals(Buffer.from(view.authHash));
  if (!match) return null;
  return decryptPackage(view.blob, encKey);
}

test('서버 저장물에는 파일 내용·파일명이 평문으로 없다', async () => {
  const view = await serverView(PHRASE);
  const stored = Buffer.concat([
    Buffer.from(view.salt),
    Buffer.from(view.authHash),
    Buffer.from(view.blob),
  ]);
  for (const plain of ['SECRET-CONTENT', '%PDF', '기말보고서', '홍길동', PHRASE]) {
    assert.equal(stored.includes(Buffer.from(plain)), false, plain);
  }
});

test('확인코드가 있으면: 서버 값과 흔한 후보만으로는 복원할 수 없다', async () => {
  const view = await serverView(PHRASE);
  const guesses = ['', '1234', 'password', '프린터실', CODE, 'qwerty', '0000', '프린터실-가을학기'];
  for (const g of guesses) {
    assert.equal(await tryRecover(view, g), null, g);
  }
  // 대조: 진짜 확인코드라면 복원된다 (위 실패가 구현 오류가 아님을 보여줌)
  assert.ok(await tryRecover(view, PHRASE));
});

test('확인코드가 없으면: 서버 관리자는 복원할 수 있다 (SECURITY.md에 밝힌 한계)', async () => {
  // 코드는 DB 기본 키라 서버가 이미 안다. 확인코드가 없으면 키 재료가 모두 서버에 있다.
  const view = await serverView('');
  const out = await tryRecover(view, '');
  assert.ok(out);
  assert.equal(new TextDecoder().decode(out.pdfBytes).includes('SECRET-CONTENT'), true);
  assert.equal(out.meta.name, meta.name);
});
