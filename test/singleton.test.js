import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSingleton } from '../server/services/singleton.js';

test('重叠调用被跳过,结束后可再次执行', async () => {
  let release;
  let runs = 0;
  const task = makeSingleton('测试任务', () => {
    runs += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  });

  const first = task();
  assert.equal(await task(), undefined, '第一轮未结束时再次调用被跳过');
  assert.equal(runs, 1);

  release('done');
  assert.equal(await first, 'done');

  const second = task();
  assert.equal(runs, 2, '上一轮结束后恢复执行');
  release('again');
  assert.equal(await second, 'again');
});

test('异常照常抛出,running 在 finally 复位', async () => {
  let calls = 0;
  const task = makeSingleton('会失败的任务', async () => {
    calls += 1;
    throw new Error('boom');
  });
  await assert.rejects(task, /boom/);
  await assert.rejects(task, /boom/);
  assert.equal(calls, 2, '失败后不会卡死在 running 状态');
});

test('卡死告警:超过阈值后每个告警周期最多一条', async () => {
  let t = 0;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  try {
    let release;
    const task = makeSingleton(
      '慢任务',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { stuckWarnMs: 1000, now: () => t }
    );
    const running = task();

    t = 500;
    await task(); // 未到阈值:跳过但不告警
    assert.equal(warns.length, 0);

    t = 1000;
    await task(); // 到阈值:告警一次
    assert.equal(warns.length, 1);
    assert.match(warns[0], /慢任务/);

    t = 1500;
    await task(); // 同一告警周期内不重复
    assert.equal(warns.length, 1);

    t = 2000;
    await task(); // 下一周期再告警
    assert.equal(warns.length, 2);

    release();
    await running;
  } finally {
    console.warn = origWarn;
  }
});

test('stuckWarnMs=0 关闭告警;返回值与参数透传', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  try {
    let t = 0;
    let release;
    const silent = makeSingleton(
      '静默任务',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { stuckWarnMs: 0, now: () => t }
    );
    const running = silent();
    t = 1e9;
    await silent();
    assert.equal(warns.length, 0);
    release();
    await running;
  } finally {
    console.warn = origWarn;
  }

  const echo = makeSingleton('回声', async (x) => x * 2);
  assert.equal(await echo(21), 42);
});
