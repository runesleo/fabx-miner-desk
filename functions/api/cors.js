import { DEWEB_ORIGIN } from '../../api-url.mjs';

export function corsHeaders(request, { methods = 'POST, OPTIONS', headers = 'content-type' } = {}) {
  const origin = request.headers.get('Origin');
  if (!origin || !DEWEB_ORIGIN.test(origin)) return null;
  // navigator.sendBeacon sends with credentials mode "include", so the browser also needs
  // allow-credentials; the API sets and reads no cookies, and the origin is echoed, never "*".
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': methods,
    'access-control-allow-headers': headers,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

export function optionsResponse(request, opts) {
  const cors = corsHeaders(request, opts);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: cors });
}

export function withCors(request, response, opts) {
  const cors = corsHeaders(request, opts);
  if (!cors) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** `hosted` for same-origin Pages; `deweb` when a matching Origin is present on cross-origin API calls. */
export function requestSurface(request) {
  const origin = request.headers.get('Origin');
  if (origin && DEWEB_ORIGIN.test(origin)) return 'deweb';
  return 'hosted';
}
