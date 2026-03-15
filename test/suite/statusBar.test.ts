// test/suite/statusBar.test.ts
import * as assert from 'assert';
import { calcCost, fmtCost, calcBurnRateFromBuffer } from '../../src/statusBar';
import { TokenBreakdown } from '../../src/types';

function td(input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenBreakdown {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

suite('statusBar — calcCost', () => {
  test('sonnet-4-6: input + output pricing', () => {
    // 1M input at $3/MTok = $3, 0.1M output at $15/MTok = $1.50
    const cost = calcCost(td(1_000_000, 100_000), 'claude-sonnet-4-6');
    assert.ok(Math.abs(cost - 4.50) < 0.001, `Expected ~4.50 got ${cost}`);
  });

  test('opus-4 uses higher pricing', () => {
    const cost = calcCost(td(1_000_000, 0), 'claude-opus-4-5');
    assert.ok(Math.abs(cost - 15.00) < 0.001, `Expected ~15.00 got ${cost}`);
  });

  test('claude-3-5-sonnet matches sonnet catch-all', () => {
    const cost = calcCost(td(1_000_000, 0), 'claude-3-5-sonnet-20241022');
    assert.ok(Math.abs(cost - 3.00) < 0.001, `Expected ~3.00 got ${cost}`);
  });

  test('unknown model uses fallback (sonnet pricing)', () => {
    const cost = calcCost(td(1_000_000, 0), 'some-unknown-model');
    assert.ok(Math.abs(cost - 3.00) < 0.001, `Expected fallback $3.00 got ${cost}`);
  });

  test('zero tokens returns 0', () => {
    assert.strictEqual(calcCost(td(0, 0), 'claude-sonnet-4-6'), 0);
  });

  test('cache tokens included in cost', () => {
    // 1M cache reads at $0.30/MTok = $0.30
    const cost = calcCost(td(0, 0, 1_000_000, 0), 'claude-sonnet-4-6');
    assert.ok(Math.abs(cost - 0.30) < 0.001, `Expected ~0.30 got ${cost}`);
  });
});

suite('statusBar — fmtCost', () => {
  test('zero returns empty string', () => {
    assert.strictEqual(fmtCost(0), '');
  });

  test('less than $0.01 returns ~$0.00', () => {
    assert.strictEqual(fmtCost(0.005), '~$0.00');
  });

  test('value under $1 formatted correctly', () => {
    assert.strictEqual(fmtCost(0.42), '~$0.42');
  });

  test('value over $1 formatted with two decimals', () => {
    assert.strictEqual(fmtCost(1.234), '~$1.23');
  });
});

suite('statusBar — calcBurnRateFromBuffer', () => {
  test('returns null with fewer than 2 readings', () => {
    assert.strictEqual(calcBurnRateFromBuffer([{ tokens: 100, time: 0 }], 200_000, 100), null);
  });

  test('returns null when elapsed < 5000ms', () => {
    const buf = [{ tokens: 0, time: 0 }, { tokens: 1000, time: 4999 }];
    assert.strictEqual(calcBurnRateFromBuffer(buf, 200_000, 1000), null);
  });

  test('returns null when token delta <= 0 (compaction)', () => {
    const buf = [{ tokens: 5000, time: 0 }, { tokens: 4000, time: 10_000 }];
    assert.strictEqual(calcBurnRateFromBuffer(buf, 200_000, 4000), null);
  });

  test('computes correct rate for 6000 tokens over 60s = 6000/min', () => {
    const buf = [{ tokens: 0, time: 0 }, { tokens: 6000, time: 60_000 }];
    const result = calcBurnRateFromBuffer(buf, 200_000, 6000);
    assert.ok(result !== null);
    assert.ok(Math.abs(result.recent - 6000) < 1, `Expected 6000/min got ${result.recent}`);
  });

  test('timeToFull: 194000 tokens remaining at 6000/min ≈ 32.3 min', () => {
    const buf = [{ tokens: 0, time: 0 }, { tokens: 6000, time: 60_000 }];
    const result = calcBurnRateFromBuffer(buf, 200_000, 6000);
    assert.ok(result !== null);
    assert.ok(Math.abs(result.timeToFull - (194_000 / 6000)) < 0.1);
  });

  test('uses oldest + newest readings (not just last 2)', () => {
    // 5 readings spanning 120s, newest shows 12000 total delta — should give 6000/min
    const buf = [
      { tokens: 0,     time: 0 },
      { tokens: 2000,  time: 20_000 },
      { tokens: 5000,  time: 60_000 },
      { tokens: 9000,  time: 100_000 },
      { tokens: 12000, time: 120_000 },
    ];
    const result = calcBurnRateFromBuffer(buf, 200_000, 12000);
    assert.ok(result !== null);
    assert.ok(Math.abs(result.recent - 6000) < 1);
  });
});
