// Public, read-only JSON-RPC transport. State reads may fail over; log scans stay on Sentio.
export const RPC_ENDPOINTS = [
  'https://xlayerrpc.okx.com',
  'https://rpc.xlayer.tech',
];
export const LOG_RPC_ENDPOINT = 'https://xlayer-mainnet.rpc.sentio.xyz';

const READ_METHODS = new Set(['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs']);
const MAX_LOG_BACKOFF_MS = 5 * 60_000;

function rpcError(message, details = {}) {
  return Object.assign(new Error(message), { retryable: false, rateLimited: false, rangeLimited: false }, details);
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message || 'RPC request aborted');
  error.name = 'AbortError';
  return error;
}

function assertReadOnly(method) {
  if (!READ_METHODS.has(method)) throw rpcError(`RPC method is not read-only or supported: ${method}`);
}

function fromRpcError(error, endpoint) {
  const message = error?.message || 'unknown JSON-RPC error';
  const rateLimited = /rate[ -]?limit|too many requests|request[s]? limit|quota exceeded|\b429\b/i.test(message);
  const rangeLimited = !rateLimited && /block[ -]?range|range.{0,40}(?:large|limit|exceed)|(?:more than|maximum|max|limit).{0,25}\bblocks\b|too many (?:results|logs)|query returned more than|response (?:size|too large)|log response size exceeded/i.test(message);
  return rpcError(`RPC: ${message}`, { endpoint, code: error?.code, rateLimited, rangeLimited, retryable: rateLimited });
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createRpcClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = RPC_ENDPOINTS,
  logEndpoint = LOG_RPC_ENDPOINT,
  timeoutMs = 3500,
  backoffMs = 150,
  endpointCooldownMs = 15_000,
  logBackoffMs = 30_000,
  now = Date.now,
} = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('At least one RPC endpoint is required');
  if (typeof logEndpoint !== 'string' || !logEndpoint) throw new Error('A log RPC endpoint is required');
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('RPC timeout must be positive');
  if (!(Number.isFinite(endpointCooldownMs) && endpointCooldownMs >= 0)) throw new Error('RPC endpoint cooldown must be non-negative');
  const urls = [...endpoints];
  const stateCooldowns = urls.map(() => ({ retryAt: 0, error: null }));
  let active = 0, nextId = 1, logsRetryAt = 0, lastLogError;

  function retryAfterMs(response) {
    const value = response.headers?.get?.('retry-after');
    if (!value) return 0;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
    return Number.isFinite(ms) ? Math.min(MAX_LOG_BACKOFF_MS, Math.max(0, ms)) : 0;
  }

  async function errorDiagnostic(response, controller) {
    // Error bodies are optional diagnostics: do not let a slow body hide a known HTTP status.
    let timer;
    const body = Promise.resolve().then(async () => {
      let data;
      if (typeof response.text === 'function') {
        const text = String(await response.text()).slice(0, 2048);
        try { data = JSON.parse(text); } catch { return text.slice(0, 500); }
      } else if (typeof response.json === 'function') data = await response.json();
      const message = data?.error?.message ?? data?.message ?? (typeof data === 'string' ? data : '');
      return String(message).slice(0, 500);
    }).catch(() => '');
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('');
      }, Math.min(200, timeoutMs / 4));
    });
    try { return await Promise.race([body, deadline]); }
    finally { clearTimeout(timer); }
  }

  async function post(endpoint, body, signal) {
    if (signal?.aborted) throw abortError(signal);
    const controller = new AbortController();
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(abortError(signal)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(rpcError(`RPC timeout after ${timeoutMs}ms (${endpoint})`, { endpoint, retryable: true }));
      }, timeoutMs);
    });
    const request = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw abortError(signal);
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        const diagnostic = await errorDiagnostic(response, controller);
        throw rpcError(`RPC HTTP ${response.status} (${endpoint})${diagnostic ? `: ${diagnostic}` : ''}`, {
          endpoint, status: response.status, rateLimited: response.status === 429,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: retryAfterMs(response),
        });
      }
      const data = await response.json();
      if (!data || typeof data !== 'object') throw rpcError('RPC returned an invalid JSON response', { endpoint, retryable: true });
      if (!Array.isArray(data) && data.error) {
        if (typeof data.error.message !== 'string') throw rpcError('RPC returned an invalid JSON-RPC error', { endpoint, retryable: true });
        throw fromRpcError(data.error, endpoint);
      }
      // Public endpoints sometimes return a rate-limit error per batch member with HTTP 200.
      if (Array.isArray(data)) {
        const retryable = data.filter((row) => row?.error).map((row) => fromRpcError(row.error, endpoint)).find((error) => error.retryable);
        if (retryable) throw retryable;
      }
      // A proxy's JSON error page or an incomplete batch is a transport failure, not missing chain data.
      const requests = Array.isArray(body) ? body : [body];
      const rows = Array.isArray(data) ? data : [data];
      const ids = new Set(requests.map((request) => request.id));
      const invalid = Array.isArray(body) !== Array.isArray(data) || rows.length !== requests.length || rows.some((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !ids.delete(row.id)) return true;
        const hasResult = Object.hasOwn(row, 'result'), hasError = Object.hasOwn(row, 'error');
        return hasResult === hasError || (hasError && (!row.error || typeof row.error.message !== 'string'));
      });
      if (invalid) throw rpcError('RPC returned an invalid JSON-RPC response', { endpoint, retryable: true });
      return data;
    });
    try {
      return await Promise.race([request, interrupted]);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error && typeof error === 'object' && 'retryable' in error) throw error;
      throw rpcError(`RPC network/response error: ${error?.message || String(error)} (${endpoint})`, { endpoint, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function stateRequest(body, signal) {
    const attempted = new Set();
    let lastError;
    const available = () => {
      for (let offset = 0; offset < urls.length; offset++) {
        const index = (active + offset) % urls.length;
        if (!attempted.has(index) && stateCooldowns[index].retryAt <= now()) return index;
      }
      return -1;
    };
    while (attempted.size < urls.length) {
      if (signal?.aborted) throw abortError(signal);
      // Re-read shared health after every await: other concurrent reads may have cooled a fallback.
      const index = available();
      if (index < 0) break;
      attempted.add(index);
      try {
        // Success never clears a newer failure or undoes another request's rotation.
        return await post(urls[index], body, signal);
      } catch (error) {
        if (!error.retryable || signal?.aborted) throw error;
        stateCooldowns[index] = { retryAt: now() + Math.max(endpointCooldownMs, error.retryAfterMs || 0), error };
        lastError = error;
        if (active === index) active = (index + 1) % urls.length;
        if (available() >= 0) await delay(backoffMs * attempted.size, signal);
      }
    }
    if (lastError) throw lastError;
    const next = stateCooldowns.reduce((first, entry) => entry.retryAt < first.retryAt ? entry : first);
    const retryAfterMs = Math.max(0, next.retryAt - now());
    throw rpcError(`State RPC temporarily unavailable; retry in ${Math.ceil(retryAfterMs / 1000)}s: ${next.error.message}`, {
      endpoint: next.error.endpoint, retryable: true, rateLimited: next.error.rateLimited,
      status: next.error.status, code: next.error.code, retryAfterMs, cause: next.error,
    });
  }

  async function logsRequest(body, signal) {
    if (signal?.aborted) throw abortError(signal);
    if (now() < logsRetryAt) {
      throw rpcError(`eth_getLogs temporarily unavailable; retry in ${Math.ceil((logsRetryAt - now()) / 1000)}s: ${lastLogError.message}`, {
        endpoint: logEndpoint, retryable: true, rateLimited: lastLogError.rateLimited,
        status: lastLogError.status, code: lastLogError.code, retryAfterMs: logsRetryAt - now(),
      });
    }
    try {
      return await post(logEndpoint, body, signal);
    } catch (error) {
      if (error.retryable) {
        error.retryAfterMs = Math.min(MAX_LOG_BACKOFF_MS, Math.max(logBackoffMs, error.retryAfterMs || 0));
        logsRetryAt = now() + error.retryAfterMs;
        lastLogError = error;
      }
      throw error;
    }
  }

  async function rpc(method, params, { signal } = {}) {
    assertReadOnly(method);
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    const response = await (method === 'eth_getLogs' ? logsRequest(body, signal) : stateRequest(body, signal));
    if (response.error) throw fromRpcError(response.error);
    if (response.result === undefined || response.result === null) throw rpcError(`${method}: empty result`);
    return response.result;
  }

  // Keep public-provider batches small; logs are always issued separately.
  async function batch(calls, size = 5, { signal } = {}) {
    if (!Number.isInteger(size) || size < 1) throw new Error('RPC batch size must be a positive integer');
    calls.forEach(([method]) => assertReadOnly(method));
    const out = [];
    for (let i = 0; i < calls.length;) {
      if (calls[i][0] === 'eth_getLogs') {
        // Never place a log request in a state batch that could be sent to a fallback endpoint.
        try { out.push(await rpc(calls[i][0], calls[i][1], { signal })); }
        catch (error) { if (error.retryable || error.name === 'AbortError') throw error; out.push(null); }
        i++;
        continue;
      }
      const part = [];
      while (i < calls.length && part.length < size && calls[i][0] !== 'eth_getLogs') {
        const [method, params] = calls[i++];
        part.push({ jsonrpc: '2.0', id: nextId++, method, params });
      }
      const response = await stateRequest(part, signal);
      const byId = new Map((Array.isArray(response) ? response : [response]).map((row) => [row.id, row.error ? null : row.result]));
      part.forEach((request) => out.push(byId.get(request.id) ?? null));
    }
    return out;
  }

  return { rpc, batch };
}
