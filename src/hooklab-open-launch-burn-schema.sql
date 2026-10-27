-- Apply after open-launches and selected-hook-zero-creator-fee, before HOOK_BURN_ENABLED=true (owner design 2026-10-27).
-- An open gate coin may burn a share of every trade's coins (a token burn, never a buyback): burn_bps, the same on both
-- sides, fixed when the coin is created. Its creator fee plus the burn is one total fee of at most 10%, so an open coin
-- may also take no creator fee (all burn, or a 0% total). Additive: existing rows get 0 (no burn) and are not rewritten.
-- Rollback (dropping the column, restoring the old creator-fee check) is safe only while no row has a burn or an open
-- zero creator fee; never rewrite or delete accepted requests to make an old application fit.
alter table hook_lab_launch_requests
 add column burn_bps integer not null default 0 check (burn_bps between 0 and 1000),
 add constraint hook_lab_launch_requests_burn_check check (
  burn_bps=0 or (source='open' and selected_hook is null and creator_fee_bps+burn_bps<=1000)
 ),
 drop constraint hook_lab_launch_requests_creator_fee_bps_check,
 add constraint hook_lab_launch_requests_creator_fee_bps_check check (
  creator_fee_bps between 1 and 9999 or
  (selected_hook is not null and creator_fee_bps=0) or
  (source='open' and creator_fee_bps=0)
 );
create function hook_lab_burn_immutable() returns trigger language plpgsql as $$
begin
 if new.burn_bps is distinct from old.burn_bps then raise exception 'A coin''s burn is immutable'; end if;
 return new;
end $$;
create trigger hook_lab_burn_immutable before update on hook_lab_launch_requests
 for each row execute function hook_lab_burn_immutable();
