import { assertGithubRepoId } from './market-identity.mjs'

// Public release metadata requires no extra GitHub App permissions. Cache both
// releases and misses, share in-flight work, and honor the public API's budget.
export function createReleaseReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache=new Map(), pending=new Map()
  let retryAt=0, windowStart=0, requests=0
  async function latest(repo) {
    if(!/^[1-9]\d*$/.test(String(repo.repoId))||!repo.owner||!repo.name)return null
    assertGithubRepoId(repo.repoId)
    const key=`${repo.repoId}:${repo.owner}/${repo.name}`
    const previous=cache.get(key)
    if(previous?.expires>now())return previous.value
    if(pending.has(key))return pending.get(key)
    if(now()-windowStart>=3600000){windowStart=now();requests=0}
    if(retryAt>now()||requests>=40)return previous?.value??null
    const job=(async()=>{
      requests++
      try {
        const response=await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases/latest`,{
          headers:{Accept:'application/vnd.github+json','User-Agent':'repo.ing-release-display','X-GitHub-Api-Version':'2022-11-28',...(previous?.etag?{'If-None-Match':previous.etag}:{})},signal:AbortSignal.timeout(2500)})
        if(response.status===403||response.status===429){
          retryAt=Math.max(now()+60000,Number(response.headers.get('x-ratelimit-reset')||0)*1000,now()+Number(response.headers.get('retry-after')||0)*1000)
          return previous?.value??null
        }
        if(response.status===304&&previous){previous.expires=now()+3600000;return previous.value}
        if(!response.ok&&response.status!==404)return previous?.value??null
        let value=null
        if(response.ok){
          const release=await response.json()
          const expected=`https://github.com/${repo.owner}/${repo.name}/releases/tag/`
          if(typeof release.html_url==='string'&&release.html_url.startsWith(expected)&&!release.draft&&!release.prerelease&&
             typeof release.tag_name==='string'&&Number.isFinite(Date.parse(release.published_at))){value={tag:release.tag_name.slice(0,100),url:release.html_url,publishedAt:release.published_at}}
        }
        if(cache.size>=1000)cache.delete(cache.keys().next().value)
        cache.set(key,{value,etag:response.headers.get('etag'),expires:now()+3600000})
        return value
      }catch{return previous?.value??null}finally{pending.delete(key)}
    })()
    pending.set(key,job);return job
  }
  return {latest}
}
