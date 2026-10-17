# Read-only production event ABI

These two files are byte-for-byte `deployments/production/{bordrless_launch,bordrless_swap}.json`
from New1Direction/hook-lab commit `b3dc4297735fe2e061fca7b6563d69cf81e0911c` (Apache-2.0).
They are NOT the default-ID mainnet-controls ABI, the `f3062df` SDK source pin, or the new
custom-Hook candidate. Addresses and SHA256 are checked by the decoder before use.

* launch: `929403a199c9cb411d25980a49667f531612efcdb7e449b13af9258b638869fb`
* swap: `ba5409de62f8d56f3500a72f5b7d11cfdefd85027d2ec3bd56e2137ae76bc414`

Parsing an event with this ABI does not establish that these bytes were deployed at its slot,
that the transaction finalized, or that its economic postconditions hold. No SDK builder is
exported here. Existing historical ELF/provenance artifacts remain unchanged.

`custom-production/` separately retains the new-address launch/swap ABI from local hook-lab
source `823442c7a7c3572ddf8ecf82c8084591ebb170c9`. It is a candidate, not deployed evidence or
approval. The decoder selects this only with that exact source pin; old and new addresses never
decode under each other's profile. No arbitrary ABI/source override is supported.

* launch: `9240ff013753c9ab893663f7b89279f1e5f1baade080f8fbf61f4f07a6a15c57`
* swap: `93a6721f59989c30423d7ad5a99cfd4592a9fd001160429bc063d74085fe2e13`
