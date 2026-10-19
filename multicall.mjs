// Minimal ABI for Multicall3 tryAggregate(false, (address,bytes)[]).
// Callers choose read-only targets and keep RPC groups bounded; failed leaves stay null.
const uint = value => BigInt(value).toString(16).padStart(64, '0');

export function encodeTryAggregate(calls) {
  const tuples = calls.map(({ to, data }) => {
    if (!/^0x[0-9a-f]{40}$/i.test(to || '')) throw new Error('invalid Multicall target');
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(data || '')) throw new Error('invalid Multicall calldata');
    const bytes = data.slice(2);
    return uint(BigInt(to)) + uint(64) + uint(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  });
  let offset = calls.length * 32;
  const offsets = tuples.map(tuple => {
    const encoded = uint(offset);
    offset += tuple.length / 2;
    return encoded;
  });
  return '0xbce38bd7' + uint(0) + uint(64) + uint(calls.length) + offsets.join('') + tuples.join('');
}

export function decodeTryAggregate(data, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('invalid Multicall count');
  if (!/^0x(?:[0-9a-f]{64})+$/i.test(data || '')) throw new Error('invalid Multicall response');
  const bytes = (data.length - 2) / 2;
  const at = offset => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 32 || offset + 32 > bytes) throw new Error('invalid Multicall offset');
    return BigInt('0x' + data.slice(2 + offset * 2, 2 + (offset + 32) * 2));
  };
  if (at(0) !== 32n || at(32) !== BigInt(expected) || 64 + expected * 32 > bytes) throw new Error('invalid Multicall count');
  return Array.from({ length: expected }, (_, i) => {
    const relative = Number(at(64 + i * 32));
    if (relative < expected * 32) throw new Error('invalid Multicall tuple');
    const tuple = 64 + relative, success = at(tuple), offset = Number(at(tuple + 32));
    if (success > 1n || offset < 64) throw new Error('invalid Multicall result');
    const start = tuple + offset, length = Number(at(start));
    if (!Number.isSafeInteger(length) || length < 0 || start + 32 + Math.ceil(length / 32) * 32 > bytes) throw new Error('truncated Multicall data');
    return success ? '0x' + data.slice(2 + (start + 32) * 2, 2 + (start + 32 + length) * 2) : null;
  });
}
