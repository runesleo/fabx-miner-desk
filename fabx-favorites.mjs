// Favorites are local to this browser. Only address strings are persisted; chain
// observations stay in memory and are refreshed through the existing wallet reader.
const STORAGE_KEY = 'fabx-miner-desk:favorites:v1';
const MAX_ADDRESSES = 12;
const normalizeAddress = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value.trim())
  ? value.trim().toLowerCase() : null;
const count = value => Number.isSafeInteger(value) && value >= 0;
const nonNegative = value => Number.isFinite(value) && value >= 0;

function addressList(values, limit) {
  if (!Array.isArray(values)) return [];
  const addresses = [];
  for (const value of values) {
    const address = normalizeAddress(value);
    if (address && !addresses.includes(address)) addresses.push(address);
    if (addresses.length >= limit) break;
  }
  return addresses;
}

export function createFavorites(options = {}) {
  const storageKey = options.storageKey ?? STORAGE_KEY;
  const limit = count(options.maxAddresses) && options.maxAddresses > 0
    ? Math.min(options.maxAddresses, MAX_ADDRESSES) : MAX_ADDRESSES;
  let storage = null, addresses = [];
  // Accessing localStorage itself can throw (private or sandboxed browser contexts).
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage; }
  catch { /* Continue as an in-memory list. */ }
  try { addresses = addressList(JSON.parse(storage?.getItem(storageKey) ?? 'null'), limit); }
  catch { /* Corrupt JSON or denied reads do not block the desk. */ }
  const list = () => [...addresses];
  const persist = () => {
    try {
      if (!storage || typeof storage.setItem !== 'function') throw new Error('storage-unavailable');
      storage.setItem(storageKey, JSON.stringify(addresses));
      return { ok: true, saved: true, addresses: list() };
    } catch {
      return { ok: true, saved: false, addresses: list(), error: 'storage-unavailable' };
    }
  };
  return {
    list,
    add(value) {
      const address = normalizeAddress(value);
      if (!address) return { ok: false, saved: false, addresses: list(), error: 'invalid-address' };
      if (!addresses.includes(address)) {
        if (addresses.length >= limit) return { ok: false, saved: false, addresses: list(), error: 'limit' };
        addresses.push(address);
      }
      return persist();
    },
    remove(value) {
      const address = normalizeAddress(value);
      if (!address) return { ok: false, saved: false, addresses: list(), error: 'invalid-address' };
      addresses = addresses.filter(item => item !== address);
      return persist();
    },
  };
}

// A daily subtotal is not a full-wallet forecast. Count only readable production,
// and keep unread classification separate from confirmed chain abnormalities.
export function favoriteSummary(walletRes = {}) {
  const rigs = Array.isArray(walletRes.rigs) ? walletRes.rigs : [];
  const circuits = Math.max(count(walletRes.circuits) ? walletRes.circuits : 0, rigs.length);
  const expected = count(walletRes.discovery?.expected) ? walletRes.discovery.expected : null;
  const discoveryComplete = walletRes.discovery?.complete === true && expected === circuits;
  const known = rigs.filter(rig => nonNegative(rig.fabPerDay));
  let anomalies = 0, classified = 0;
  for (const rig of rigs) {
    if ([0, 2, 3].includes(rig.chainStatus)
      || (rig.chainStatus === 1 && ['unverified', 'mixed'].includes(rig.pool))) {
      anomalies++;
      classified++;
    } else if (rig.chainStatus === 1 && rig.pool === 'verified') classified++;
  }
  return {
    circuits, expected, discoveryComplete, measured: known.length,
    fabPerDay: known.length || (discoveryComplete && circuits === 0)
      ? known.reduce((sum, rig) => sum + rig.fabPerDay, 0) : null,
    productionComplete: discoveryComplete && known.length === circuits,
    anomalies, unknown: circuits - classified,
  };
}

// Sequential startup reads avoid multiplying the wallet reader's RPC concurrency.
// An obsolete refresh must not publish a late success/error after navigation/removal.
export async function refreshFavorites(addresses, { readWallet, signal, onUpdate = () => {} }) {
  const results = [];
  for (const address of addressList(addresses, MAX_ADDRESSES)) {
    if (signal?.aborted) break;
    let update;
    try {
      const wallet = await readWallet(address, { signal });
      update = { address, status: 'ready', summary: favoriteSummary(wallet), wallet };
    } catch (error) {
      update = { address, status: 'error', error: error?.message || '查询失败' };
    }
    if (signal?.aborted) break;
    results.push(update);
    onUpdate(update);
  }
  return results;
}
