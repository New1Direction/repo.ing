# Encrypted database backups

[Documentation](README.md) / [Production setup](PRODUCTION.md)

## Current operational database — October 24, 2026

Production uses Neon project `<neon-project>`, database `repoing_operational`, not the former Railway database. Read-only inspection of Neon settings confirmed the **six-hour history window** selected. A historical-branch PITR test passed at **23:08 UTC**. No current scheduled logical dump service for Neon has been established.

A fresh snapshot-consistent, read-only dump at **23:04 UTC** was encrypted with `age` and copied to both the Mac and USB recovery locations. Both copies decrypted to the same dump. A network-isolated disposable PostgreSQL restore matched all **138 public tables / 180,145 rows** against the source snapshot. Encrypted SHA-256: `5010618278380b442e079764d67e01ce763aa6585351dd07f7f5c810a9c1bd39`. Owner and grants were omitted; the test does not prove restoration of production roles, secrets or subsequent chain activity. No production data was restored or changed. The earlier 20:41 UTC backup and its evidence remain preserved.

The PITR test created disposable child `<neon-branch>` from production `<neon-branch>` at **22:50:20 UTC**, LSN `0/112FF078`. Both branches contained 141 non-system tables; public/recovery-chart column schemas and hashes of markets, claims, beneficiaries and the three custody ledgers matched. The child's newest chart observation was **22:50:19.919 UTC**, while production had advanced to **23:08:03.631 UTC**, demonstrating historical recovery rather than a current clone. Verification used read-only transactions. The disposable child was removed afterward (404); production remained default/ready (200). This did not test a production recovery cutover, all application queries, role/grant equivalence or chain reconciliation after the restore point.

Private evidence and copy locations are recorded under `.amp/in/artifacts/restoration-lanes-20261023/`: `operational-backup-20261024T230458Z.json`, `neon-retention-readonly.json`, `neon-pitr-control-plane.json`, `neon-pitr-restore-verification.json` and `neon-pitr-cleanup.json`. Keep those artifacts and encrypted dumps outside Git and deployment contexts.

## Retained former Railway backup service

The former service streams a PostgreSQL custom-format `pg_dump` through `age`, uploads only encrypted bytes to private Cloudflare R2 storage, and checks the uploaded object's size. It needs scoped storage credentials, a database connection, and the public encryption recipient; it does not need the decryption key.

Its former daily **08:00 UTC** cron is now disabled, and the old backup/PostgreSQL deployments are stopped with backups and volume retained. Its 30-day `daily/` lifecycle and retained snapshots do **not** provide current Neon coverage. Manual backups are outside that daily lifecycle. Logical snapshots are separate from point-in-time history.

## Recovery key

The configured public recipient is [`backup/recipient.pub`](../backup/recipient.pub). Protect the corresponding private key in a separate secret store, with an additional recovery copy outside the application host and backup account. Losing that key makes the encrypted dumps unrecoverable. A database backup does not replace a backup of required application secrets or signing keys.

## Check a backup

1. Check the scheduled job's latest completion. A successful run ends with `Encrypted backup uploaded and size-checked`.
2. Confirm a new encrypted object exists for the expected date, with a plausible non-zero size.
3. Periodically download an object to a protected local directory, decrypt it with the recovery key, and inspect the archive with `pg_restore --list`.
4. Restore into a new disposable database and verify schema, durable intents, and application data before relying on that recovery path.

Do not restore over the live database during a routine check. A recovery cutover requires an explicit operator decision and reconciliation of chain activity since the snapshot.

## Recorded coverage and limits

Manual and scheduled encrypted dump/restore checks passed during initial setup. Automatic runs were verified on September 25 and 26, 2026. On September 27, a credential mismatch was repaired by setting the job’s database connection to the Railway Postgres reference. A manual run then uploaded and size-checked a 605,667-byte encrypted snapshot before the chart-evidence migration. These are historical Railway observations, superseded by the current operational evidence above; the old schedule is no longer active.

Automatic backup-failure notifications are not configured. Monitor scheduled completion and test key recovery separately. Keep plaintext dumps, decryption keys, and downloaded archives out of Git and deployment uploads.
