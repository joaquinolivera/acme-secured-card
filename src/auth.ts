import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { AppError } from './errors.js';

export type Role = 'customer' | 'processor' | 'ops';
export interface Actor {
  sub: string;
  role: Role;
}

const key = new TextEncoder().encode(config.jwtSecret);
const ISS = 'acme-auth';
const AUD = 'acme-credit';
const ROLES: Role[] = ['customer', 'processor', 'ops'];

/** Dev/test token minting. In production tokens come from the IdP (see docs/DESIGN.md). */
export function signToken(role: Role, sub: string, ttl = '1h'): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}

export async function authenticate(header: string | undefined, allowed: Role[]): Promise<Actor> {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'missing bearer token');
  try {
    const { payload } = await jwtVerify(m[1]!, key, { algorithms: ['HS256'], issuer: ISS, audience: AUD });
    const role = payload['role'] as Role;
    if (!payload.sub || !ROLES.includes(role)) throw new Error('bad claims');
    if (!allowed.includes(role)) throw new AppError(403, 'FORBIDDEN', 'role not permitted');
    return { sub: payload.sub, role };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(401, 'UNAUTHENTICATED', 'invalid token');
  }
}

export const actorLabel = (a: Actor): string => `${a.role}:${a.sub}`;
export const SYSTEM: Actor = { sub: 'daily-job', role: 'ops' };
