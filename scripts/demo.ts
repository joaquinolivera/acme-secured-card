// End-to-end walkthrough against a running server (npm run dev / docker compose up).
// Usage: BASE_URL=http://localhost:3000 JWT_SECRET=... npm run demo
import { randomUUID } from 'node:crypto';
import { signToken, type Role } from '../src/auth.js';

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000';
const customer = `demo_${randomUUID().slice(0, 8)}`;
const tok = {
  customer: await signToken('customer', customer),
  processor: await signToken('processor', 'card-network'),
  ops: await signToken('ops', 'ops-1'),
};

async function api(method: string, path: string, role: Role, body?: object) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${tok[role]}`,
      'content-type': 'application/json',
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const step = (t: string) => console.log(`\n== ${t}`);
const show = (a: any) =>
  console.log(
    `   status=${a.status} limit=${usd(a.creditLimitCents)} owed=${usd(a.totalOwedCents)} held=${usd(a.heldCents)} available=${usd(a.availableCreditCents)}`,
  );

step('1. Open account (no card yet)');
const acc = await api('POST', '/v1/accounts', 'customer', {});
const id = acc.body.id;
show(acc.body);

step('2. Customer deposits $500 collateral; nothing is usable until the processor confirms funds');
const dep = await api('POST', `/v1/accounts/${id}/deposits`, 'customer', { amountCents: 50_000 });
show((await api('GET', `/v1/accounts/${id}`, 'customer')).body);
const conf = await api('POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, 'processor', {
  externalRef: `pay_${randomUUID().slice(0, 8)}`,
  amountCents: 50_000,
});
console.log('   confirmed ->');
show(conf.body.account);

step('3. Purchases: $300 ok, $250 declined (only $200 left), $200 ok');
const a1 = await api('POST', `/v1/accounts/${id}/authorizations`, 'processor', { amountCents: 30_000, merchant: 'Grocer' });
const a2 = await api('POST', `/v1/accounts/${id}/authorizations`, 'processor', { amountCents: 25_000, merchant: 'Electronics' });
console.log(`   $300 -> ${a1.status} ${a1.body.status}; $250 -> ${a2.status} ${a2.body.status} (${a2.body.declineReason})`);
const a3 = await api('POST', `/v1/accounts/${id}/authorizations`, 'processor', { amountCents: 20_000, merchant: 'Pharmacy' });
console.log(`   $200 -> ${a3.status} ${a3.body.status}`);
show((await api('GET', `/v1/accounts/${id}`, 'customer')).body);

step('4. Clearing: capture $300 (becomes debt); void the $200 hold');
await api('POST', `/v1/authorizations/${a1.body.id}/capture`, 'processor', {});
await api('POST', `/v1/authorizations/${a3.body.id}/void`, 'processor', {});
show((await api('GET', `/v1/accounts/${id}`, 'customer')).body);

step('5. Processor reports a settled $120 payment -> credit is restored');
const pay = await api('POST', `/v1/accounts/${id}/repayments`, 'processor', {
  amountCents: 12_000,
  externalRef: `bank_${randomUUID().slice(0, 8)}`,
});
show(pay.body.account);

step('6. Repay the rest and close: collateral comes back');
await api('POST', `/v1/accounts/${id}/repayments`, 'processor', { amountCents: 18_000, externalRef: `bank_${randomUUID().slice(0, 8)}` });
const closed = await api('POST', `/v1/accounts/${id}/close`, 'customer', {});
console.log(`   released ${usd(closed.body.releasedCents)}; account is ${closed.body.account.status}`);

step('7. Books check (ledger == balances, audit chain intact)');
const rec = await api('GET', '/v1/admin/reconcile', 'ops');
console.log(`   ok=${rec.body.ok} accountsChecked=${rec.body.accountsChecked} discrepancies=${rec.body.discrepancies.length}`);
const tx = await api('GET', `/v1/accounts/${id}/transactions`, 'customer');
console.log(`   ledger transactions for this account: ${tx.body.transactions.map((t: any) => t.type).join(' -> ')}`);
