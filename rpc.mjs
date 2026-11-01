// Public, read-only JSON-RPC transport. State reads may fail over; log scans stay on Sentio.
export const RPC_ENDPOINTS = [
  'https://xlayerrpc.okx.com',
  'https://rpc.xlayer.tech',
];
export const LOG_RPC_ENDPOINT = 'https://xlayer-mainnet.rpc.sentio.xyz';

const READ_METHODS = new Set(['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs']);
const MAX_LOG_BACKOFF_MS = 5 * 60_000;
const DEFAULT_BATCH_CAP = 5;

function rpcError(message, details = {}) {
  return Object.assign(new Error(message), { retryable: false, rateLimited: false, rangeLimited: false, batchLimited: false }, details);
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message || 'RPC request aborted');
  error.name = 'AbortError';
  return error;
}

function assertReadOnly(method) {
  if (!READ_METHODS.has(method)) throw rpcError(`RPC method is not read-only or supported: ${method}`);
}

function fromRpcError(error, endpoint, { rotateOnStateUnavailable = true } = {}) {
  const message = error?.message || 'unknown JSON-RPC error';
  const code = error?.code;
  const rateLimited = /rate[ -]?limit|too many requests|request[s]? limit|quota exceeded|\b429\b/i.test(message);
  const batchLimited = !rateLimited && /json-?rpc batch exceeds|batch exceeds|maximum of \d+ requests/i.test(message);
  const rangeLimited = !rateLimited && !batchLimited && /block[ -]?range|range.{0,40}(?:large|limit|exceed)|(?:more than|maximum|max|limit).{0,25}\bblocks\b|too many (?:results|logs)|query returned more than|response (?:size|too large)|log response size exceeded/i.test(message);
  const executionReverted = code === 3 || /execution reverted/i.test(message);
  const timedOut = /timeout|timed out|deadline exceeded/i.test(message);
  const endpointGap = !executionReverted && !rangeLimited && (
    code === -32601
    || /not supported/i.test(message)
    || /method not found/i.test(message)
  );
  const stateUnavailable = rotateOnStateUnavailable && !executionReverted && !rangeLimited
    && /missing trie node|state is not available|historical state|header not found|unknown block|archive node/i.test(message);
  const retryable = rateLimited || batchLimited || timedOut || endpointGap || stateUnavailable;
  return rpcError(`RPC: ${message}`, {
    endpoint, code, rateLimited, rangeLimited, batchLimited, retryable,
  });
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
  maxBackoffMs = 8_000,
  endpointCooldownMs = 15_000,
  logBackoffMs = 30_000,
  maxConcurrent = 3,
  rotateOnStateUnavailable = true,
  now = Date.now,
} = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('At least one RPC endpoint is required');
  if (typeof logEndpoint !== 'string' || !logEndpoint) throw new Error('A log RPC endpoint is required');
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('RPC timeout must be positive');
  if (!(Number.isInteger(maxConcurrent) && maxConcurrent > 0)) throw new Error('RPC concurrency must be a positive integer');
  if (!(Number.isFinite(endpointCooldownMs) && endpointCooldownMs >= 0)) throw new Error('RPC endpoint cooldown must be non-negative');
  const urls = [...endpoints];
  const stateCooldowns = urls.map(() => ({ retryAt: 0, error: null }));
  const batchCaps = new Map(urls.map((url) => [url, DEFAULT_BATCH_CAP]));
  let active = 0, nextId = 1, logsRetryAt = 0, lastLogError;
  let inFlight = 0;
  const waiters = [];

  function releaseSlot() {
    inFlight = Math.max(0, inFlight - 1);
    const next = waiters.shift();
    if (next) next();
  }
  async function acquireSlot(signal) {
    if (signal?.aborted) throw abortError(signal);
    if (inFlight < maxConcurrent) { inFlight++; return; }
    await new Promise((resolve, reject) => {
      const grant = () => { signal?.removeEventListener('abort', onAbort); inFlight++; resolve(); };
      const onAbort = () => { const i = waiters.indexOf(grant); if (i >= 0) waiters.splice(i, 1); reject(abortError(signal)); };
      waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function retryAfterMs(response) {
    const value = response.headers?.get?.('retry-after');
    if (!value) return 0;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
    return Number.isFinite(ms) ? Math.min(MAX_LOG_BACKOFF_MS, Math.max(0, ms)) : 0;
  }

  async function errorDiagnostic(response, controller) {
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
      timer = setTimeout(() => { controller.abort(); resolve(''); }, Math.min(200, timeoutMs / 4));
    });
    try { return await Promise.race([body, deadline]); }
    finally { clearTimeout(timer); }
  }

  function noteBatchLimit(endpoint, diagnostic, attemptedSize) {
    if (!endpoint || !/batch exceeds|maximum of \d+ requests/i.test(diagnostic || '')) return;
    const match = /maximum of (\d+)/i.exec(diagnostic);
    const cap = match ? Math.max(1, Number(match[1])) : Math.max(1, attemptedSize - 1);
    batchCaps.set(endpoint, Math.min(batchCaps.get(endpoint) ?? DEFAULT_BATCH_CAP, cap));
  }

  async function post(endpoint, body, signal) {
    if (signal?.aborted) throw abortError(signal);
    await acquireSlot(signal);
    const controller = new AbortController();
    let timer, onAbort;
    try {
      if (signal?.aborted) throw abortError(signal);
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
          const attemptedSize = Array.isArray(body) ? body.length : 1;
          noteBatchLimit(endpoint, diagnostic, attemptedSize);
          const retryableHttp = response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500;
          throw rpcError(`RPC HTTP ${response.status} (${endpoint})${diagnostic ? `: ${diagnostic}` : ''}`, {
            endpoint, status: response.status, rateLimited: response.status === 429,
            batchLimited: /batch exceeds|maximum of \d+ requests/i.test(diagnostic),
            retryable: retryableHttp,
            retryAfterMs: retryAfterMs(response),
          });
        }
        const data = await response.json();
        if (!data || typeof data !== 'object') throw rpcError('RPC returned an invalid JSON response', { endpoint, retryable: true });
        if (!Array.isArray(data) && data.error) {
          if (typeof data.error.message !== 'string') throw rpcError('RPC returned an invalid JSON-RPC error', { endpoint, retryable: true });
          throw fromRpcError(data.error, endpoint, { rotateOnStateUnavailable });
        }
        if (Array.isArray(data)) {
          const retryable = data.filter((row) => row?.error)
            .map((row) => fromRpcError(row.error, endpoint, { rotateOnStateUnavailable }))
            .find((error) => error.retryable);
          if (retryable) throw retryable;
        }
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
      return await Promise.race([request, interrupted]);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error && typeof error === 'object' && 'retryable' in error) throw error;
      throw rpcError(`RPC network/response error: ${error?.message || String(error)} (${endpoint})`, { endpoint, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      releaseSlot();
    }
  }

  const availableStateIndex = (attempted) => {
    for (let offset = 0; offset < urls.length; offset++) {
      const index = (active + offset) % urls.length;
      if (!attempted.has(index) && stateCooldowns[index].retryAt <= now()) return index;
    }
    return -1;
  };

  async function runStateWork(worker, signal) {
    const attempted = new Set();
    let lastError;
    let backoffStep = 0;
    while (attempted.size < urls.length) {
      if (signal?.aborted) throw abortError(signal);
      const index = availableStateIndex(attempted);
      if (index < 0) break;
      attempted.add(index);
      try {
        const result = await worker(index, (body) => post(urls[index], body, signal));
        active = index;
        return result;
      } catch (error) {
        if (!error.retryable || signal?.aborted) throw error;
        stateCooldowns[index] = { retryAt: now() + Math.max(endpointCooldownMs, error.retryAfterMs || 0), error };
        lastError = error;
        if (active === index) active = (index + 1) % urls.length;
        if (availableStateIndex(attempted) >= 0) {
          const wait = Math.min(maxBackoffMs, backoffMs * 2 ** backoffStep);
          backoffStep++;
          await delay(wait, signal);
        }
      }
    }
    const next = stateCooldowns.reduce((first, entry) => entry.retryAt < first.retryAt ? entry : first);
    const retryAfterMs = Math.max(0, next.retryAt - now());
    if (lastError) {
      // Let a caller's bounded retry wait until a state endpoint can be tried again.
      lastError.retryAfterMs = Math.max(lastError.retryAfterMs || 0, retryAfterMs);
      throw lastError;
    }
    throw rpcError(`State RPC temporarily unavailable; retry in ${Math.ceil(retryAfterMs / 1000)}s: ${next.error.message}`, {
      endpoint: next.error.endpoint, retryable: true, rateLimited: next.error.rateLimited,
      status: next.error.status, code: next.error.code, retryAfterMs, cause: next.error,
    });
  }

  async function stateRequest(body, signal) {
    return runStateWork(async (_index, request) => request(body), signal);
  }

  async function batchWithRequest(calls, size, request, signal, endpointIndex) {
    const endpoint = urls[endpointIndex];
    const cap = batchCaps.get(endpoint) ?? DEFAULT_BATCH_CAP;
    const chunk = Math.max(1, Math.min(size, cap));
    const out = [];
    for (let i = 0; i < calls.length;) {
      if (calls[i][0] === 'eth_getLogs') {
        throw rpcError('batchWithRequest cannot route eth_getLogs', { retryable: false });
      }
      const part = [];
      while (i < calls.length && part.length < chunk && calls[i][0] !== 'eth_getLogs') {
        const [method, params] = calls[i++];
        part.push({ jsonrpc: '2.0', id: nextId++, method, params });
      }
      let response;
      try {
        response = await request(part.length === 1 ? part[0] : part);
      } catch (error) {
        if (error.batchLimited && chunk > 1) {
          batchCaps.set(endpoint, Math.max(1, chunk - 1));
          return batchWithRequest(calls.slice(out.length), size, request, signal, endpointIndex);
        }
        throw error;
      }
      const byId = new Map((Array.isArray(response) ? response : [response]).map((row) => [row.id, row.error ? null : row.result]));
      part.forEach((req) => out.push(byId.get(req.id) ?? null));
    }
    return out;
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
    if (signal?.aborted) throw abortError(signal);
    assertReadOnly(method);
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    const response = await (method === 'eth_getLogs' ? logsRequest(body, signal) : stateRequest(body, signal));
    if (response.error) throw fromRpcError(response.error, undefined, { rotateOnStateUnavailable });
    if (response.result === undefined || response.result === null) throw rpcError(`${method}: empty result`);
    return response.result;
  }

  async function batch(calls, size = 5, { signal, coherent = false } = {}) {
    if (!Number.isInteger(size) || size < 1) throw new Error('RPC batch size must be a positive integer');
    calls.forEach(([method]) => assertReadOnly(method));
    const deliver = async (index, request) => batchWithRequest(calls, size, request, signal, index);
    if (coherent) return runStateWork(async (index, request) => deliver(index, request), signal);
    const out = [];
    for (let i = 0; i < calls.length;) {
      if (calls[i][0] === 'eth_getLogs') {
        try { out.push(await rpc(calls[i][0], calls[i][1], { signal })); }
        catch (error) { if (error.retryable || error.name === 'AbortError') throw error; out.push(null); }
        i++;
        continue;
      }
      const part = [];
      while (i < calls.length && part.length < size && calls[i][0] !== 'eth_getLogs') {
        part.push(calls[i++]);
      }
      const partBodies = part.map(([method, params]) => ({ jsonrpc: '2.0', id: nextId++, method, params }));
      const response = await stateRequest(partBodies, signal);
      const byId = new Map((Array.isArray(response) ? response : [response]).map((row) => [row.id, row.error ? null : row.result]));
      partBodies.forEach((request) => out.push(byId.get(request.id) ?? null));
    }
    return out;
  }

  return { rpc, batch, runStateWork };
}
