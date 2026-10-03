export const launchDraftKey=repoId=>`repoing:launch-draft:v1:${repoId}`
// quoteAssetId: the chosen pair ("sol" or a stock asset id, docs/STOCK_QUOTES.md); drafts saved before pairs existed are SOL.
const PAIR=/^(sol|[a-z0-9][a-z0-9-]{1,31})$/
export function readLaunchDraft(storage,repoId,now=Date.now()){
 try{
  const d=JSON.parse(storage.getItem(launchDraftKey(repoId)))
  if(!d||d.repoId!==String(repoId)||!Number.isFinite(d.savedAt)||now-d.savedAt>86400000||d.savedAt>now||
    typeof d.name!=='string'||d.name.length>32||typeof d.symbol!=='string'||!/^[A-Z0-9]{0,10}$/.test(d.symbol)||
    !['none','100','200','300','custom'].includes(d.choice)||typeof d.customBuy!=='string'||d.customBuy.length>30)return null
  const quoteAssetId=d.quoteAssetId??'sol'
  if(typeof quoteAssetId!=='string'||!PAIR.test(quoteAssetId))return null
  const image=d.tokenImage
  if(image&&(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.image)||image.image.length>600000))return null
  return {name:d.name,symbol:d.symbol,choice:d.choice,customBuy:d.customBuy,quoteAssetId,tokenImage:image?{image:image.image,label:String(image.label||'Your image').slice(0,80)}:null}
 }catch{return null}
}
export function saveLaunchDraft(storage,repoId,fields,now=Date.now()){
 try{storage.setItem(launchDraftKey(repoId),JSON.stringify({repoId:String(repoId),savedAt:now,name:fields.name,symbol:fields.symbol,choice:fields.choice,customBuy:fields.customBuy,quoteAssetId:fields.quoteAssetId??'sol',tokenImage:fields.tokenImage?{image:fields.tokenImage.image,label:fields.tokenImage.label}:null}));return true}catch{return false}
}
// The pair a restored draft launches with: its saved pair while this repository is still offered it, else SOL, with
// pairDropped set so the form says so (a stock launch never silently becomes SOL).
export function restoredPair(saved,offeredStockId){
 const quoteAssetId=saved?.quoteAssetId??'sol'
 if(quoteAssetId==='sol'||quoteAssetId===offeredStockId)return {quoteAssetId,pairDropped:false}
 return {quoteAssetId:'sol',pairDropped:true}
}
