-- Coin profile for owner-approved launches: the image, description and links a creator adds when
-- queuing a launch request. Written once with the request and never changed, so the metadata repo.ing
-- serves at the request's uri stays what the owner reviewed. Same database as hook_lab_launch_requests.
create table hook_lab_coin_profiles (
 request_id uuid primary key references hook_lab_launch_requests(id),
 -- 512 x 512 PNG data URL from src/token-image.mjs: at most 384 KB of PNG, base64 plus the 22-byte prefix.
 image text not null check(image like 'data:image/png;base64,%' and octet_length(image)<=524310),
 description text not null check(char_length(description)<=280),
 x_handle text check(x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
 website text check(octet_length(website)<=200 and website like 'https://%'),
 telegram text check(telegram ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'),
 created_at timestamptz not null default clock_timestamp()
);
create function hook_lab_coin_profile_immutable() returns trigger language plpgsql as $$
begin raise exception 'Coin profiles are immutable'; end $$;
create trigger hook_lab_coin_profile_immutable before update or delete on hook_lab_coin_profiles
 for each row execute function hook_lab_coin_profile_immutable();
