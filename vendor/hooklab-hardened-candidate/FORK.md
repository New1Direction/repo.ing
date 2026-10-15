# Hook Lab provenance

Hook Lab forks [Bordrless programs](https://github.com/BordrlessDex/bordrless-programs)
and [Bordrless SDK](https://github.com/BordrlessDex/bordrless-sdk), under Apache-2.0.
LICENSE, NOTICE, the SDK/package licenses and original notices are retained.

The program fork boundary is upstream commit
[`a71b167`](https://github.com/BordrlessDex/bordrless-programs/commit/a71b167)
(“Phase 3a is live on mainnet”). The SDK was imported with subtree history at
[`927397fc38c4b16fbfedb833305435de038ec36d`](https://github.com/BordrlessDex/bordrless-sdk/commit/927397fc38c4b16fbfedb833305435de038ec36d).
Because these histories are merged, “everything after the boundary is ours” is not
a precise description of ancestry. `git log --all`, the subtree trailers and
`scripts/fork/upstream.json` preserve the original identities and import history.

Hook Lab adds the static builder, launcher, recipe fixtures, ID/PDA rebranding,
devnet deployment records and beta release tooling/docs. `CHANGELOG.md` describes
the current beta changes; Git history is the complete change record.

## Identity is not branding alone

`scripts/fork/current.json` matches `ids.devnet.json`. These contain public keys only.
The protocol key is compiled into hook-management checks; the Studio and attester
keys control separate acceptance/attestation paths. They are Hook Lab keys, not the
upstream operators' keys. Program IDs, PDA seeds and bumps are checked by release
tooling and Rust/SDK tests. Keep public deployment records in Git; keep secret signing
keys outside it.

The devnet deployment was recorded on 2026-10-13, including plain, Half-Life and kit
launches. See `deployments/devnet.json` and the independently runnable verification
in `docs/release.md`. Old mainnet hashes, launch-config accounts, keeper services and
Studio claims in upstream references do **not** describe this deployment.

## Historical tooling

`scripts/fork/rebrand.py` remains for provenance and isolated forks. It is not a beta
setup step. `scripts/fork/devnet.sh` now refuses to replace the existing identity.
Do not run it to fix a missing wallet. A separate fork needs a separate checkout,
deployment records and explicit owner authorization, not overwriting this deployment.

The eight deployed binaries still contain upstream `security.txt` links. This beta
does not silently upgrade programs to change metadata. Hook Lab reports belong with
this repository's maintainers; see `SECURITY.md`. Updating embedded contact metadata
requires a separately approved, rebuilt and verified program upgrade.
