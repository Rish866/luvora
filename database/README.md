# Database

Forward-only SQL migrations for Luvora live in [`migrations/`](./migrations).
They are applied in lexical filename order by the runner at
`apps/backend/src/db/migrate.ts`, which records applied files in a
`schema_migrations` table (so re-running is idempotent).

```bash
# from the repo root
npm run -w @luvora/backend migrate:up
```

Luvora intentionally uses plain, auditable SQL migrations over the `pg` driver
rather than an ORM/Prisma. See [`../docs/DATABASE.md`](../docs/DATABASE.md) for
the schema, conventions, and the Increment 1 table reference.
