import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule,h,html } from './fixtures/render-jsx.mjs'

const { HookOwnerApprovedLaunch,RequestStatus,coinProblem } = await appModule('app/components/hooklab-launch-request.jsx')
const { HookNativeLaunch } = await appModule('app/components/hooklab-native-launch.jsx')
const genesisHash='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const request={id:'6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10',name:'Repo Cat',symbol:'RCAT',uri:'https://repo.ing/api/hook-lab/coins/6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10/metadata',
 creatorFeeBps:100,capBps:200,status:'queued',inviteExpiresAt:null,profile:{description:'The cat that ships.',x:'repocat',website:'https://repo.ing/',telegram:null}}

test('a first-time creator sees one launch form in plain words: coin, image, links, rules, then one button',()=>{
 const markup=html(h(HookOwnerApprovedLaunch,{genesisHash}),{wallet:true})
 for(const text of [/Your coin/,/Coin name/,/Ticker/,/Add your coin image/,/Description/,/Links/,/X<\/span>/,/Website<\/span>/,/Telegram<\/span>/,
  /Max per wallet/,/Creator fee/,/How launching works/,/Keep about 0\.05 SOL/,/You earn/,/Sign in and request launch/,/Free to request|Add a name, ticker and image/])
  assert.match(markup,text)
 assert.match(markup,/<button type="button" aria-pressed="true">2%<\/button>/,'2% wallet cap by default')
 assert.match(markup,/<button type="button" aria-pressed="true">1%<\/button>/,'1% creator fee by default')
 assert.match(markup,/<button type="button" aria-pressed="false">0\.5%<\/button>/)
 assert.match(markup,/<button type="button" aria-pressed="false">5%<\/button>/)
 assert.match(markup,/<li data-state="current" aria-current="step"><span>1<\/span>Your coin<\/li>/)
 assert.doesNotMatch(markup,/basis points|Virtual quote|Internal label|Metadata HTTPS URL|server gates|AWAITING_OWNER_INVITE|Resume your operation/)
})

test('the creator is told exactly what is missing before anything is sent',()=>{
 const coin={name:'Repo Cat',symbol:'RCAT',image:'data:image/png;base64,AAAA',description:'',x:'',website:'',telegram:'',creatorFeeBps:100,capBps:200}
 assert.equal(coinProblem(coin),'')
 assert.equal(coinProblem({...coin,name:'  '}),'Give your coin a name.')
 assert.equal(coinProblem({...coin,symbol:''}),'Choose a ticker.')
 assert.equal(coinProblem({...coin,image:null}),'Add a coin image.')
 assert.match(coinProblem({...coin,x:'not a handle'}),/X account/)
})

test('request status: waiting, invited and live each say what happens next',()=>{
 const queued=html(h(RequestStatus,{request,online:true,onCancel(){},onAnother(){}}))
 assert.match(queued,/Waiting for approval/);assert.match(queued,/approvals are online now/);assert.match(queued,/Cancel request/)
 assert.match(queued,/\$RCAT/);assert.match(queued,/src="\/api\/hook-lab\/coins\/6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10\/image\?w=128"/)
 assert.match(queued,/href="https:\/\/x\.com\/repocat"/)
 const invited=html(h(RequestStatus,{request:{...request,status:'invited',inviteExpiresAt:new Date(Date.now()+600_000).toISOString()},online:true,onCancel(){},onAnother(){}}))
 assert.match(invited,/You’re invited\. Launch \$RCAT now\./);assert.match(invited,/Cancel request/)
 const live=html(h(RequestStatus,{request:{...request,status:'launched'},online:true,onCancel(){},onAnother(){}}))
 assert.match(live,/\$RCAT is live/);assert.match(live,/href="\/hooks\/trade">Buy or sell/);assert.match(live,/Launch another coin/);assert.doesNotMatch(live,/Cancel request/)
 const legacy=html(h(RequestStatus,{request:{...request,profile:null},online:false,onCancel(){},onAnother(){}}))
 assert.doesNotMatch(legacy,/\/image\?w=128/,'requests from before profiles show the placeholder');assert.match(legacy,/offline right now/)
})

test('an invited coin launches through guided steps, with the technical review and recovery IDs folded away',()=>{
 const markup=html(h(HookNativeLaunch,{genesisHash,approvedIntent:{name:'Repo Cat',symbol:'RCAT',uri:request.uri,creatorFeeBps:50,capBps:300}}),{wallet:true})
 for(const text of [/Reserve address/,/Sign preparation/,/Sign launch/,/Sign in with the wallet that sent the request/,/Recovery IDs/])assert.match(markup,text)
 assert.match(markup,/<details class="launch-customize hooks-recovery">/)
 assert.doesNotMatch(markup,/basis points|Virtual quote|Internal label|Metadata HTTPS URL|Launch steps|Waiting for repo\.ing’s invite/)
})

test('without owner-approved launches the operator launch form is unchanged',()=>{
 const markup=html(h(HookNativeLaunch,{genesisHash}),{wallet:true})
 assert.doesNotMatch(markup,/Request a launch|AWAITING_OWNER_INVITE|Recovery IDs/)
 for(const text of [/Reserve mint and check availability/,/Maximum wallet cap \(basis points\)/,/Virtual quote \(integer base units\)/,/Resume your operation/])assert.match(markup,text)
})
