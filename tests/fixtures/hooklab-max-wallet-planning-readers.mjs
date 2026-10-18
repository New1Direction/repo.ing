// Injected synthetic RPC responses only; never live evidence.
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { planMaxWalletPreparation } from '../../src/hooklab-max-wallet-preparation.mjs'
export function fakePlanningReaders(fixture,mutate=()=>{}){
 return fixture.observations.map((o,i)=>({provider:o.provider,connection:{
  async getGenesisHash(){return o.genesisHash},
  async getMultipleAccountsInfoAndContext(keys,config){assert.equal(config.commitment,'finalized');assert.deepEqual(keys.map(x=>x.toBase58()),o.accounts.map(x=>x.address));return {context:{slot:o.slot},value:o.accounts.map(x=>x.account&&{owner:new PublicKey(x.account.owner),executable:x.account.executable,lamports:Number(x.account.lamports),data:Buffer.from(x.account.dataBase64,'base64')})}},
  async getMinimumBalanceForRentExemption(size,commitment){assert.equal(commitment,'finalized');return Number(o.rentExemptionLamports[{85:'policy',81:'registry',176:'selectedConfig'}[size]])},
  async getLatestBlockhashAndContext(config){assert.equal(config.commitment,'finalized');return {context:{slot:o.slot},value:{blockhash:fixture.recentBlockhash.blockhash,lastValidBlockHeight:fixture.recentBlockhash.lastValidBlockHeight}}},
  async isBlockhashValid(blockhash,config){assert.equal(blockhash,fixture.recentBlockhash.blockhash);assert.equal(config.commitment,'finalized');const out={context:{slot:o.slot},value:true};mutate('valid',out,i);return out},
  async getBlockHeight(config){assert.equal(config.commitment,'finalized');return fixture.recentBlockhash.currentBlockHeight},
  async getFeeForMessage(message,commitment){assert.equal(commitment,'finalized');assert.equal(Buffer.from(message.serialize()).toString('base64'),planMaxWalletPreparation(fixture).review.messageBase64);const out={context:{slot:o.slot},value:Number(fixture.recentBlockhash.networkFeeLamports)};mutate('fee',out,i);return out},
 }}))
}
