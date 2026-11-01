// Normalize static paths under DeWeb version prefixes (/v/<n>/…).

/** @param {string} [pathname] */
export function stripVersionPrefix(pathname) {
  const raw = pathname || '/';
  const m = /^\/v\/\d+(\/.*)?$/.exec(raw);
  return m ? (m[1] || '/') : raw;
}

/** Map mirror or hosted pathname to whitelisted hit/feedback page: `/` or `/rigs`, or null. */
export function normalizeSitePath(pathOrPathname) {
  if (typeof pathOrPathname !== 'string') return null;
  let p = pathOrPathname.split('?')[0].split('#')[0];
  p = stripVersionPrefix(p);
  if (p === '' || p === '/' || p === '/index.html') return '/';
  if (p === '/rigs' || p === '/rigs/' || p === '/rigs/index.html') return '/rigs';
  return null;
}

/** @param {string} [pathname] */
export function isDeskEntryPath(pathname) {
  const p = normalizeSitePath(pathname);
  return p === '/' || p === '/rigs';
}
