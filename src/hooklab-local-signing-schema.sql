-- Never apply this local acceptance extension to an application/production database.
do $$ begin
 if current_database() !~ '^hooks_local(_[a-z0-9_]+)?$' then
  raise exception 'Local signing stages require the disposable hooks_local database';
 end if;
end $$;
alter table hook_lab_native_signing_operations drop constraint hook_lab_native_signing_operations_stage_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_stage_check
 check(stage in ('preparation','launch','inclusive-buy','inclusive-sell','local-prepare-holding','local-inclusive-collection'));
