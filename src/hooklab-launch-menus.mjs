// Owner-approved creator choices for the first release. The production profile carries these
// menus; every server check, the launch UI and the owner agent use the same values.
// Platform share is not a choice: platform = floor(gross creator fee / 4), creator = remainder.
export const CREATOR_FEE_BPS_CHOICES=Object.freeze([50,100,200])
export const DEFAULT_CREATOR_FEE_BPS=100
export const WALLET_CAP_BPS_CHOICES=Object.freeze([100,200,300,500])
export const DEFAULT_WALLET_CAP_BPS=200
// The launch config ceilings that make the largest fee choice valid on chain.
export const CREATOR_FEE_CEILING_BPS=Math.max(...CREATOR_FEE_BPS_CHOICES)

export const percent=bps=>`${bps/100}%`

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
