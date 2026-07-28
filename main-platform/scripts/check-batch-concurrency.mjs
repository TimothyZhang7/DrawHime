/** 本脚本验证多图批次并发释放、部分成功结束、未开始任务退款和终态推进幂等，不连接数据库、不创建真实任务。 */
import assert from 'node:assert/strict';

/** 统计批次内各状态数量。 */
function countStatuses(tasks) {
  return tasks.reduce((map, task) => {
    map.set(task.status, (map.get(task.status) ?? 0) + 1);
    return map;
  }, new Map());
}

/** 构造批次运行态，模拟数据库里的批次统计字段。 */
function createBatch(count = 3, concurrency = 2, stopAfterConsecutiveFailures = 2) {
  return {
    count,
    concurrency,
    stopAfterConsecutiveFailures,
    consecutiveFailures: 0,
    status: 'running',
    successCount: 0,
    failedCount: 0,
    finished: false,
    advancedKeys: new Set(),
  };
}

/** 按生产仓储的核心规则模拟一次终态推进，覆盖并发释放、连续失败停止和批次终态。 */
function advanceAfterTerminal(batch, tasks, taskId) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task || (task.status !== 'success' && task.status !== 'failed')) return [];
  const advanceKey = `${task.id}:${task.status}`;
  if (batch.advancedKeys.has(advanceKey)) return [];
  // 真实仓储使用 system_configs 做幂等标记，脚本用 Set 模拟同一任务终态只推进一次。
  batch.advancedKeys.add(advanceKey);

  batch.consecutiveFailures = task.status === 'failed' ? batch.consecutiveFailures + 1 : 0;
  const statusCount = countStatuses(tasks);
  const successCount = statusCount.get('success') ?? 0;
  const failedCount = statusCount.get('failed') ?? 0;
  const activeCount = (statusCount.get('queued') ?? 0) + (statusCount.get('running') ?? 0) + (statusCount.get('finalizing') ?? 0);
  const deferredCount = statusCount.get('deferred') ?? 0;

  if (deferredCount > 0 && batch.consecutiveFailures >= batch.stopAfterConsecutiveFailures) {
    const stopped = [];
    for (const item of tasks) {
      if (item.status !== 'deferred') continue;
      item.status = 'failed';
      item.refunded = true;
      stopped.push(item.id);
    }
    const terminal = activeCount === 0;
    batch.status = terminal ? successCount > 0 ? 'partial_success' : 'failed' : 'running';
    batch.successCount = successCount;
    batch.failedCount = failedCount + stopped.length;
    batch.finished = terminal;
    return [];
  }

  // 关键规则：释放数量必须等于“并发上限 - 当前活跃数”，并且不能超过 deferred 剩余数。
  const slots = Math.max(0, batch.concurrency - activeCount);
  const releaseLimit = Math.min(deferredCount, slots);
  const released = [];
  for (const item of tasks) {
    if (item.status !== 'deferred' || released.length >= releaseLimit) continue;
    item.status = 'queued';
    released.push(item.id);
  }

  const remainingDeferred = Math.max(0, deferredCount - released.length);
  const remainingActive = activeCount + released.length;
  const terminal = remainingDeferred === 0 && remainingActive === 0;
  batch.status = terminal
    ? successCount > 0 && failedCount === 0 ? 'success'
    : successCount > 0 ? 'partial_success'
    : 'failed'
    : 'running';
  batch.successCount = successCount;
  batch.failedCount = failedCount;
  batch.finished = terminal;
  return released;
}

/** 构造 count=3、concurrency=2 的批次：初始只允许 2 个 queued，第三个 deferred。 */
function createThreeImageBatch() {
  return [
    { id: 'task_01', status: 'queued' },
    { id: 'task_02', status: 'queued' },
    { id: 'task_03', status: 'deferred' },
  ];
}

{
  const batch = createBatch();
  const tasks = createThreeImageBatch();
  assert.deepEqual(tasks.map((task) => task.status), ['queued', 'queued', 'deferred']);

  // 第一张完成后，第二张仍活跃，因此只应释放第三张 1 个任务。
  tasks[0].status = 'success';
  const releasedAfterFirst = advanceAfterTerminal(batch, tasks, 'task_01');
  assert.deepEqual(releasedAfterFirst, ['task_03']);
  assert.deepEqual(tasks.map((task) => task.status), ['success', 'queued', 'queued']);

  // 重复终态回写不得再次推进批次，也不能改变统计。
  const duplicateRelease = advanceAfterTerminal(batch, tasks, 'task_01');
  assert.deepEqual(duplicateRelease, []);
  assert.equal(batch.consecutiveFailures, 0);

  // 第二张也完成后，已经没有 deferred，不能重复释放。
  tasks[1].status = 'success';
  const releasedAfterSecond = advanceAfterTerminal(batch, tasks, 'task_02');
  assert.deepEqual(releasedAfterSecond, []);
  assert.deepEqual(tasks.map((task) => task.status), ['success', 'success', 'queued']);
}

{
  const batch = createBatch(4, 2, 1);
  const tasks = [
    { id: 'task_01', status: 'queued' },
    { id: 'task_02', status: 'queued' },
    { id: 'task_03', status: 'deferred' },
    { id: 'task_04', status: 'deferred' },
  ];
  tasks[0].status = 'failed';
  const released = advanceAfterTerminal(batch, tasks, 'task_01');
  assert.deepEqual(released, []);
  assert.deepEqual(tasks.map((task) => task.status), ['failed', 'queued', 'failed', 'failed']);
  assert.equal(tasks[2].refunded, true);
  assert.equal(tasks[3].refunded, true);
  assert.equal(batch.status, 'running');
  assert.equal(batch.finished, false);

  // 剩余活跃任务成功后，批次应按真实结果 partial_success 结束，不能继续等待原始 N 张成功。
  tasks[1].status = 'success';
  advanceAfterTerminal(batch, tasks, 'task_02');
  assert.equal(batch.status, 'partial_success');
  assert.equal(batch.successCount, 1);
  assert.equal(batch.failedCount, 3);
  assert.equal(batch.finished, true);
}

{
  const batch = createBatch(3, 2, 2);
  const tasks = createThreeImageBatch();
  tasks[0].status = 'success';
  advanceAfterTerminal(batch, tasks, 'task_01');
  tasks[1].status = 'failed';
  advanceAfterTerminal(batch, tasks, 'task_02');
  tasks[2].status = 'failed';
  advanceAfterTerminal(batch, tasks, 'task_03');
  assert.equal(batch.status, 'partial_success');
  assert.equal(batch.successCount, 1);
  assert.equal(batch.failedCount, 2);
  assert.equal(batch.finished, true);
  assert.equal(tasks.filter((task) => task.status === 'success').length, 1);
}

{
  const batch = createBatch(4, 2, 2);
  const tasks = [
    { id: 'task_01', status: 'queued' },
    { id: 'task_02', status: 'queued' },
    { id: 'task_03', status: 'deferred' },
    { id: 'task_04', status: 'deferred' },
  ];
  tasks[0].status = 'failed';
  advanceAfterTerminal(batch, tasks, 'task_01');
  tasks[1].status = 'failed';
  advanceAfterTerminal(batch, tasks, 'task_02');
  assert.deepEqual(tasks.map((task) => task.status), ['failed', 'failed', 'queued', 'failed']);
  assert.equal(tasks[3].refunded, true);
  assert.equal(batch.status, 'running');
  assert.equal(batch.finished, false);
  tasks[2].status = 'failed';
  advanceAfterTerminal(batch, tasks, 'task_03');
  assert.equal(batch.status, 'failed');
  assert.equal(batch.successCount, 0);
  assert.equal(batch.failedCount, 4);
  assert.equal(batch.finished, true);
}

console.log('batch concurrency check passed: release, partial success, stopped refunds and idempotent terminal advance');
