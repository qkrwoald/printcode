// 종단간 암호화 (설계 3-3).
//   master    = Argon2id(code + "|" + phrase, salt)
//   enc_key   = HKDF(master, "enc")  → AES-GCM-256
//   auth_token= HKDF(master, "auth") → 서버에는 SHA-256(auth_token)만 저장
// 브라우저와 Node(테스트) 양쪽에서 동작하도록 globalThis.crypto(Web Crypto)만 사용한다.
import { argon2id } from 'hash-wasm';

// Argon2id 기본값. m=64MiB: GPU 대량 대입을 어렵게 하면서 공용 PC에서도 감당 가능한 메모리.
// 파일마다 서버에 함께 저장하므로 나중에 값을 바꿔도 기존 파일은 그대로 열린다.
export const KDF_DEFAULTS = Object.freeze({ m: 64 * 1024, t: 3, p: 1 });
export const PHRASE_MIN_LENGTH = 4;

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

// 라벨에 앱 이름·버전을 넣어, 다른 용도의 키와 절대 겹치지 않게 분리한다 (도메인 분리).
const INFO_ENC = te.encode('printcode/v1/enc');
const INFO_AUTH = te.encode('printcode/v1/auth');

// 같은 글자라도 OS·입력기마다 유니코드 조합 방식이 다를 수 있다 (예: macOS 한글은 자모 분리형).
// NFC로 통일하지 않으면 업로드한 노트북과 공용 PC에서 다른 키가 나와 복호화에 실패한다.
export function normalizePhrase(phrase) {
  return (phrase ?? '').normalize('NFC');
}

/** 확인코드 검증: 비어 있거나(사용 안 함) 4자 이상. 글자 수는 코드포인트 기준. */
export function validatePhrase(phrase) {
  const p = normalizePhrase(phrase);
  return p.length === 0 || [...p].length >= PHRASE_MIN_LENGTH;
}

export function randomSalt() {
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

/** code·phrase·salt에서 암호화 키와 인증 토큰을 유도한다. */
export async function deriveKeys(code, phrase, salt, kdf = KDF_DEFAULTS) {
  if (!/^[0-9]{6}$/.test(code)) throw new Error('invalid code');
  const password = te.encode(`${code}|${normalizePhrase(phrase)}`);
  const masterBytes = await argon2id({
    password,
    salt,
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
  password.fill(0);
  const master = await subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
  masterBytes.fill(0); // JS에서 완전한 메모리 삭제는 보장되지 않지만, 평문 키 사본을 최대한 줄인다.

  // Argon2 출력은 이미 균일한 난수이므로 HKDF salt는 비워도 된다 (HKDF-Expand 용도).
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info });
  // extractable=false: 키를 JS로 꺼낼 수 없게 해, XSS 등이 생겨도 키 자체는 유출되지 않게 한다.
  const encKey = await subtle.deriveKey(hkdf(INFO_ENC), master, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const authToken = new Uint8Array(await subtle.deriveBits(hkdf(INFO_AUTH), master, 256));
  return { encKey, authToken };
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/**
 * PDF와 메타데이터를 하나로 묶어 암호화한다. 서버는 파일명조차 모른다.
 * 평문 구조: [메타 길이 u32][메타 JSON][PDF]
 * 암호문 구조: [버전 1B][IV 12B][AES-GCM 암호문+태그]
 */
export async function encryptPackage(pdfBytes, meta, encKey) {
  const metaBytes = te.encode(JSON.stringify(meta));
  const plain = new Uint8Array(4 + metaBytes.length + pdfBytes.length);
  new DataView(plain.buffer).setUint32(0, metaBytes.length);
  plain.set(metaBytes, 4);
  plain.set(pdfBytes, 4 + metaBytes.length);

  // 파일마다 salt가 달라 키도 매번 새로 만들어지지만, IV는 그래도 무작위로 만든다 (GCM에서 IV 재사용은 치명적).
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = new Uint8Array([FORMAT_VERSION]);
  // 버전 바이트를 AAD로 넣어, 헤더를 바꿔치기하면 복호화가 실패하게 한다.
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, encKey, plain));
  plain.fill(0);

  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out.set(header, 0);
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

/** 복호화. 키가 틀리거나 암호문이 변조되면 GCM 인증 실패로 예외가 난다. */
export async function decryptPackage(blob, encKey) {
  if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== FORMAT_VERSION) throw new Error('unsupported format');
  const header = blob.subarray(0, 1);
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const plain = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, encKey, blob.subarray(1 + IV_BYTES)),
  );
  const view = new DataView(plain.buffer);
  const metaLen = view.getUint32(0);
  if (4 + metaLen > plain.length) throw new Error('corrupt package');
  const meta = JSON.parse(td.decode(plain.subarray(4, 4 + metaLen)));
  const pdfBytes = plain.slice(4 + metaLen);
  plain.fill(0);
  return { meta, pdfBytes };
}

/** 업로드용: 키 유도 + 암호화를 한 번에. */
export async function sealFile({ code, phrase, pdfBytes, meta, kdf = KDF_DEFAULTS }) {
  const salt = randomSalt();
  const { encKey, authToken } = await deriveKeys(code, phrase, salt, kdf);
  const authHash = await sha256(authToken);
  authToken.fill(0); // 업로드 쪽은 auth_token 자체가 필요 없다
  const blob = await encryptPackage(pdfBytes, meta, encKey);
  return { salt, authHash, blob, kdf };
}

// base64url (패딩 없음) — 서버 스키마와 같은 형식
export function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
