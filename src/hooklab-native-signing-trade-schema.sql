-- Explicit additional wallet-only operation families. Factory default stays launch-only.
alter table hook_lab_native_signing_operations drop constraint hook_lab_native_signing_operations_stage_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_stage_check
 check(stage in ('preparation','launch','inclusive-buy','inclusive-sell'));
