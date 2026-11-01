import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';

/** Request amounts: positive integer cents, bounded. Floats/strings are rejected. */
export const centsSchema = z.number().int().positive().max(config.maxAmountCents);

/** The service is USD-only. Clients may state the currency explicitly; anything else is refused, never assumed. */
export const currencySchema = z.literal('USD').optional();

export interface Debt {
  fees: number;
  interest: number;
  principal: number;
}

export const totalOwed = (d: Debt): number => d.fees + d.interest + d.principal;

/** Applies `amount` to debt in order fees -> interest -> principal. Throws if it exceeds the debt. */
export function allocate(debt: Debt, amount: number): Debt {
  if (amount > totalOwed(debt)) {
    throw new AppError(422, 'OVERPAYMENT', `amount exceeds balance owed (${totalOwed(debt)} cents)`);
  }
  const fees = Math.min(amount, debt.fees);
  const interest = Math.min(amount - fees, debt.interest);
  const principal = amount - fees - interest;
  return { fees, interest, principal };
}
