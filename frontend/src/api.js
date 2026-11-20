// 서버 API 호출. 코드는 URL에 넣지 않고 항상 POST 본문으로 보낸다.
export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

async function request(path, options) {
  let res;
  try {
    // credentials: 'omit' — 이 서비스는 쿠키를 쓰지 않는다.
    res = await fetch(path, { ...options, credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다.');
  }
  if (res.ok) return res;
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* 본문 없음 */
  }
  const message = typeof body.detail === 'string' ? body.detail : '요청을 처리하지 못했습니다.';
  throw new ApiError(res.status, message, { remaining: body.remaining });
}

function postJson(path, data) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getConfig() {
  return (await request('/api/config', { method: 'GET' })).json();
}

export async function reserveCode() {
  return (await request('/api/codes', { method: 'POST' })).json();
}

export async function uploadBlob(fields, blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('blob', new Blob([blob], { type: 'application/octet-stream' }), 'blob');
  return (await request('/api/uploads', { method: 'POST', body: form })).json();
}

export async function lookup(code) {
  return (await postJson('/api/lookup', { code })).json();
}

export async function fetchBlob(code, authTokenB64u) {
  const res = await postJson('/api/fetch', { code, auth_token: authTokenB64u });
  return new Uint8Array(await res.arrayBuffer());
}
