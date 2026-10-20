-- Apply after open-launches. Recording a custom coin is not execution approval.
alter table hook_lab_launch_requests add column selected_hook jsonb;
alter table hook_lab_launch_requests drop constraint hook_lab_launch_requests_cap_bps_check;
alter table hook_lab_launch_requests add constraint hook_lab_launch_requests_hook_config_check check (
 (selected_hook is null and cap_bps between 1 and 9999) or
 (selected_hook is not null and source='open' and cap_bps=0
  and jsonb_typeof(selected_hook)='object'
  and selected_hook=jsonb_build_object('program',selected_hook->'program','flags',selected_hook->'flags')
  and jsonb_typeof(selected_hook->'program')='string'
  and selected_hook->>'program' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  and selected_hook->>'program'<>'11111111111111111111111111111111'
  and jsonb_typeof(selected_hook->'flags')='number'
  and (selected_hook->>'flags')::numeric between 1 and 255
  and (selected_hook->>'flags')::numeric=trunc((selected_hook->>'flags')::numeric))
);
-- Keep the execution boundary closed until selected-hook signing/settlement is adopted.
alter table hook_lab_launch_requests add constraint hook_lab_launch_requests_selected_review_only check (
 selected_hook is null or (status in ('queued','cancelled') and custody_operation_id is null)
);
create function hook_lab_selected_request_immutable() returns trigger language plpgsql as $$
begin
 if (old.selected_hook is not null or new.selected_hook is not null) and
 row(new.id,new.creator_wallet,new.name,new.symbol,new.uri,new.creator_fee_bps,new.cap_bps,new.selected_hook,new.source,new.created_at)
 is distinct from row(old.id,old.creator_wallet,old.name,old.symbol,old.uri,old.creator_fee_bps,old.cap_bps,old.selected_hook,old.source,old.created_at)
 then raise exception 'Selected-hook coin intent is immutable'; end if;
 return new;
end $$;
create trigger hook_lab_selected_request_immutable before update on hook_lab_launch_requests
 for each row execute function hook_lab_selected_request_immutable();
