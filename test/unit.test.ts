import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocate, totalOwed } from '../src/money.js';
import { canonical, chainHash } from '../src/audit.js';
import { dailyInterest, minimumDue } from '../src/services/billing.js';
import { limitFor } from '../src/services/accounts.js';
import { addDays } from '../src/clock.js';
import { AppError } from '../src/errors.js';

describe('money.allocate (payment waterfall: fees -> interest -> principal)', () => {
  const debt = { fees: 1_500, interest: 2_000, principal: 10_000 };
  it.each([
    [1, { fees: 1, interest: 0, principal: 0 }],
    [1_500, { fees: 1_500, interest: 0, principal: 0 }],
    [1_501, { fees: 1_500, interest: 1, principal: 0 }],
    [3_500, { fees: 1_500, interest: 2_000, principal: 0 }],
    [3_501, { fees: 1_500, interest: 2_000, principal: 1 }],
    [13_500, { fees: 1_500, interest: 2_000, principal: 10_000 }],
  ])('allocates %i cents', (amount, expected) => {
    const a = allocate(debt, amount);
    expect(a).toEqual(expected);
    expect(a.fees + a.interest + a.principal).toBe(amount); // nothing created or lost
  });
  it('rejects more than is owed, with a typed error', () => {
    expect(() => allocate(debt, totalOwed(debt) + 1)).toThrow(AppError);
  });
});

describe('limitFor / minimumDue / dailyInterest edge cases', () => {
  it('limit never exceeds collateral and rounds down', () => {
    expect(limitFor(0)).toBe(0);
    expect(limitFor(20_000)).toBe(20_000);
    expect(limitFor(20_001)).toBeLessThanOrEqual(20_001);
  });
  it('minimum due is capped at the balance and never negative', () => {
    expect(minimumDue(1)).toBe(1);
    expect(minimumDue(2_500)).toBe(2_500);
    expect(minimumDue(2_501)).toBe(2_500);
    expect(minimumDue(25_001)).toBe(2_501);
  });
  it('zero principal accrues nothing and keeps the remainder', () => {
    expect(dailyInterest(0, 2_400, 123)).toEqual({ cents: 0, remainder: 123 });
  });
  it('stays exact for a large balance (no float rounding)', () => {
    const r = dailyInterest(500_000_000, 2_400, 0); // $5M principal
    expect(r.cents * 3_650_000 + r.remainder).toBe(500_000_000 * 2_400);
  });
});

describe('audit hashing', () => {
  it('canonical JSON is independent of key order', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('canonical JSON ignores undefined values exactly like JSON.stringify/jsonb storage', () => {
    // Hash is computed before storage and re-computed after reading jsonb back, where undefined keys are gone.
    expect(canonical({ a: 1, b: undefined })).toBe(canonical(JSON.parse(JSON.stringify({ a: 1, b: undefined }))));
  });
  it('any change to prev hash, actor, action or details changes the hash', () => {
    const base = chainHash('p', 'acc', 'ops:1', 'X', { n: 1 });
    expect(chainHash('q', 'acc', 'ops:1', 'X', { n: 1 })).not.toBe(base);
    expect(chainHash('p', 'acc', 'ops:2', 'X', { n: 1 })).not.toBe(base);
    expect(chainHash('p', 'acc', 'ops:1', 'Y', { n: 1 })).not.toBe(base);
    expect(chainHash('p', 'acc', 'ops:1', 'X', { n: 2 })).not.toBe(base);
  });
});

describe('clock helpers', () => {
  it('addDays crosses month/year/leap boundaries in UTC', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('configuration safety', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it('refuses to boot in production with simulated time enabled', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ALLOW_SIMULATED_TIME'] = 'true';
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow(/ALLOW_SIMULATED_TIME/);
  });

  it('refuses a missing or short JWT secret (no insecure default)', async () => {
    process.env['JWT_SECRET'] = 'too-short';
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow(/at least 32/);
    delete process.env['JWT_SECRET'];
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow();
  });
});
