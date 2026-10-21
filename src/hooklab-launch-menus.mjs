// Gate creator choices for the first release. Selected hooks use the live chain ceiling instead.
// Platform share is not a choice: platform = floor(gross creator fee / 4), creator = remainder.
export const CREATOR_FEE_BPS_CHOICES=Object.freeze([50,100,200])
export const DEFAULT_CREATOR_FEE_BPS=100
export const WALLET_CAP_BPS_CHOICES=Object.freeze([100,200,300,500])
export const DEFAULT_WALLET_CAP_BPS=200
// The launch config ceilings that make the largest fee choice valid on chain.
export const CREATOR_FEE_CEILING_BPS=Math.max(...CREATOR_FEE_BPS_CHOICES)

export const percent=bps=>`${bps/100}%`

// The open-creation projection exposes the lower of the creator and rules ceilings.
export function isOpenCreatorFeeChoice({creatorFeeBps,selectedHook,policyKind},menus){
 return Number.isInteger(creatorFeeBps)&&creatorFeeBps>=0&&
  (selectedHook||policyKind==='selected-hook'?Number.isInteger(menus.maxCreatorFeeBps)&&creatorFeeBps<=menus.maxCreatorFeeBps:menus.creatorFeeBps.includes(creatorFeeBps))
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
