// FabX-only explanations from mechanism-ssot verified sections 2.4, 4.1, Z1/Z2/Z7, 6.1.
// No inferred gas formula, guessed processor whitelist or default cooldown constant.
const uint = value => {
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    if (!['number', 'string', 'bigint'].includes(typeof value) || value === '') return null;
    const n = BigInt(value);
    return n >= 0n && n < 2n ** 256n - 1n ? n : null;
  } catch { return null; }
};

export function rigPool(miner) {
  if (!miner) return null;
  const verified = miner.taskId > 0n && miner.verifWeight > 0n;
  const unverified = miner.unverWeight > 0n;
  return verified && unverified ? 'mixed' : verified ? 'verified' : unverified ? 'unverified' : null;
}

export function diagnoseRig(miner, { head, cooldownBlocks, processorMultiplier } = {}) {
  const diagnoses = [];
  const add = (code, evidence = {}) => diagnoses.push({ code, evidence });
  if (!miner) { add('state_unknown'); return diagnoses; }
  const status = miner.chainStatus, pool = rigPool(miner);
  const abnormal = status !== 1 || pool !== 'verified';
  const multiplier = uint(processorMultiplier);
  if (multiplier === 0n) add('processor_disabled', { processorMultiplier: '0', chainStatus: status });
  else if (multiplier == null && abnormal) add('processor_unknown');

  if (status === 0) add('not_started', { chainStatus: status });
  else if (status === 2) add('revoked', { chainStatus: status });
  else if (status === 3) {
    add('stopped', { chainStatus: status, stopBlock: miner.stopBlock?.toString() ?? null });
    const stop = uint(miner.stopBlock), current = uint(head), cooldown = uint(cooldownBlocks);
    if (stop == null || stop === 0n || current == null || current < stop || cooldown == null) add('cooldown_unknown');
    else {
      const remaining = stop + cooldown > current ? stop + cooldown - current : 0n;
      add(remaining > 0n ? 'cooldown_remaining' : 'cooldown_complete', {
        stopBlock: stop.toString(), head: current.toString(), cooldownBlocks: cooldown.toString(), remainingBlocks: remaining.toString(),
      });
    }
  } else if (status !== 1) add('state_unknown', { chainStatus: status });

  if (status === 1 && pool !== 'verified') {
    if (miner.taskId === 0n && miner.unverWeight > 0n && miner.verifWeight === 0n) {
      add('unclaimed_task', { taskId: '0', unverWeight: miner.unverWeight.toString() });
    } else if (pool === 'mixed' || pool === 'unverified') {
      add('unverified_pool', { taskId: miner.taskId?.toString() ?? null, unverWeight: miner.unverWeight.toString() });
    } else add('pool_unknown');
  }
  if (status === 0 || (status === 1 && pool !== 'verified')) {
    // Official ABI: runGasFor(uint32,uint32), sampleCountFor(uint32,uint32).
    // They require total/live gate counts and candidate task cycles respectively.
    // getMiner has no live gate count; taskId=0 supplies no candidate task cycles.
    add('gas_gate_unknown');
  }
  return diagnoses;
}

export function diagnosisText(item, lang = 'zh') {
  const en = lang === 'en', remaining = item?.evidence?.remainingBlocks ?? '—';
  const text = {
    state_unknown: ['挖矿状态无法判断：链上状态未读到或不受支持。', 'Mining state unknown: chain status is unavailable or unsupported.'],
    processor_unknown: ['处理器资格无法判断：未读到当前 P。', 'Processor eligibility unknown: current P is unavailable.'],
    processor_disabled: ['当前处理器 P=0，不能新开挖；对已在挖矿机产出的影响无法判断。', 'Current processor P=0 prevents starting; its effect on existing mining output is unknown.'],
    not_started: ['链上状态为未开挖（status=0）。', 'Chain status is not started (status=0).'],
    revoked: ['已被撤销，永久不能重新开挖（status=2）。', 'Revoked: mining cannot be restarted (status=2).'],
    stopped: ['已停挖（status=3），冷静期结束也不会自动重开。', 'Stopped (status=3); mining does not restart automatically after cooldown.'],
    cooldown_remaining: [`停挖冷静期还剩 ${remaining} 个区块。`, `Stop cooldown: ${remaining} blocks remaining.`],
    cooldown_complete: ['冷静期已结束，可由持有人重新开挖。', 'Cooldown has ended; the holder can restart mining.'],
    cooldown_unknown: ['冷静期剩余区块无法判断：stopBlock、当前区块或 STOP_COOLDOWN 不完整。', 'Cooldown remaining is unknown: stopBlock, current block or STOP_COOLDOWN is unavailable.'],
    unclaimed_task: ['未认领题目（taskId=0），当前有未验证权重，参与 1% 池。', 'No task claimed (taskId=0); actual unverified weight participates in the 1% pool.'],
    unverified_pool: ['当前含未验证池权重（1% 池）；未进入纯已验证池的原因无法判断。', 'Current weight includes the unverified 1% pool; the reason it is not exclusively verified is unknown.'],
    pool_unknown: ['所在矿池无法判断：当前 taskId 与权重未能确认已验证池或未验证池。', 'Pool unknown: current taskId and weights do not establish verified or unverified participation.'],
    gas_gate_unknown: ['门数是否超闸门无法判断：缺少经核实的活门数、总门数或候选题 cycles，未代入猜测值。', 'Gas-gate result unknown: verified live/total gate counts or candidate-task cycles are missing.'],
  };
  return (text[item?.code] || text.state_unknown)[en ? 1 : 0];
}
