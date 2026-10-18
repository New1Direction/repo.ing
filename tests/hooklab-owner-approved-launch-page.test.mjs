import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule,h,html } from './fixtures/render-jsx.mjs'

const { HookOwnerApprovedLaunch } = await appModule('app/components/hooklab-launch-request.jsx')
const { HookNativeLaunch } = await appModule('app/components/hooklab-native-launch.jsx')

test('owner-approved launch page queues a request first and prepares nothing before the invite',()=>{
 const markup=html(h(HookOwnerApprovedLaunch,{genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}),{wallet:true})
 assert.match(markup,/Request a launch/)
 assert.match(markup,/Checking repo\.ing approvals/)
 assert.match(markup,/Queuing a request creates no token and asks for no signature/)
 assert.match(markup,/Preparation starts after repo\.ing invites your coin\. \(AWAITING_OWNER_INVITE\)/)
})

test('invited coin details are shown locked in the existing launch form',()=>{
 const markup=html(h(HookNativeLaunch,{genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',approvedIntent:{name:'Canary Coin',symbol:'CNRY',uri:'https://repo.ing/m.json'}}),{wallet:true})
 for(const value of ['Canary Coin','CNRY','https://repo.ing/m.json']){
  const input=markup.match(new RegExp(`<input[^>]*value="${value.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')}"[^>]*>`))?.[0]
  assert.ok(input,`input for ${value} rendered`);assert.match(input,/disabled=""/,`${value} is locked`)
 }
})

test('without owner-approved launches the original launch form is unchanged',()=>{
 const markup=html(h(HookNativeLaunch,{genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}),{wallet:true})
 assert.doesNotMatch(markup,/Request a launch|AWAITING_OWNER_INVITE/)
 assert.match(markup,/Reserve mint and check availability/)
})
