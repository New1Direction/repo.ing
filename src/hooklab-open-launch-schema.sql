-- Self-serve (open) launches and coin moderation. Apply with the "open-launches" migration before HOOK_OPEN_LAUNCHES=true.
-- An open request is the creator's own: no invite, so many creators may launch at once (each wallet still has at most one
-- open request, hook_lab_launch_requests_open_per_creator). The one-at-a-time rule stays for owner invites, whose creator
-- grants bump the launch governance revision and would stale another creator's review.
alter table hook_lab_launch_requests add column source text not null default 'owner-invite' check(source in ('owner-invite','open'));
drop index hook_lab_launch_requests_single_invite;
create unique index hook_lab_launch_requests_single_invite on hook_lab_launch_requests((true)) where status in ('invited','launching') and source='owner-invite';

-- Owner moderation, append-only: the latest row for a coin is its state. A delisted coin leaves discovery, its page shows
-- the reason, and buying is turned off on the site; selling and the creator's fee claim always keep working.
create table hook_lab_coin_moderation (
 id bigserial primary key,
 request_id uuid not null references hook_lab_launch_requests(id),
 action text not null check(action in ('delist','relist')),
 -- One of the owner's delisting reasons (src/hooklab-coin-moderation.mjs); null when relisting.
 reason text check(reason is null or (octet_length(reason) between 1 and 200)),
 decided_by text not null check(octet_length(decided_by) between 1 and 64),
 decided_at timestamptz not null default clock_timestamp(),
 check((action='delist')=(reason is not null))
);
create index hook_lab_coin_moderation_latest on hook_lab_coin_moderation(request_id,id desc);
create function hook_lab_coin_moderation_immutable() returns trigger language plpgsql as $$
begin raise exception 'Coin moderation records are append-only'; end $$;
create trigger hook_lab_coin_moderation_immutable before update or delete on hook_lab_coin_moderation
 for each row execute function hook_lab_coin_moderation_immutable();
