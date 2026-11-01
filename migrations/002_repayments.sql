-- A repayment is evidence of settled funds reported by the payment processor (or recorded by ops).
-- The external reference is UNIQUE, so one real-world payment can be applied at most once,
-- even if it is re-delivered under a different Idempotency-Key or by a different caller.
CREATE TABLE repayments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  external_ref     text NOT NULL UNIQUE,
  fees_cents       bigint NOT NULL CHECK (fees_cents >= 0),
  interest_cents   bigint NOT NULL CHECK (interest_cents >= 0),
  principal_cents  bigint NOT NULL CHECK (principal_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_sums_to_amount CHECK (fees_cents + interest_cents + principal_cents = amount_cents)
);
CREATE INDEX repayments_account_idx ON repayments (account_id, created_at);

CREATE TRIGGER repayments_immutable BEFORE UPDATE OR DELETE ON repayments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER repayments_no_truncate BEFORE TRUNCATE ON repayments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
