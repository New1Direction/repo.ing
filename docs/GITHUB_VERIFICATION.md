# GitHub repository authority verification

> This document contains dated verification and setup records. The initial production-setup limitations below are historical; subsequent session behavior is recorded at the end. Use the [User guide](USER_GUIDE.md#claim-builder-fees) for the current flow.

Run date: 2026-09-24. Scope: `VERIFY_GITHUB` only. A verification is a point-in-time record; future wallet binding or payout must check current GitHub authority again.

## Policy and API path

The GitHub App needs **repository Metadata: read** and no repository write or Administration permission. No extra account permission is needed for `GET /user`. GitHub documents Metadata read for [`GET /repos/{owner}/{repo}/collaborators/{username}/permission`](https://docs.github.com/en/rest/collaborators/collaborators) and [App user token access](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). The endpoint reports effective `permission` across repository, team, organization, and enterprise grants. Its legacy `permission` value maps `maintain` to `write` and `triage` to `read`; this implementation accepts only the literal `admin` value.

`src/github-verification.mjs` starts the [GitHub App web authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) with a random state. The caller must retain that state **and the canonical numeric repository ID** in its server-side session. On callback, the module checks both, exchanges the one-time code for a GitHub App user access token, calls `GET /user`, looks up current owner/name with `GET /repositories/{id}`, and checks the authenticated user's permission at the current path. It verifies the numeric ID returned by GitHub and re-reads the path after the permission check. Only a matching `admin` result is persisted. A login, App installation, 404, other permission, identity mismatch, or API error does not create a verification row. The `GET /repositories/{id}` lookup worked for a public repository in the live CLI check below, but this route is not listed in GitHub's current REST reference; its behavior with a GitHub App user token still needs a live test.

GitHub's [App authorization model](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user) limits a user token by both the user's access and the App installation's access. An installation alone does not identify an eligible user. This module never accepts an installation token or a GitHub CLI token as claimant proof.

## Evidence

| Evidence | Result |
| --- | --- |
| Public repository ID lookup, live GitHub CLI | `GET /repositories/1296269` returned ID `1296269`, current path `octocat/Hello-World`, public, not archived. This was **not** a GitHub App verification. |
| Admin fixture | App code exchange returned a synthetic `ghu_` token; `GET /user` returned synthetic user ID `42`, login `current-admin`; current repository path resolved to `new-owner/renamed-repo` for numeric ID `1296269`; permission endpoint returned `admin`; one row was persisted. |
| Non-admin fixture | Same authenticated user and repository; permission endpoint returned `write`; verification rejected and no row added. |
| Authentication-only fixture | `GET /user` succeeded; permission endpoint returned 404 (`none`); verification rejected and no row added. |
| Immutable-ID fixture | GitHub repository lookup returned ID `777` for requested ID `1296269`; permission endpoint was not called and no row was added. A callback ID differing from the ID saved at authorization start was also rejected. |
| GitHub App installation | App `git-fun-local-test` (ID `5061009`, client ID `Iv23li0LF9CWsTgcIyQ0`) has Metadata read and is installed on `New1Direction` with all-repository selection. Its installation token listed public `New1Direction/Waternot`, ID `1384142609`. An installation token is not claimant proof. |
| Live GitHub App admin check | GitHub App OAuth callback for `New1Direction/Waternot` (ID `1384142609`) resolved authenticated user `New1Direction` (ID `285551516`). GitHub returned effective permission `admin`; `adminAccepted: true`, and PostgreSQL stored one `repo_verifications` row at `2026-09-24 14:02:26 UTC`. No code or token was retained. |
| Live non-admin attempts outside the installation | App OAuth callbacks for authenticated `New1Direction` targeted public `octocat/Hello-World` (ID `1296269`) and public `react/react` (ID `10270250`; formerly `facebook/react`). GitHub returned HTTP `403` from each collaborator-permission request, with **no permission value**. The verifier returned an error and the table remained at one admin row. These are **not** live non-admin permission proofs. |

## Files and reproduction

The original verification slice changed `src/github-verification.mjs`, `src/db/schema.mjs`, `drizzle/0003_shallow_prowler.sql` and its Drizzle metadata. This live-callback slice added `scripts/github-live-callback.mjs` and updated `tests/github-verification.test.mjs`, `package.json`, and this report. No schema, wallet, claim, or payout change was made for the callback. The existing `repo_verifications` table stores repo ID, GitHub user ID/login, `admin`, and verification time.

Use a dedicated PostgreSQL test database, apply migrations, and run `npm run test:github-verification`. The test truncates its database tables, seeds an already indexed canonical market, and mocks only the GitHub API boundary. Migration passed; the focused tests passed **5/5**, including the callback HTTP route. No launch, index, trade, or fee suites were rerun. No tokens, codes, or secrets are persisted.

For the live check, `npm run github:verify-live` starts only `GET /api/github/callback` on port 3001. It requires `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_TEST_REPO_ID`, and `DATABASE_URL` in its process environment. It prints an authorization URL containing a one-time state, then returns only the GitHub user ID/login, permission, and `adminAccepted` decision. It does not log the callback code or access token. The registered App callback must be `http://localhost:3001/api/github/callback`. The dedicated `gitfun_github_live` database currently contains a **synthetic indexed-market fixture** for real public repository `New1Direction/Waternot` (ID `1384142609`); this fixture is solely to exercise the verifier's canonical-market guard and does not prove a Solana launch for that repository.

The admin path is live-verified through the GitHub App user-token callback. The existing non-admin unit tests reject `write` and `none`. A live non-admin permission result remains unverified: the two public-repository attempts returned HTTP 403 because they were outside the App installation, so GitHub supplied no permission. Per this task's stop condition, no extra repository or account was created for that check.

## Production App setup

On 2026-09-24, the separate production GitHub App `repo.ing` was registered under `New1Direction` (App ID `5065405`, client ID `Iv23li6nWMp43WnOcVjN`). Its sole callback is `https://repo.ing/api/github/callback` with wildcard matching disabled. The only requested repository permission is Metadata read; it has no webhook and allows installation by any account. It is installed on `New1Direction/Waternot` only, as a test installation. The production client secret was copied directly into a pending Railway web service variable and was not written to this repository or printed in the setup transcript. The client ID is staged there too. The original `git-fun-local-test` App and its localhost callback were not changed.

The production variables are not deployed, and no production OAuth exchange or verification row has been created. A real indexed canonical market is required before the production `/api/github/start` route begins authorization; this setup alone does not prove the end-to-end claim path.

## 2026-09-25: one authorization per claim session

The web flow now retains a GitHub App user credential for at most **one hour**, bounded by the provider's token expiry. It is encrypted with AES-256-GCM using a purpose-separated key derived from the existing server secret. Production stores it only in a Secure, HttpOnly, SameSite=Lax, host-only `__Host-repoing_github` cookie. No refresh token is retained, and the credential is never passed to client components, logs, verification rows, or local storage. Rotating the GitHub client secret invalidates these sessions.

OAuth state and immutable repo ID checks still precede exchange. Each wallet challenge, wallet binding, and payout calls GitHub again using the retained user credential: authenticated user ID must match the session, current public repository identity must match the immutable ID, effective permission must be `admin`, and the path must remain unchanged across verification. Revoked/expired tokens and permission loss fail closed. The App still requests Metadata read only.

OAuth callbacks now only verify and return to the claim page, including old `mode=claim` links. A payout requires an explicit same-origin POST with a signed review bound to session, repo, GitHub user, payout wallet/binding time, exact fee amount, cumulative previously paid amount, and a maximum ten-minute expiry (thirty minutes for reviews made on the Builders dashboard, added later). Historical verification rows or cached display data cannot authorize a payout. The current session replaces the earlier five-minute signed identity cookie; existing visitors verify once to establish the new encrypted session.
