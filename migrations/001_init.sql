-- Acme Credit secured card: schema.
-- Money is always BIGINT cents (USD). No floats anywhere.
-- The database enforces the safety invariants too, so a bug in application code
-- cannot silently create money, overspend a limit or rewrite history.

CREATE TYPE account_status AS ENUM ('PENDING_COLLATERAL', 'ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE deposit_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');
CREATE TYPE auth_status AS ENUM ('AUTHORIZED', 'DECLINED', 'CAPTURED', 'VOIDED', 'EXPIRED');
CREATE TYPE statement_status AS ENUM ('OPEN', 'SETTLED', 'OVERDUE');

CREATE TABLE accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        text NOT NULL,
  status             account_status NOT NULL DEFAULT 'PENDING_COLLATERAL',
  frozen_by          text,                              -- 'customer' | 'ops' while FROZEN
  apr_bps            int NOT NULL CHECK (apr_bps BETWEEN 0 AND 10000),
  collateral_cents   bigint NOT NULL DEFAULT 0 CHECK (collateral_cents >= 0),  -- confirmed deposits only
  credit_limit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_limit_cents >= 0),
  principal_cents    bigint NOT NULL DEFAULT 0 CHECK (principal_cents >= 0),   -- captured purchases owed
  interest_cents     bigint NOT NULL DEFAULT 0 CHECK (interest_cents >= 0),
  fees_cents         bigint NOT NULL DEFAULT 0 CHECK (fees_cents >= 0),
  held_cents         bigint NOT NULL DEFAULT 0 CHECK (held_cents >= 0),        -- open authorizations
  interest_remainder bigint NOT NULL DEFAULT 0 CHECK (interest_remainder >= 0),-- sub-cent carry, exact integer math
  last_accrual_date  date,
  next_statement_date date,
  activated_at       timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- A purchase can never push committed spend past the limit.
  CONSTRAINT spend_within_limit CHECK (principal_cents + held_cents <= credit_limit_cents),
  -- The limit is derived from collateral and can never exceed it (ratio <= 100%).
  CONSTRAINT limit_within_collateral CHECK (credit_limit_cents <= collateral_cents),
  -- A card is only usable (ACTIVE/FROZEN) once confirmed collateral produced a limit.
  CONSTRAINT active_needs_collateral CHECK (status NOT IN ('ACTIVE', 'FROZEN') OR credit_limit_cents > 0),
  CONSTRAINT frozen_has_owner CHECK ((status = 'FROZEN') = (frozen_by IS NOT NULL)),
  CONSTRAINT closed_is_empty CHECK (status <> 'CLOSED' OR (
    principal_cents = 0 AND interest_cents = 0 AND fees_cents = 0 AND held_cents = 0
    AND collateral_cents = 0 AND credit_limit_cents = 0))
);
-- One open account per customer.
CREATE UNIQUE INDEX one_open_account_per_customer ON accounts (customer_id) WHERE status <> 'CLOSED';
CREATE INDEX accounts_job_idx ON accounts (status, next_statement_date);

CREATE TABLE deposits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       deposit_status NOT NULL DEFAULT 'PENDING',
  external_ref text UNIQUE,                 -- payment-processor reference; one payment can fund one deposit only
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT confirmed_has_ref CHECK (status <> 'CONFIRMED' OR (external_ref IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX deposits_account_idx ON deposits (account_id, status);

CREATE TABLE authorizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  captured_cents bigint NOT NULL DEFAULT 0 CHECK (captured_cents >= 0),
  merchant       text NOT NULL,
  status         auth_status NOT NULL,
  decline_reason text,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  CONSTRAINT capture_within_auth CHECK (captured_cents <= amount_cents)
);
CREATE INDEX authorizations_open_idx ON authorizations (account_id) WHERE status = 'AUTHORIZED';

-- ---------------------------------------------------------------- ledger
-- Double-entry, append-only. Every money movement is one balanced transaction.
CREATE TABLE ledger_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  type           text NOT NULL CHECK (type IN ('DEPOSIT','CAPTURE','REPAYMENT','INTEREST','LATE_FEE',
                                               'COLLATERAL_APPLIED','WRITE_OFF','COLLATERAL_RELEASE')),
  ref_type       text,
  ref_id         uuid,
  effective_at   timestamptz NOT NULL,
  effective_date date NOT NULL,            -- UTC business date, used by statements
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_txn_account_idx ON ledger_transactions (account_id, effective_date);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  txn_id         uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  ledger_account text NOT NULL CHECK (ledger_account IN ('cash','collateral_liability','receivable_principal',
                     'receivable_interest','receivable_fees','merchant_payable','interest_income','fee_income',
                     'bad_debt_expense')),
  direction      char(1) NOT NULL CHECK (direction IN ('D','C')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0)
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, ledger_account);

-- ---------------------------------------------------------------- audit
-- Append-only, hash-chained per account: editing or removing a row breaks the chain.
CREATE TABLE audit_log (
  seq        bigserial PRIMARY KEY,
  account_id uuid REFERENCES accounts(id),
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  request_id text,
  details    jsonb NOT NULL DEFAULT '{}',
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE INDEX audit_account_idx ON audit_log (account_id, seq DESC);

-- ---------------------------------------------------------------- statements
CREATE TABLE statements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  opening_cents     bigint NOT NULL,
  purchases_cents   bigint NOT NULL,
  repayments_cents  bigint NOT NULL,
  interest_cents    bigint NOT NULL,
  fees_cents        bigint NOT NULL,
  closing_cents     bigint NOT NULL,
  minimum_due_cents bigint NOT NULL,
  due_date          date NOT NULL,
  status            statement_status NOT NULL,
  late_fee_cents    bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, period_end)
);

-- ---------------------------------------------------------------- idempotency + outbox
CREATE TABLE idempotency_keys (
  scope           text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Transactional outbox: events are committed atomically with the state change,
-- then relayed to a bus (SNS/EventBridge) by a separate relay.
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------- integrity triggers
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

CREATE TRIGGER ledger_txn_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_txn_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Every ledger transaction must balance (debits = credits) at commit time.
CREATE FUNCTION check_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'D'), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'C'), 0)
    INTO d, c FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF d <> c THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: debits=% credits=%', NEW.txn_id, d, c;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();
