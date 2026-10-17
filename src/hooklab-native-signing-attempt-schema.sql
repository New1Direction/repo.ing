-- Apply after signing schema. Every signer invocation gets a durable single-use claim.
alter table hook_lab_native_signing_operations drop constraint hook_lab_native_signing_operations_status_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_status_check check(status in
 ('reviewed','partial','signed','signing-claimed','signing-unknown','submission-claimed','outcome-unknown','submitted','finalized-success','finalized-failure','review-required'));
alter table hook_lab_native_signing_operations add column pending_signer text;
create table hook_lab_native_signing_attempts (
 operation_id uuid not null references hook_lab_native_signing_operations(id),
 signer_address text not null,
 message_sha256 text not null,
 status text not null check(status in ('claimed','unknown','completed')),
 claimed_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,
 primary key(operation_id,signer_address)
);
