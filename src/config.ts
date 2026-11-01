import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const int = (d: number) => z.coerce.number().int().default(d);

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/acme'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: int(3000),
  POOL_MAX: int(10),
  // Product rules (all money in cents)
  APR_BPS: int(2400), // 24.00% APR
  MIN_COLLATERAL_CENTS: int(20_000), // $200 minimum to activate
  MAX_AMOUNT_CENTS: int(10_000_000), // $100k cap per request
  LIMIT_RATIO_BPS: z.coerce.number().int().min(1).max(10_000).default(10_000), // limit = collateral * ratio (<=100%)
  STATEMENT_CYCLE_DAYS: int(30),
  GRACE_DAYS: int(21), // days after statement date until payment is due
  LATE_FEE_CENTS: int(1_500),
  MIN_PAYMENT_FLOOR_CENTS: int(2_500),
  MIN_PAYMENT_PCT_BPS: int(1_000), // 10% of statement balance
  AUTH_TTL_DAYS: int(7),
  // Demo/testing only: lets ops pass an explicit business date to the daily job.
  ALLOW_SIMULATED_TIME: bool,
});

const e = schema.parse(process.env);

// Simulated time lets ops post an arbitrary business date to the billing job. Never acceptable in production.
if (process.env['NODE_ENV'] === 'production' && e.ALLOW_SIMULATED_TIME) {
  throw new Error('ALLOW_SIMULATED_TIME must not be enabled when NODE_ENV=production');
}

export const config = {
  databaseUrl: e.DATABASE_URL,
  jwtSecret: e.JWT_SECRET,
  port: e.PORT,
  poolMax: e.POOL_MAX,
  aprBps: e.APR_BPS,
  minCollateralCents: e.MIN_COLLATERAL_CENTS,
  maxAmountCents: e.MAX_AMOUNT_CENTS,
  limitRatioBps: e.LIMIT_RATIO_BPS,
  cycleDays: e.STATEMENT_CYCLE_DAYS,
  graceDays: e.GRACE_DAYS,
  lateFeeCents: e.LATE_FEE_CENTS,
  minPaymentFloorCents: e.MIN_PAYMENT_FLOOR_CENTS,
  minPaymentPctBps: e.MIN_PAYMENT_PCT_BPS,
  authTtlDays: e.AUTH_TTL_DAYS,
  allowSimulatedTime: e.ALLOW_SIMULATED_TIME,
} as const;
