-- Public, non-signable estimate identity. Apply before selected-hook release/2 enablement.
create table hook_lab_selected_trade_quotes (
 quote_id uuid primary key,
 owner_wallet text not null,
 stage text not null check (stage in ('native-buy','native-sell')),
 configuration_sha256 text not null check (configuration_sha256 ~ '^[0-9a-f]{64}$'),
 intent jsonb not null check (jsonb_typeof(intent) = 'object' and not intent ? 'minAmountOut'),
 selected_authority_evidence jsonb not null check (jsonb_typeof(selected_authority_evidence) = 'object'),
 expires_at_ms bigint not null check (expires_at_ms > 0)
);
create function hook_lab_selected_quote_immutable() returns trigger language plpgsql as $$
begin
 raise exception 'Selected quote identity is immutable; request a new estimate';
end $$;
create trigger hook_lab_selected_quote_immutable before update on hook_lab_selected_trade_quotes
 for each row execute function hook_lab_selected_quote_immutable();
