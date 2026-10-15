/** JSON API helper. POST when a body is given; throws Error(message) on failure. */
export async function api(path, { body, method, raw, headers } = {}) {
  const init = { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'x-droidpanel': '1', ...headers } };
  if (body !== undefined) {
    if (raw) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(path, init);
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error ?? data ?? res.statusText);
  return data;
}
