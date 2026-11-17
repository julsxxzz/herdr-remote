// REST helper. Every call goes through api(); any 401 (except a wrong PIN) hands control to the sign-in screen.

let onSignedOut = () => {};

export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

export function signedOut() {
  onSignedOut();
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, data: { error: 'offline' } };
  }
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (res.status === 401 && path !== '/api/login') onSignedOut();
  return { ok: res.ok, status: res.status, data };
}

export const terminalPath = (address, action) => `/api/terminals/${encodeURIComponent(address)}/${action}`;
