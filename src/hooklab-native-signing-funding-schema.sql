-- Customer wallet funding for Hook Lab trades: add SOL (create holdings + wrap) and withdraw SOL (unwrap).
-- Same signing lifecycle and receipt rules as trades; only the allowed stage list grows.
alter table hook_lab_native_signing_operations drop constraint if exists hook_lab_native_signing_operations_stage_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_stage_check
 check(stage in ('preparation','launch','inclusive-buy','inclusive-sell','wallet-fund','wallet-withdraw'));
