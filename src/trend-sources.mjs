import { assertTrendIdentity, commitActivity, repoLink, DAY, TREND_FRESH_MS } from './trend-rules.mjs'

// Public, read-only endpoints. No credential is sent to a third-party source.
// Five repository refreshes + one search per half-hour <= 42 GitHub API calls/hour.
export function createTrendSources({ fetchImpl = fetch, now = () => Date.now(), pause = ms => new Promise(r => setTimeout(r,ms)) } = {}) {
  let nextRequest = 0, githubReset = 0
  async function request(url, { missing = false, html = false } = {}) {
    if (new URL(url).hostname === 'api.github.com' && githubReset > now()) throw Error('GITHUB_RATE_LIMITED')
    await pause(Math.max(0, nextRequest - now())); nextRequest = now() + 1000
    const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'repo.ing-trend-intake', Accept: html ? 'text/html' : 'application/json',
        ...(new URL(url).hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } })
    if (new URL(url).hostname === 'api.github.com' && (Number(response.headers.get('x-ratelimit-remaining') ?? 999) <= 5 || [403,429].includes(response.status))) {
      githubReset = Math.max(now()+60000, Number(response.headers.get('x-ratelimit-reset') || 0)*1000,
        now()+Number(response.headers.get('retry-after') || 0)*1000)
    }
    if (missing && [404,409].includes(response.status)) { await response.body?.cancel(); return { data: null, complete: true } }
    if (!response.ok) { await response.body?.cancel(); throw Error([403,429].includes(response.status) ? 'SOURCE_RATE_LIMITED' : 'SOURCE_UNAVAILABLE') }
    const data = html ? await response.text() : await response.json()
    return { data, complete: !response.headers.get('link')?.includes('rel="next"') }
  }
  async function seeds() {
    const collected = [], health = [], time = now()
    async function source(name, job) {
      try { const items = await job(); collected.push(...items); health.push({source:name,status:'OK',count:items.length}) }
      catch(error) { health.push({source:name,status:'UNAVAILABLE',error:error.message}) }
    }
    await source('github_trending', async () => {
      const url = 'https://github.com/trending?since=daily', {data} = await request(url,{html:true})
      const rows = [...data.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].flatMap(match => {
        const link = match[1].match(/href="(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/)
        return link ? [{ repository:repoLink(`https://github.com${link[1]}`),source:'github_trending',url,
          note:'Present on GitHub Trending (daily)',occurredAt:new Date(time).toISOString(),expiresAt:new Date(time+TREND_FRESH_MS).toISOString() }] : []
      })
      if (!rows.length) throw Error('TRENDING_MARKUP_UNAVAILABLE')
      return rows.slice(0,25)
    })
    await source('hn', async () => {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=github.com&restrictSearchableAttributes=url&numericFilters=created_at_i%3E${Math.floor((time-7*DAY)/1000)}&hitsPerPage=100`
      const {data} = await request(url)
      if (!Array.isArray(data.hits)) throw Error('INVALID_HN_RESPONSE')
      return data.hits.flatMap(hit => {
        try {
          const link=new URL(hit.url)
          if(link.protocol!=='https:'||link.hostname!=='github.com'||!/^\d+$/.test(hit.objectID))return []
          const repository=repoLink(`https://github.com/${link.pathname.split('/').filter(Boolean).slice(0,2).join('/')}`)
          const occurred=Number(hit.created_at_i)*1000
          if(!Number.isFinite(occurred)||occurred>time||occurred<time-7*DAY)return []
          return [{repository,source:'hn',url:`https://news.ycombinator.com/item?id=${hit.objectID}`,
            note:String(hit.title ?? 'Hacker News story').slice(0,300),occurredAt:new Date(occurred).toISOString(),expiresAt:new Date(occurred+7*DAY).toISOString()}]
        } catch { return [] }
      })
    })
    await source('github_search', async () => {
      const query=`stars:>=20 archived:false fork:false pushed:>=${new Date(time-7*DAY).toISOString().slice(0,10)} created:>=${new Date(time-90*DAY).toISOString().slice(0,10)}`
      const {data} = await request(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`)
      if(!Array.isArray(data.items)||data.incomplete_results)throw Error('INCOMPLETE_GITHUB_SEARCH')
      return data.items.map(repo => {assertTrendIdentity(repo);return {repository:repoLink(repo.html_url),expectedId:String(repo.id),source:'github_search',
        url:`https://github.com/search?q=${encodeURIComponent(query)}&type=repositories&s=stars&o=desc`,note:'Recent public repository: ≥20 stars, pushed in 7 days, created in 90 days',
        occurredAt:new Date(time).toISOString(),expiresAt:new Date(time+TREND_FRESH_MS).toISOString()} })
    })
    return { signals:collected,health }
  }
  async function observe(repository, expectedId) {
    const canonical = repoLink(repository), endpoint=`https://api.github.com/repos/${canonical.slice('https://github.com/'.length)}`
    // Redirects are rejected; a rename must be re-resolved by immutable ID.
    let repo
    if(expectedId) {
      const {data}=await request(`https://api.github.com/repositories/${expectedId}`)
      repo=assertTrendIdentity(data,expectedId)
    } else repo=assertTrendIdentity((await request(endpoint)).data)
    const secondIdentity=expectedId?`https://api.github.com/repos/${repo.full_name}`:`https://api.github.com/repositories/${repo.id}`
    const named=assertTrendIdentity((await request(secondIdentity)).data,repo.id)
    if(named.full_name!==repo.full_name)throw Error('SOURCE_IDENTITY_DISAGREEMENT')
    const nowMs=now(), base=`https://api.github.com/repos/${named.full_name}`
    const release=await request(`${base}/releases/latest`,{missing:true})
    const commits=await request(`${base}/commits?since=${encodeURIComponent(new Date(nowMs-2*DAY).toISOString())}&per_page=100`,{missing:true})
    const releaseAt=release.data?.published_at??null
    if(releaseAt&&(!Number.isFinite(Date.parse(releaseAt))||Date.parse(releaseAt)>nowMs+60000))throw Error('INVALID_RELEASE_EVIDENCE')
    return {repo:{id:String(named.id),fullName:named.full_name,description:named.description??null,stars:named.stargazers_count,forks:named.forks_count},
      observedAt:new Date(nowMs).toISOString(),stars:named.stargazers_count,forks:named.forks_count,releaseAt,
      activity:commitActivity(commits.data??[],commits.complete,nowMs),
      sources:{identity:`${base}`,immutableIdentity:`https://api.github.com/repositories/${named.id}`,release:release.data?.html_url??`${canonical}/releases`,
        commits:`${base}/commits?since=${encodeURIComponent(new Date(nowMs-2*DAY).toISOString())}&per_page=100`} }
  }
  return {seeds,observe}
}
