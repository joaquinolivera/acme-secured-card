# ADR-0007: Toolchain pins

**Status:** accepted

**Context.** `npm install typescript` resolved to TypeScript 7.x, which `typescript-eslint` does not yet support (peer range below 6.1). Forcing the resolution would give a lint setup that may silently misbehave. Separately, `npm audit` reported a denial-of-service advisory in `minimatch` < 11.0.1, reached only through the linting tools.

**Decision.** Pin TypeScript to the newest 6.0.x. Add an `overrides` entry forcing `minimatch ^11.0.1`. Node 22 in CI and the Dockerfile.

**Alternatives rejected.** `--force` / `--legacy-peer-deps` (hides incompatibility); disabling type-aware linting (loses the floating-promise check that protects money steps); ignoring the advisory (dev-only, but it is trivially fixable).

**Consequences.** `npm audit` reports 0 vulnerabilities for both production and development dependencies. Revisit when `typescript-eslint` supports TypeScript 7; Dependabot will propose updates.
