# Encrypted database backups

[Documentation](README.md) / [Production setup](PRODUCTION.md)

The backup service runs separately from web and worker. It streams a PostgreSQL custom-format `pg_dump` through `age`, uploads only encrypted bytes to private Cloudflare R2 storage, and checks the uploaded object's size. The job needs scoped storage credentials, a database connection, and the public encryption recipient; it does not need the decryption key.

The hosted installation uses a daily **08:00 UTC** schedule and a 30-day lifecycle for its `daily/` prefix. Repeating a run on the same UTC date replaces that day's object. Manual backups are kept outside that daily lifecycle. These are logical snapshots, not point-in-time recovery.

## Recovery key

The configured public recipient is [`backup/recipient.pub`](../backup/recipient.pub). Protect the corresponding private key in a separate secret store, with an additional recovery copy outside the application host and backup account. Losing that key makes the encrypted dumps unrecoverable. A database backup does not replace a backup of required application secrets or signing keys.

## Check a backup

1. Check the scheduled job's latest completion. A successful run ends with `Encrypted backup uploaded and size-checked`.
2. Confirm a new encrypted object exists for the expected date, with a plausible non-zero size.
3. Periodically download an object to a protected local directory, decrypt it with the recovery key, and inspect the archive with `pg_restore --list`.
4. Restore into a new disposable database and verify schema, durable intents, and application data before relying on that recovery path.

Do not restore over the live database during a routine check. A recovery cutover requires an explicit operator decision and reconciliation of chain activity since the snapshot.

## Recorded coverage and limits

Manual and scheduled encrypted dump/restore checks passed during initial setup. Automatic runs were verified on September 25 and 26, 2026, including after database credential rotation. Those dated observations do not establish the latest job's health; check current job results and stored objects.

Automatic backup-failure notifications are not configured. Monitor scheduled completion and test key recovery separately. Keep plaintext dumps, decryption keys, and downloaded archives out of Git and deployment uploads.
