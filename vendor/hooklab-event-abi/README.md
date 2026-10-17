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
