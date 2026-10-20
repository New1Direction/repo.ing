-- Apply after selected-hook-requests. This permits durable selected launch recovery,
-- not execution authority: the runtime still requires adopted pins and consent.
alter table hook_lab_launch_requests drop constraint hook_lab_launch_requests_selected_review_only;
alter table hook_lab_launch_requests add constraint hook_lab_launch_requests_selected_execution check (
 selected_hook is null or (
  source='open' and
  ((status in ('queued','cancelled') and custody_operation_id is null) or
   (status in ('launching','launched') and custody_operation_id is not null))
 )
);
