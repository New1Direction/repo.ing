-- Apply after selected-hook-setup. Optional compiler economics belong to the
-- original creator request, not just to a later custody reservation.
alter table hook_lab_launch_requests add column selected_economics jsonb;
alter table hook_lab_launch_requests add constraint hook_lab_selected_economics_check check (
 selected_economics is null or (selected_hook is not null and jsonb_typeof(selected_economics)='object')
);
create function hook_lab_selected_economics_immutable() returns trigger language plpgsql as $$
begin
 if new.selected_economics is distinct from old.selected_economics
 then raise exception 'Selected-hook economics are immutable'; end if;
 return new;
end $$;
create trigger hook_lab_selected_economics_immutable before update on hook_lab_launch_requests
 for each row execute function hook_lab_selected_economics_immutable();
