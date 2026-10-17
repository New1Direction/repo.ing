# New-mint review HTTP/UI boundary

`HOOK_WALLET_NEW_MINT_REVIEW_ENABLED` defaults off, as do wallet identity and launch
assessment. When separately configured, `/hooks/launch-review` includes the new-mint
review form. The deployed POST `/api/hook-lab/new-mint-preparation` has no custody key
source or adoption verifier. It authenticates the wallet then returns explicit
custody/adoption blockers before reserving any mint. This is a review interface,
not a completed executable launcher.

Requests require exact HTTPS origin, secure same-origin session cookie, strict
2 KiB JSON, an operation UUID, the connected public wallet, cap basis points and
UTF-8 label. Both IP and wallet quota are enforced. Wallet session must match the
connected public wallet. No GitHub identity is required. Unexpected properties,
query parameters, duplicate cookies and stale sessions fail closed.

The handler's explicit candidateReview dependency is for local injection tests;
the production route supplies none. It can return public identity, fee bounds,
signer addresses and message hash for inspection, but never message bytes,
ciphertext, signer material or session token. Final response authority is always
false even if an injected object claims otherwise. The owning session is rechecked
after asynchronous candidate work. The custody service separately holds its real
transactional session locks for state changes.

The form preserves its operation ID across repeated requests while mounted and
allows pasting a retained ID after reload. It does not persist any keys. Users must
retain the ID outside the page; production operation listing/recovery UX remains a
follow-up before a complete launcher claim. Cap/label cannot repurpose a previously
reviewed durable mint. Browser behavior has not been tested due the recorded browser
execution limit; unit tests and Next build do not substitute for it.

Run `node --test tests/hooklab-new-mint-http.test.mjs` and `npm run build`.
No environment value, secret, key-management service or live provider is configured
by this patch. Production co-signing/submission and adoption trust are still absent.
