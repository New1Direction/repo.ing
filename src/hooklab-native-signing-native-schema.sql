-- Native-SOL trades and creator claims (src/hooklab-native-pins.mjs): swap_v2 buys and sells, and
-- claim_creator_fees_sol. Same signing lifecycle and receipt rules; only the allowed stage list grows.
alter table hook_lab_native_signing_operations drop constraint if exists hook_lab_native_signing_operations_stage_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_stage_check
 check(stage in ('preparation','launch','inclusive-buy','inclusive-sell','wallet-fund','wallet-withdraw','native-buy','native-sell','native-claim'));
