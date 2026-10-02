# Hugging Face API notes (model markets, P1a)

What the public Hugging Face Hub API actually does, as `src/hf-api.mjs` relies on it. Recorded on 2026-10-02 from
anonymous, read-only `GET`s to `https://huggingface.co`: 58 API requests and one docs page in about 8 minutes, paced at
one every 2 seconds. They fell in two rate-limit windows, 45 in one and 13 in the other. The lowest remaining count seen
was 455 of 500. No account, token or browser was used.
The fixtures in `tests/fixtures/hf/` are trimmed copies of these responses. Discussions and trending were cut to a few
neutral entries, and discussion authors were reduced to `{ name, type }`.

## Answers to the architecture's spike questions

| Question | Finding |
| --- | --- |
| Is `_id` on `GET /api/models/{owner}/{name}`? | **Yes, always**, with or without `expand[]`. With `expand[]`, the body is exactly `{ _id, id }` plus the requested fields. `expand[]=_id` is a 400, because `_id` is not an option; it always comes back. |
| Do renames and transfers redirect? | Yes, with a **307** and a relative `Location` (path and query only, same host). This covers transfers, renames within an owner, legacy single-name models moved into orgs, and case differences. Sub-resources such as `/commits/main` redirect too. The API never follows a redirect itself; `huggingface_hub` follows API redirects silently. |
| Can a redirect land on a different `_id`? | **Yes.** `runwayml/stable-diffusion-v1-5` 307s to `stable-diffusion-v1-5/stable-diffusion-v1-5`, whose `_id` `66d19580e2632490a6bc5829` and `createdAt` both date to 2024-08-30. It is not the 2022 runwayml repository. A path never proves identity. |
| Where does an org's `_id` come from? | **It is public:** `GET /api/organizations/{name}/overview` returns `_id`. The endpoint is missing from the published OpenAPI spec, but `huggingface_hub.get_organization_overview` uses it. The same value appears elsewhere: Qwen's overview and its `/api/trending` `authorData._id` agree (`64c8b5837fe12ecd0a7e92eb`), as do openai-community's overview and `/api/quicksearch?type=org` (`659ebc82b61dd9658802f398`). |
| A user's `_id`? | `GET /api/users/{name}/overview` returns `_id` and `type: "user"`. |
| Token TTL (docs) | OAuth access tokens expire after 8 hours by default (`expires_in: 28800`). An admin can raise this to 30 days. Token exchange gives no refresh token (`oauth.md`; `hf_oauth_expiration_minutes` in `spaces-oauth.md`). |

What this changes for later phases:
- **P3:** userinfo documents `orgs[].sub` as the org's unique id. Because the org `_id` is public, a claim can check `orgs[].sub === orgOverview(author).id` on every claim, instead of trusting the org name or pinning `sub` at the first verification. Unverified: that `orgs[].sub` equals the overview `_id`. Proving it needs a signed-in account; both should be the same Mongo ObjectId.
- **P2:** model info carries the owner's handle but neither the owner's `_id` nor its kind, and `expand[]` has no `authorData` option. `owner(handle)` resolves both with one or two extra calls (users first, then organizations). Users and organizations share one namespace.
- **P1b:** commit listings for **gated** models need a token whose user has accepted the gate. Anonymous calls get 401 `GatedRepo`. Model info and discussions stay public.

## Model info: `GET /api/models/{owner}/{name}`

- **Not in the published OpenAPI spec** (`/.well-known/openapi.json`). `huggingface_hub.model_info` is the reference.
- **Without `expand[]`:** the default payload, about 5 KB for gpt2. It has `_id`, `id`, `modelId`, `author`, `private`, `disabled`, `gated`, `sha`, `lastModified`, `createdAt`, `pipeline_tag`, `library_name`, `tags`, `downloads` and `likes`, plus `cardData`, `config`, `siblings`, `spaces`, `safetensors`, and more. It lacks `downloadsAllTime`, `trendingScore`, `childrenModelCount` and `baseModels`.
- **Valid `expand[]` options**, as listed by the 400 error: `author`, `baseModels`, `cardData`, `config`, `createdAt`, `disabled`, `downloads`, `downloadsAllTime`, `evalResults`, `gated`, `inference`, `inferenceProviderMapping`, `lastModified`, `library_name`, `likes`, `mask_token`, `model-index`, `pipeline_tag`, `private`, `safetensors`, `sha`, `siblings`, `spaces`, `tags`, `transformersInfo`, `trendingScore`, `widgetData`, `gguf`, `resourceGroup`, `xetEnabled`, `childrenModelCount`, `usedStorage`. Nested options such as `cardData.license` are a 400.
- **What the client requests:** `author private disabled gated createdAt lastModified sha pipeline_tag tags likes downloads downloadsAllTime trendingScore baseModels childrenModelCount spaces`. That is one call and about 3.5 KB per model.
- **Field shapes:**
  - `private` and `disabled` are booleans and present whenever they are expanded, including when false.
  - `gated` is `false`, `"auto"` or `"manual"`.
  - `downloads` covers the last 30 days. `downloadsAllTime` is cumulative.
  - `trendingScore` is an integer.
  - `childrenModelCount` is **an object**, `{ adapter, merge, quantized, finetune }`, not a number. The client sums it into `childrenCount`.
  - `baseModels` is **absent** when a model has none. Otherwise it is `{ relation: "quantized" | "finetune" | "adapter" | "merge", models: [{ _id, id }] }`, so base models come with their `_id`.
  - `spaces` is a list of Space ids **capped at 100**: gpt2, Llama 3.1 and bert all return exactly 100. `spacesCount` therefore saturates at `HF_SPACES_CAP` (100), which means "100 or more".
- **License:**
  - `expand[]=cardData` returns the whole card metadata. For Llama 3.1 that is about 13 KB of gated-access prompt text.
  - The `license:<id>` tags carry the same value, e.g. `license:mit`, `license:llama2`, `license:llama3.1`. The client reads those.
- **`_id` timestamps:** an `_id` is a Mongo ObjectId, and its first 4 bytes equal `createdAt` to the second.
  - gpt2 (`621ffdc0…`) was created 2022-03-02T23:29:04Z, the Hub's legacy import.
  - Llama 3.1 8B (`66944f1f…`) was created 2024-07-14.

## Not found, private, gated, disabled

| Case | Anonymous response | Client error |
| --- | --- | --- |
| Missing model or missing owner (`openai-community/no-such-model…`) | 401, `{"error":"Invalid username or password."}`, the same text in `X-Error-Message`, no `X-Error-Code` | `HfNotFoundError` (`HF_NOT_FOUND`) |
| Private model | Same as missing: anonymous callers cannot tell the two apart. HF's docs say other users get "404 - Repo not found". | `HfNotFoundError` |
| Private model seen with a token that can read it | 200 with `private: true` (per `huggingface_hub`; not observed, no account) | `HfPrivateError`, with `hfId` |
| Single-name path (`/api/models/openai-community`) | 401 | `HfUrlError` before any request: the parser needs `owner/name` |
| Gated model (`meta-llama/Llama-3.1-8B`, `gated: "manual"`) | Model info 200; discussions 200; commits 401 with `X-Error-Code: GatedRepo` | model info resolves (gated is allowed); commits throw `HfGatedError` |
| Disabled model (`ykilcher/gpt-4chan`) | Model info 200 with `disabled: true` (and `gated: "auto"`); discussions 200; commits 401 `GatedRepo` | `HfDisabledError`, with `hfId` |
| Unknown branch (`/commits/no-such-branch`) | 404 with `X-Error-Code: RevisionNotFound` | `HfNotFoundError` (`HF_REVISION_NOT_FOUND`) |

`huggingface_hub` maps a 401 on a repository URL to "repository not found", unless the message is `Invalid credentials in Authorization header`. Authenticated responses were never observed, because the spike used no token, so the client does not rely on that string:
- Anonymous: a 401 on a repository URL means "not found".
- With a token: only a 404 or `X-Error-Code: RepoNotFound` means "not found". Any other 401 is `HfUpstreamError` (`HF_UNAUTHORIZED`), so a revoked token never makes every model look gone.

`huggingface_hub` also recognises a disabled repo by `X-Error-Message: Access to this resource is disabled.`. The client handles that too, although these endpoints did not send it.

## Redirects

| Request | Status | `Location` |
| --- | --- | --- |
| `/api/models/gpt2` | 307 | `/api/models/openai-community/gpt2` |
| `/api/models/bert-base-uncased` | 307 | `/api/models/google-bert/bert-base-uncased` |
| `/api/models/runwayml/stable-diffusion-v1-5` | 307 | `/api/models/stable-diffusion-v1-5/stable-diffusion-v1-5` |
| `/api/models/meta-llama/Meta-Llama-3.1-8B` | 307 | `/api/models/meta-llama/Llama-3.1-8B` |
| `/api/models/OpenAI-Community/GPT2` | 307 | `/api/models/openai-community/gpt2` |
| `/api/models/thebloke/llama-2-7b-gguf?expand[]=author` | 307 | `/api/models/TheBloke/Llama-2-7B-GGUF?expand[]=author` |
| `/api/models/gpt2?expand[]=createdAt&expand[]=author` | 307 | `/api/models/openai-community/gpt2?expand[]=createdAt&expand[]=author` |
| `/api/models/gpt2/commits/main?limit=1` | 307 | `/api/models/openai-community/gpt2/commits/main?limit=1` |
| `/api/users/thebloke/overview` | 307 | `/api/users/TheBloke/overview` |

- Every hop is a request and counts against the rate limit.
- **Same-repository moves:** the legacy models kept their repository. gpt2 (`621ffdc036468d709f17434d`) and bert (`621ffdc036468d709f174338`) both date from the 2022-03-02 legacy import. The same-owner Llama rename lands on the 2024-07-14 repository, as expected for a rename.
- **Different repository:** the runwayml path lands on a repository created on 2024-08-30. The 2022 repository it used to name is gone, and the redirect now points at a different repository.
- HF's docs (`/docs/hub/repositories-settings`) say: "Transferring or renaming a repo will automatically redirect the old URL to the new location, and will preserve download counts and likes." They do not say what happens when someone creates a repository at a redirecting path. That would need an account to test, so it was not verified. Either way, the path alone never proves identity.
- **How the client handles redirects:**
  - It follows them by hand: at most 2 hops, the same origin, and the same endpoint shape.
  - It takes only the new `owner/name` (or handle) from `Location` and rebuilds the URL from its own prefix, suffix and query.
  - It records the original path as `redirectedFrom`.
  - `commitsCount` and `discussionsCount` refuse redirects (`HF_MOVED`): their responses carry no `_id` to check.
- **Legacy single names:** the parser does not accept them, because `huggingface.co/gpt2` is ambiguous with profile URLs such as `huggingface.co/openai-community`. Paste the canonical `owner/name`.

## Users and organizations

- **`GET /api/users/{name}/overview`:**
  - Returns `_id`, `user`, `type: "user"`, `fullname`, `avatarUrl`, `isPro`, `createdAt`, profile counts, and sometimes `orgs: [{ id, name, fullname, avatarUrl }]`.
  - The OpenAPI spec requires `_id`, `user`, `type`, `fullname`, `avatarUrl`, `isPro` and `createdAt`.
  - A different case 307s to the canonical one.
  - An organization name gives 404 `{"error":"This user does not exist"}`.
- **`GET /api/organizations/{name}/overview`:**
  - Returns `_id`, `name`, `fullname`, `avatarUrl`, `isVerified`, `plan` and counts.
  - It is case-insensitive **without** a redirect: `qwen` and `Qwen` both return 200 with `name: "Qwen"`.
  - A user name gives 404 "Sorry, we can't find the page you are looking for."
- **Other public org `_id`s:**
  - `/api/trending` `authorData`: `{ _id, name, type: "org" | "user", … }`.
  - `/api/quicksearch?q=…&type=org`: `orgs[]._id`.
  - `/api/organizations/{name}/members`: public members with their user `_id`. It is anonymous and was not wrapped.
- **Avatars:**
  - Seen on `cdn-avatars.huggingface.co`, as relative `/avatars/<hash>.svg`, and on `www.gravatar.com`. `/api/avatars/{name}` 302s to the CDN.
  - The client keeps only these, as https URLs with the query string removed:
    - `cdn-avatars.huggingface.co/v1/production/uploads/…`
    - `huggingface.co/avatars/…`
    - `www.gravatar.com/avatar/<hash>`. This one is rebuilt with `?d=retro`, because Gravatar's `d=` parameter can name any URL to redirect to.
  - Anything that later fetches an avatar server-side, such as token art, should still refuse redirects.
- **Free text:** profile text is user-written. One trending org's `fullname` starts with a space. The client strips controls and invisible formatting characters, collapses whitespace and caps the length.

## Commits, refs, discussions

- **Commits:**
  - `GET /api/models/{id}/commits/main?limit=1` returns 200 with `X-Total-Count: 26` for gpt2 and `Link: <…?p=1&limit=1>; rel="next"`.
  - The body is `[{ id (40 hex), title, message, authors: [{ user, avatar }], date }]`.
  - Repositories default to `main`. gpt2's refs: `{ branches: [{ name: "main", ref: "refs/heads/main", targetCommit }], tags: [], converts: [] }`.
- **Discussions:**
  - `GET /api/models/{id}/discussions` returns `{ discussions (50 per page), count, start, numClosedDiscussions }`.
  - `count` covers all discussions and pull requests (183 for gpt2). With `?status=open` it was 106, and `numClosedDiscussions` was 77.
  - `numClosedDiscussions` is only present on page 0 (`p=1` gives `null`).
  - Each call returns about 30 KB of user-written text the client does not use, and there is no `limit` parameter.
  - It works anonymously on gated and disabled models.
- **Unknown cases:** repositories with discussions turned off were not observed.

## Trending and listing

- **`GET /api/trending?type=model&limit=20`** (20 is the maximum):
  - Returns `{ recentlyTrending: [{ repoType: "model", repoData: { id, author, authorData, downloads, likes, gated, private, lastModified, pipeline_tag, numParameters, availableInferenceProviders, widgetOutputUrls, isLikedByUser } }] }`.
  - **There is no model `_id`.** Resolve one with `model()` before keying anything on a trending entry.
  - About 17 KB.
- **`GET /api/models?author=openai-community&limit=5`:**
  - Returns an array of `{ _id, id, likes, trendingScore, private, downloads, tags, pipeline_tag, library_name, createdAt, modelId }`.
  - Pagination uses a cursor in `Link: <…&cursor=…>; rel="next"`.
  - `expand[]` works here too, giving `_id`, `id` and the requested fields.
  - Not wrapped yet: nothing needs it.

## Rate limits

- **Headers on every response:** every API response carries the same two headers, including 307, 400, 401 and 404 responses. The header values are written exactly as received:

  ```
  RateLimit: "api";r=499;t=295
  RateLimit-Policy: "fixed window";"api";q=500;w=300
  ```

  - Anonymous use is 500 API requests per 5-minute fixed window per IP. Pages are a separate bucket: `"pages";r=99;t=236` and `q=100;w=300`.
  - `r` drops by one for every request, redirects and errors included.
  - `t` is the number of seconds until the fixed window resets. Between two batches the count went from `r=455` back to `r=499`.
- **429s:** a 429 was not triggered, because that would take 500 requests. Per HF's docs and `huggingface_hub` (1.2+), a 429 carries the same headers and `t` is the wait. No `Retry-After` was observed; the client honours whichever of `RateLimit` and `Retry-After` asks for the longer wait.
- **The client's behaviour:**
  - It keeps the latest reading.
  - It leaves `reserve` of each window unspent: 10% by default, and the P1b worker passes 0.6 to use at most 40%.
  - Before a request, it waits for the reset when the window is down to that reserve.
  - It retries 429, 500, 502, 503 and 504 up to twice. 429 retries wait as long as the headers ask; the others back off for 1 s, then 2 s.
  - It throws `HfRateLimitedError` with `retryAt` (epoch ms) when a wait would exceed `maxWaitMs`, which defaults to 15 s.
  - A 429 holds later calls until it clears, even when it came without headers.
  - Within one window, a late response cannot raise the remaining count.
  - Concurrent callers that wait for the same reset all go together when the window opens. The new window has its full quota, and the first response restores the count.

## Client interface (`src/hf-api.mjs`, `src/hf-url.mjs`, `src/hf-copy.mjs`)

```js
import { createHfClient, HF_SPACES_CAP } from './hf-api.mjs'
const hf = createHfClient({ token, fetchImpl, timeoutMs: 10_000, retries: 2, maxWaitMs: 15_000, reserve: 0.1, userAgent: 'repo.ing' })

await hf.model({ path })          // path: model URL or owner/name
// → { hfId, path, owner: { handle }, private: false, disabled: false, gated: false | 'auto' | 'manual', createdAt, lastModified,
//     sha, pipelineTag, license, likes, downloads30d, downloadsAllTime, trendingScore,
//     baseModels: { relation, models: [{ hfId, path }] } | null, childrenCount, spacesCount, redirectedFrom: string | null }
await hf.owner(handle)            // user or organization
await hf.userOverview(name)       // → { id, handle, kind: 'user', fullname, avatarUrl, redirectedFrom }
await hf.orgOverview(name)        // → { id, handle, kind: 'org', fullname, avatarUrl, redirectedFrom }
await hf.commitsCount(path, { revision: 'main' })   // → number (path: canonical owner/name from model())
await hf.discussionsCount(path)   // → { total, open, closed } (open and closed are null if the Hub omits the closed count)
await hf.trendingModels({ limit: 20 })
// → [{ rank, path, owner: { handle, kind?, id? }, private, gated, likes, downloads30d, lastModified, pipelineTag }]
hf.rateLimit()                    // → { bucket, remaining, resetAt, quota, windowSeconds } | null
```

- **Never guessed:**
  - Dates are ISO strings.
  - Metrics the Hub leaves out are `null`.
  - `model()` only ever returns public, enabled models, so `private` and `disabled` are always false. They are kept so callers can store the checked state.
- **Errors:**
  - Invalid input throws `HfUrlError` before any request. It comes from `hf-url.mjs`, and `hf-api.mjs` re-exports it along with `parseHfModelUrl`.
  - Every other error extends `HfApiError`, with a `code`, and `status`, `path` and `hfId` when known:
    - `HfNotFoundError`
    - `HfPrivateError`
    - `HfDisabledError`
    - `HfGatedError`
    - `HfRateLimitedError`, with `retryAt`
    - `HfUpstreamError`, used for unexpected statuses, invalid or oversized bodies, schema failures, refused or excessive redirects, timeouts, network errors and identity mismatches.
- **Validation:** responses are validated with zod. Unknown fields are dropped, and a wrong type fails closed. Free text is cleaned by `cleanText`, which is exported:
  - Controls become spaces.
  - Zero-width spaces, bidi marks and overrides, tag characters, blank fillers and lone surrogates are dropped. ZWJ and ZWNJ stay, because scripts and emoji need them.
  - Whitespace collapses, and the result is cut by code point.
- **Parsing:** `parseHfModelUrl(input)` returns `{ owner, name, path }`. It accepts `huggingface.co`, `www.huggingface.co` and `hf.co` URLs, with or without a trailing path, and bare `owner/name`. It refuses datasets, Spaces, collections and other Hub sections. Names follow `huggingface_hub`'s `validate_repo_id`: ASCII letters, digits, `_`, `-` and `.`; starting and ending with a letter, digit or `_`; no `--` or `..`; at most 96 characters; never ending in `.git`.
- **Copy:** `HF_DISCLAIMER`, `HF_DISCLAIMER_BADGE` and `HF_DISCLAIMER_SHORT` live in `src/hf-copy.mjs`.
