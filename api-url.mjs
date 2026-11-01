// API base for static copies (DeWeb) vs hosted Pages / local dev.
export const HOSTED_API_ORIGIN = 'https://fabx-miner-desk.pages.dev';
export const DEWEB_ORIGIN = /^https:\/\/r1-[0-9a-f]{40}-deweb\.fabx\.tech$/;

const PAGES_HOST = /^(?:[a-z0-9-]+\.)?fabx-miner-desk\.pages\.dev$/i;
const SITE_HOST = /^fabx\.leolabs\.me$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/i;

/** @param {string} [hostname] */
export function isHostedApiOrigin(hostname) {
  return PAGES_HOST.test(hostname || '') || SITE_HOST.test(hostname || '') || LOCAL_HOST.test(hostname || '');
}

/** @param {string} path e.g. `/api/hit` */
export function apiUrl(path, loc = globalThis.location) {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!loc?.hostname) return p;
  return isHostedApiOrigin(loc.hostname) ? p : `${HOSTED_API_ORIGIN}${p}`;
}

export function isDewebOrigin(origin) {
  return typeof origin === 'string' && DEWEB_ORIGIN.test(origin);
}
