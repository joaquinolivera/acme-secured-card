// Usage: npm run token -- <customer|processor|ops> <subject>
import { signToken, type Role } from '../src/auth.js';
const [role, sub] = process.argv.slice(2);
if (!role || !sub || !['customer', 'processor', 'ops'].includes(role)) {
  console.error('usage: npm run token -- <customer|processor|ops> <subject>');
  process.exit(1);
}
console.log(await signToken(role as Role, sub, '12h'));
