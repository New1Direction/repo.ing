#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"

export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true

umask 077
backup_file="$(mktemp /tmp/repo-ing-backup.XXXXXXXX.age)"
trap 'rm -f "$backup_file"' EXIT

backup_day="$(date -u +%Y-%m-%d)"
backup_key="daily/repo-ing-production-${backup_day}.dump.age"

# The dump is streamed to age; only encrypted bytes touch the filesystem.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges \
  | age -R /etc/repo-ing-backup-recipient.pub -o "$backup_file"

local_size="$(stat -c %s "$backup_file")"
if [[ "$local_size" -lt 100 ]]; then
  echo "Encrypted backup is unexpectedly small" >&2
  exit 1
fi

aws --endpoint-url "$R2_ENDPOINT" s3 cp "$backup_file" "s3://${R2_BUCKET}/${backup_key}" \
  --no-progress --content-type application/octet-stream >/dev/null

remote_size="$(aws --endpoint-url "$R2_ENDPOINT" s3api head-object \
  --bucket "$R2_BUCKET" --key "$backup_key" --query ContentLength --output text)"
if [[ "$remote_size" != "$local_size" ]]; then
  echo "R2 object size does not match encrypted backup" >&2
  exit 1
fi

echo "Encrypted backup uploaded and size-checked: ${backup_key} (${local_size} bytes)"
