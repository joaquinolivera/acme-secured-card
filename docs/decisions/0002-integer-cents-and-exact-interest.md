# ADR-0002: Integer cents and exact interest arithmetic

**Status:** accepted

**Context.** Floating point cannot represent most decimal amounts exactly and silently loses cents. Interest produces fractions of a cent.

**Decision.** All money is integer cents (`BIGINT`, JS `number` kept within the safe integer range; the DB driver throws on overflow). USD only. Daily interest is `principal × APR_bps / (10000 × 365)`; the fractional part is carried forward in `interest_remainder` as an exact integer numerator, so total interest over a year equals the exact figure. Only principal accrues interest.

**Alternatives rejected.**
* *`NUMERIC`/decimal library.* Correct but heavier; cents as integers avoid a dependency and rounding-mode ambiguity.
* *JavaScript `BigInt` everywhere.* Safer against overflow, but every API, JSON and test would need conversions; the $100,000 request cap and the overflow-throwing parser give an equivalent guarantee at this scale.
* *Round each day's interest.* Accumulates rounding error: on a 100-cent balance at 24% the daily amount is about 0.066 cents, which rounds to 0 every day (total 0) where the exact total is 24 cents. The carried-remainder approach returns 24 (unit test).

**Consequences.** Exact and testable. The intermediate product `principal × APR_bps` must stay below 2^53 (about 9×10^15): with the default 24% APR (2,400 bps) that allows principal up to about 3.7×10^12 cents, and about 9×10^11 cents even at the maximum 100% APR, all far above the per-request cap and any plausible limit. Multiple currencies would require a currency column and per-currency scale.
