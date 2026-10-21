-- Apply after native signer custody and preparation-request migrations.
alter table hook_lab_native_signer_custody add column selected_authority_evidence jsonb;
create function hook_lab_selected_authority_immutable() returns trigger language plpgsql as $$
begin
 if old.selected_authority_evidence is not null and new.selected_authority_evidence is distinct from old.selected_authority_evidence
 then raise exception 'Selected hook authority evidence is immutable'; end if;
 if old.selected_authority_evidence is null and new.selected_authority_evidence is not null and old.stage <> 'reserved'
 then raise exception 'Selected authority must be retained before consent'; end if;
 return new;
end $$;
create trigger hook_lab_selected_authority_immutable before update on hook_lab_native_signer_custody
 for each row execute function hook_lab_selected_authority_immutable();
