# Disaster recovery (Increment 11)

Runbook for backing up and restoring the Luvora database, and recovering the
service. The database is the single source of truth; the API and worker are
stateless and can be re-created from the image at any time.

## Scope & objectives

- **Primary asset**: the PostgreSQL database (users, sessions, content, consent,
  moderation/audit, jobs, security/operational events).
- **RPO/RTO**: determined by backup frequency + restore speed. The logical
  backups below give a point-in-time snapshot per run. For a tighter RPO, pair
  them with WAL archiving / PITR (managed providers do this continuously).

> These scripts are a portable, provider-agnostic baseline. They are NOT a
> replacement for a managed provider's continuous/PITR backups — use both where
> available.

## Backup

`scripts/backup-db.sh` takes a compressed, custom-format (`pg_dump -Fc`) logical
backup. Credentials come ONLY from `DATABASE_URL` (or `~/.pgpass`); the script
never hardcodes or echoes a password, and writes with owner-only permissions.

```bash
DATABASE_URL="postgres://user:pass@host:5432/luvora" \
  ./scripts/backup-db.sh /secure/backups
# stdout is ONLY the backup file path (progress goes to stderr), so you can:
BACKUP=$(DATABASE_URL=... ./scripts/backup-db.sh /secure/backups 2>/dev/null)
```

The script also runs an integrity check (`pg_restore -l`) on the produced
archive before reporting success.

**Scheduling (example cron, daily at 02:00 UTC):**
```
0 2 * * *  DATABASE_URL="postgres://..." /app/scripts/backup-db.sh /secure/backups >> /var/log/luvora-backup.log 2>&1
```

**Retention & off-site**: copy backups to durable, access-controlled, off-host
storage (e.g. object storage with versioning + lifecycle). Encrypt at rest.
Keep enough generations to cover your retention policy.

## Restore

`scripts/restore-db.sh` restores a backup into the target `DATABASE_URL`. It is
**destructive** (uses `--clean --if-exists`), so it requires an interactive
`yes` confirmation unless `FORCE=1` is set. It validates the archive first and
masks any password in its confirmation output.

```bash
# Interactive (prompts before overwriting):
DATABASE_URL="postgres://user:pass@host:5432/luvora" \
  ./scripts/restore-db.sh /secure/backups/luvora-20260101T020000Z.dump

# Non-interactive (automation):
FORCE=1 DATABASE_URL="postgres://..." ./scripts/restore-db.sh "$BACKUP"
```

After a restore:
1. Run migrations (idempotent) to ensure the schema is at the expected version:
   `npm run -w @luvora/backend migrate:up`.
2. Start/point the API at the restored DB and check `GET /ready` → `ready`.
3. Spot-check critical invariants (user can log in, a known match/session loads).

## Full-service recovery procedure

1. **Provision** a healthy PostgreSQL instance and set `DATABASE_URL`.
2. **Restore** the latest good backup (above). Prefer restoring into a fresh DB,
   then cutting over.
3. **Migrate** (idempotent) to reconcile the schema version.
4. **Deploy** the API + worker from the image (`docs/DEPLOYMENT.md`), with
   production secrets. The fail-fast guard rejects misconfiguration.
5. **Verify** `/ready`, authentication, and a sample read path; watch
   `/metrics` and logs for errors.
6. **Resume traffic** by pointing the load balancer at the healthy instances.

## Validating backups (do this regularly)

A backup you have never restored is a hope, not a backup. Periodically restore
the latest backup into a throwaway database and run the smoke/readiness checks.
The restore path is covered by this repo's end-to-end validation of
`backup-db.sh` → simulated data loss → `restore-db.sh` → data recovered.

## What is NOT covered here

- Continuous/PITR backup (WAL archiving) — configure at the DB/provider level.
- Cross-region replication / automated failover — infrastructure concern.
- Backups of external systems (push providers, object storage for media) —
  media bytes live in the configured storage provider; back that up per its own
  mechanism. In this repo the default is local storage (dev only).
