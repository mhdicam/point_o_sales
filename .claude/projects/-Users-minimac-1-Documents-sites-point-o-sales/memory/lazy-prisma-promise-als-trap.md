---
name: lazy-prisma-promise-als-trap
description: runUnscoped/runWithTenantContext callbacks must be async and await inside, or the query runs under the wrong tenant context
metadata:
  type: feedback
---

A Prisma delegate call (`db.model.findMany(...)`) returns a lazy `PrismaPromise` that only dispatches the query on `.then()`. If a `runUnscoped(() => db.model.findMany(...))` or `runWithTenantContext(ctx, () => db.model.findFirst(...))` callback returns that promise **unawaited**, the AsyncLocalStorage frame exits before dispatch, and the query runs under whatever context is on the stack next — post-login that is the tenant middleware's `{ tenantId: '' }` (see `tenant.middleware.ts`: `claims.tenantId ?? ''`).

**Symptom:** the tenant-scope extension treats `''` as a real tenant (it is neither `undefined` nor the `__unscoped__` sentinel), injects `tenantId: ''` into the `where`, and Postgres fails deserialization with `Inconsistent column data: Error creating UUID, invalid length: expected length 32 for simple format, found 0`. For `runWithTenantContext` the failure mode is instead `MissingTenantContextError`.

**Fix:** make the callback `async` and `await` the delegate inside it:
`runUnscoped(async () => await db.model.findMany(...))`.

**Why:** the await keeps the ALS frame alive until the query actually dispatches. **How to apply:** whenever you see `runUnscoped`/`runWithTenantContext` with a non-async arrow that returns a Prisma call directly, add the inner `async`/`await`. Fixed in `session.service.ts` (both `listMemberships` and `selectScope`).
