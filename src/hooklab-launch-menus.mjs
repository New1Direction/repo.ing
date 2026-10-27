// Gate creator choices for the first release. Selected hooks use the live chain ceiling instead.
// Platform share is not a choice: platform = floor(gross creator fee / 4), creator = remainder.
export const CREATOR_FEE_BPS_CHOICES=Object.freeze([50,100,200])
export const DEFAULT_CREATOR_FEE_BPS=100
export const WALLET_CAP_BPS_CHOICES=Object.freeze([100,200,300,500])
export const DEFAULT_WALLET_CAP_BPS=200
// The launch config ceilings that make the largest fee choice valid on chain.
export const CREATOR_FEE_CEILING_BPS=Math.max(...CREATOR_FEE_BPS_CHOICES)

export const percent=bps=>`${bps/100}%`

// The open-creation projection exposes the lower of the creator and rules ceilings. Selected hooks, and every launch on a
// chain with no fee menu (continuousCreatorFee: the independent stack retired it), take any whole fee up to that ceiling.
export function isOpenCreatorFeeChoice({creatorFeeBps,selectedHook,policyKind},menus){
 return Number.isInteger(creatorFeeBps)&&creatorFeeBps>=0&&
  (selectedHook||policyKind==='selected-hook'||menus.continuousCreatorFee===true?Number.isInteger(menus.maxCreatorFeeBps)&&creatorFeeBps<=menus.maxCreatorFeeBps:menus.creatorFeeBps.includes(creatorFeeBps))
}

// A profile without menus keeps its single reviewed fee and any cap the program accepts.
export function approvedCreatorFees(profile){
 const capability=profile.capability
 return capability.creatorFeeBpsChoices??[capability.creatorFeeBps]
}
export function approvedWalletCaps(profile){
 return profile.capability.capBpsChoices??null
}
export function isApprovedLaunchChoice(profile,{creatorFeeBps,capBps}){
 const caps=approvedWalletCaps(profile)
 return approvedCreatorFees(profile).includes(creatorFeeBps)&&(caps===null||caps.includes(capBps))
}
// A launched coin's creator fee, for trading: on the reviewed menu, or any whole fee the open route allows (the one total
// of 10%; the program checked it against the chain's ceiling at launch, and every trade binds it to the coin's accounts).
export const isTradableCreatorFee=(profile,creatorFeeBps)=>approvedCreatorFees(profile).includes(creatorFeeBps)
 ||Number.isInteger(creatorFeeBps)&&creatorFeeBps>=0&&creatorFeeBps<=1000
// The fee and cap a gate preparation may take. chainMenus: the launch Config's open-creation state (parseLaunchConfigReserved).
// With open creation on and no fee menu on chain, the chain governs the fee: any whole fee (the compiler checks the chain's
// ceiling) with an approved cap. Otherwise the reviewed profile's menus.
export function isPreparableLaunchChoice(profile,{creatorFeeBps,capBps},chainMenus=null){
 if(!(chainMenus?.open===true&&chainMenus.creatorFeeBps.length===0))return isApprovedLaunchChoice(profile,{creatorFeeBps,capBps})
 const caps=approvedWalletCaps(profile)
 return Number.isInteger(creatorFeeBps)&&creatorFeeBps>=0&&(caps===null||caps.includes(capBps))
}
