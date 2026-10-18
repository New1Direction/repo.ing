-- Apply after the refresh schema. A signed-but-never-sent operation whose blockhash can no longer
-- land is closed as 'expired' and kept forever; its custody stage reopens for a completely fresh
-- review and fresh signatures. Only non-expired operations count toward one live operation per stage.
alter table hook_lab_native_signing_operations drop constraint hook_lab_native_signing_operations_status_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_status_check check(status in
 ('reviewed','partial','signed','signing-claimed','signing-unknown','submission-claimed','outcome-unknown','submitted','finalized-success','finalized-failure','review-required','expired'));
alter table hook_lab_native_signing_operations add column expired_evidence jsonb;
alter table hook_lab_native_signing_operations add constraint signing_expiry_evidence check((status='expired')=(expired_evidence is not null));
do $$ declare name text; begin
 select conname into strict name from pg_constraint
  where conrelid='hook_lab_native_signing_operations'::regclass and contype='u'
   and pg_get_constraintdef(oid)='UNIQUE (custody_operation_id, stage)';
 execute format('alter table hook_lab_native_signing_operations drop constraint %I',name);
end $$;
create unique index hook_lab_native_signing_live_stage on hook_lab_native_signing_operations(custody_operation_id,stage) where status<>'expired';
create function hook_lab_native_signing_expiry_guard() returns trigger language plpgsql as $$
begin
 if old.status='expired' then raise exception 'Expired signing operations are final'; end if;
 if new.status='expired' and (old.status not in ('reviewed','partial','signed','signing-claimed','signing-unknown')
   or old.signature is not null or new.signature is not null
   or (new.expired_evidence->>'blockHeight')::bigint<=(old.review->>'lastValidBlockHeight')::bigint
   or (new.expired_evidence->>'slot')::bigint<=(old.review->>'validUntilSlot')::bigint)
 then raise exception 'Only a never-sent operation past its blockhash and deadline can expire'; end if;
 return new;
end $$;
create trigger hook_lab_native_signing_expiry_guard before update on hook_lab_native_signing_operations
 for each row execute function hook_lab_native_signing_expiry_guard();
