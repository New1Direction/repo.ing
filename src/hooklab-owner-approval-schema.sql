-- Owner-approved launches. The admin key never reaches this server: the owner's Mac agent
-- polls these tables and returns admin signatures, which are verified against the admin address.
-- Same database as wallet principals, custody and native signing. Records are never erased.
create table hook_lab_owner_presence (
 id smallint primary key check(id=1),
 accepting boolean not null default false,
 agent_address text,
 last_seen_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
insert into hook_lab_owner_presence(id,accepting) values(1,false);

-- A creator's launch intent. No transaction is prepared until the owner invites it.
create table hook_lab_launch_requests (
 id uuid primary key,
 creator_wallet text not null,
 name text not null check(octet_length(name) between 1 and 32),
 symbol text not null check(octet_length(symbol) between 1 and 10),
 uri text not null check(octet_length(uri)<=200),
 creator_fee_bps integer not null check(creator_fee_bps between 1 and 9999),
 cap_bps integer not null check(cap_bps between 1 and 9999),
 status text not null check(status in ('queued','invited','launching','launched','declined','cancelled','invite-expired')),
 invited_at timestamptz,
 invite_expires_at timestamptz,
 custody_operation_id uuid unique,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check((status in ('invited','launching','launched','invite-expired'))=(invited_at is not null and invite_expires_at is not null))
);
-- One creator at a time: the creator grant bumps the governance revision, which would
-- invalidate any other creator's in-flight launch review.
create unique index hook_lab_launch_requests_single_invite on hook_lab_launch_requests((true)) where status in ('invited','launching');
create unique index hook_lab_launch_requests_open_per_creator on hook_lab_launch_requests(creator_wallet) where status in ('queued','invited','launching');

-- One admin-signature request per exact message. The signature is verified before storage.
create table hook_lab_owner_sign_requests (
 id uuid primary key,
 signer_address text not null,
 message_base64 text not null,
 message_sha256 text not null unique check(message_sha256 ~ '^[a-f0-9]{64}$'),
 context jsonb not null,
 valid_until_slot bigint not null,
 last_valid_block_height bigint not null,
 review_expires_at timestamptz not null,
 status text not null check(status in ('pending','signed','declined','expired')),
 signature text,
 created_at timestamptz not null default clock_timestamp(),
 decided_at timestamptz,
 check((status='signed')=(signature is not null)),
 check((status='pending')=(decided_at is null))
);
create function hook_lab_owner_sign_request_immutable() returns trigger language plpgsql as $$
begin
 if row(new.id,new.signer_address,new.message_base64,new.message_sha256,new.context,new.valid_until_slot,new.last_valid_block_height,new.review_expires_at,new.created_at)
 is distinct from row(old.id,old.signer_address,old.message_base64,old.message_sha256,old.context,old.valid_until_slot,old.last_valid_block_height,old.review_expires_at,old.created_at)
 then raise exception 'Owner sign request identity is immutable'; end if;
 if old.status<>'pending' then raise exception 'Owner sign request already decided'; end if;
 return new;
end $$;
create trigger hook_lab_owner_sign_request_immutable before update on hook_lab_owner_sign_requests
 for each row execute function hook_lab_owner_sign_request_immutable();

-- One address lookup table per prepared launch (a launch does not fit a packet without one).
-- The server records the exact inventory; the owner's Mac agent recomputes it, creates the table
-- with the admin key and reports the address; the server verifies the table on chain before use.
create table hook_lab_owner_table_requests (
 preparation_id uuid primary key,
 launch_request_id uuid not null unique references hook_lab_launch_requests(id),
 creator_wallet text not null,
 launch_request jsonb not null,
 inventory jsonb not null,
 inventory_sha256 text not null check(inventory_sha256 ~ '^[a-f0-9]{64}$'),
 status text not null check(status in ('requested','created','declined')),
 table_address text,
 issued_table_sha256 text check(issued_table_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 decided_at timestamptz,
 check((status='created')=(table_address is not null)),
 check((status='requested')=(decided_at is null)),
 check(issued_table_sha256 is null or status='created')
);
create function hook_lab_owner_table_request_immutable() returns trigger language plpgsql as $$
begin
 if row(new.preparation_id,new.launch_request_id,new.creator_wallet,new.launch_request,new.inventory,new.inventory_sha256,new.created_at)
 is distinct from row(old.preparation_id,old.launch_request_id,old.creator_wallet,old.launch_request,old.inventory,old.inventory_sha256,old.created_at)
 then raise exception 'Owner table request identity is immutable'; end if;
 if old.status<>'requested' and row(new.status,new.table_address) is distinct from row(old.status,old.table_address)
 then raise exception 'Owner table request already decided'; end if;
 if old.issued_table_sha256 is not null and new.issued_table_sha256 is distinct from old.issued_table_sha256
 then raise exception 'Issued launch lookup table is immutable'; end if;
 return new;
end $$;
create trigger hook_lab_owner_table_request_immutable before update on hook_lab_owner_table_requests
 for each row execute function hook_lab_owner_table_request_immutable();
