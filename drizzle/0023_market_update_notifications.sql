-- Invalidation hints only, delivered by Postgres after the index transaction commits.
-- No balances, prices, signatures or private data travel through this channel.
CREATE FUNCTION repoing_notify_market_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  canonical_mint text;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME = 'trade_events' THEN
    SELECT mint INTO canonical_mint FROM markets WHERE pool = row_data->>'pool'
      AND status = 'confirmed' AND indexed_at IS NOT NULL AND launch_finality = 'finalized';
  ELSE
    SELECT mint INTO canonical_mint FROM markets WHERE github_repo_id = (row_data->>'github_repo_id')::bigint
      AND status = 'confirmed' AND indexed_at IS NOT NULL AND launch_finality = 'finalized';
  END IF;
  IF canonical_mint IS NOT NULL THEN
    PERFORM pg_notify('repoing_market_updates', json_build_object('mint', canonical_mint,
      'kind', CASE WHEN TG_TABLE_NAME = 'graduation_observations' THEN 'curve' ELSE 'trade' END)::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repoing_trade_update AFTER INSERT OR UPDATE OR DELETE ON trade_events
FOR EACH ROW EXECUTE FUNCTION repoing_notify_market_update();
--> statement-breakpoint
CREATE TRIGGER repoing_damm_update AFTER INSERT OR UPDATE OR DELETE ON damm_trade_events
FOR EACH ROW EXECUTE FUNCTION repoing_notify_market_update();
--> statement-breakpoint
CREATE TRIGGER repoing_curve_update AFTER INSERT OR UPDATE OR DELETE ON graduation_observations
FOR EACH ROW EXECUTE FUNCTION repoing_notify_market_update();
