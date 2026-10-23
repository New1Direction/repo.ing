-- Forward-only, receipt bookkeeping; no imports, signatures, execution grants or jobs.
-- Register this migration in the deployment journal only after review/approval.
CREATE TABLE custody_collection_batches (
  signature varchar(88) PRIMARY KEY,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 2),
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  slot bigint NOT NULL CHECK (slot > 0),
  receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE custody_fee_payouts DROP CONSTRAINT custody_fee_payouts_collection_signature_fkey;
ALTER TABLE custody_fee_collections DROP CONSTRAINT custody_fee_collections_pkey;
ALTER TABLE custody_fee_collections
  ADD COLUMN item_index integer NOT NULL DEFAULT -1,
  ADD COLUMN phase text NOT NULL DEFAULT 'DAMM',
  ADD COLUMN batch_signature varchar(88) REFERENCES custody_collection_batches(signature),
  ALTER COLUMN position DROP NOT NULL,
  ADD PRIMARY KEY (signature,item_index),
  ADD CONSTRAINT custody_collection_item_shape CHECK (
    (phase='DAMM' AND item_index=-1 AND position IS NOT NULL AND batch_signature IS NULL)
    OR (phase='DBC' AND item_index BETWEEN 0 AND 1 AND position IS NULL AND batch_signature IS NOT NULL AND batch_signature=signature)
  );
ALTER TABLE custody_fee_payouts
  ADD COLUMN collection_item_index integer NOT NULL DEFAULT -1,
  ADD CONSTRAINT custody_payout_collection_item_fk FOREIGN KEY (collection_signature,collection_item_index)
    REFERENCES custody_fee_collections(signature,item_index);
--> statement-breakpoint
ALTER TABLE repo_claims DROP CONSTRAINT repo_claims_custody_evidence;
ALTER TABLE repo_claims ADD CONSTRAINT repo_claims_custody_evidence CHECK (
  (evidence_source='signed-intent' AND custody_payout_signature IS NULL)
  OR (evidence_source IN ('custody-receipt','custody-dbc-receipt') AND status='settled'
    AND signed_transaction IS NULL AND last_valid_block_height IS NULL
    AND damm_amount_base_units=CASE WHEN evidence_source='custody-receipt' THEN amount_base_units ELSE 0 END
    AND custody_payout_signature IS NOT NULL AND custody_payout_signature=claim_signature)
);
--> statement-breakpoint
-- A partially inserted batch must not commit even if an internal caller forgets an item.
CREATE FUNCTION custody_dbc_batch_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sig text; batch custody_collection_batches; n integer; total numeric; first_item integer; last_item integer;
BEGIN
  IF TG_TABLE_NAME='custody_collection_batches' THEN sig := NEW.signature;
  ELSE sig := CASE WHEN TG_OP='DELETE' THEN OLD.batch_signature ELSE NEW.batch_signature END;
  END IF;
  IF sig IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO batch FROM custody_collection_batches WHERE signature=sig;
  SELECT count(*),coalesce(sum(amount),0),min(item_index),max(item_index)
    INTO n,total,first_item,last_item FROM custody_fee_collections WHERE batch_signature=sig;
  IF batch.signature IS NULL OR n<>batch.item_count OR total<>batch.amount OR first_item<>0 OR last_item<>n-1 THEN
    RAISE EXCEPTION 'Incomplete DBC custody batch';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER custody_dbc_batch_header_complete AFTER INSERT OR UPDATE ON custody_collection_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION custody_dbc_batch_complete();
CREATE CONSTRAINT TRIGGER custody_dbc_batch_items_complete AFTER INSERT OR UPDATE OR DELETE ON custody_fee_collections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION custody_dbc_batch_complete();
--> statement-breakpoint
-- Retained execution evidence is append-only; corrections need an audited forward action.
CREATE FUNCTION custody_dbc_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='custody_collection_batches' THEN
    RAISE EXCEPTION 'DBC custody evidence is immutable';
  ELSIF TG_TABLE_NAME='custody_fee_collections' THEN
    IF OLD.phase='DBC' OR (TG_OP='UPDATE' AND NEW.phase='DBC') THEN
      RAISE EXCEPTION 'DBC custody evidence is immutable';
    END IF;
  ELSE
    IF OLD.collection_item_index>=0 OR (TG_OP='UPDATE' AND NEW.collection_item_index>=0) THEN
      RAISE EXCEPTION 'DBC custody evidence is immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_dbc_batch_immutable BEFORE UPDATE OR DELETE ON custody_collection_batches
  FOR EACH ROW EXECUTE FUNCTION custody_dbc_immutable();
CREATE TRIGGER custody_dbc_item_immutable BEFORE UPDATE OR DELETE ON custody_fee_collections
  FOR EACH ROW EXECUTE FUNCTION custody_dbc_immutable();
CREATE TRIGGER custody_dbc_payout_immutable BEFORE UPDATE OR DELETE ON custody_fee_payouts
  FOR EACH ROW EXECUTE FUNCTION custody_dbc_immutable();
