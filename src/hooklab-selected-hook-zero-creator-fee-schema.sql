-- Apply after selected-hook-requests. Only selected hooks may have a zero creator fee.
-- Keep the bootstrap and all other request protections unchanged; no rows are rewritten.
-- Rollback to the old check requires no zero-fee rows. Selected intent is immutable:
-- do not rewrite or delete accepted requests to make an old application/schema fit.
alter table hook_lab_launch_requests
 drop constraint hook_lab_launch_requests_creator_fee_bps_check,
 add constraint hook_lab_launch_requests_creator_fee_bps_check check (
  creator_fee_bps between 1 and 9999 or
  (selected_hook is not null and creator_fee_bps=0)
 );
