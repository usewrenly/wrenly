# Provider catalog data

A catalog is a searchable directory of providers and models. It helps people choose
what to connect; a listing does not mean the model is installed or accessible to their
account. This folder stores the public directory, not private connection tokens.


The bundled `provider-catalog-snapshot.json` is public descriptions converted into Wrenly’s consistent format from
https://models.dev/api.json. `fetchedAt` says when it was captured; the content hash is a fingerprint that identifies
that saved copy. Models.dev is MIT licensed; see MODELS_DEV_LICENSE.txt. It is not a
Wrenly-authored provider/model list. No instance credentials were sent to obtain it.

Contributors can update the bundled data with `bun run catalog:snapshot` from
apps/api, then run catalog tests and review the data diff. This is a source-release
maintenance command, not an operator setup requirement.

Installed instances browse local data using authenticated
`GET /api/models/catalog?q=...&limit=40&offset=0`. Add `provider=ID` to search that
provider's model entries. `compatible=true` filters entries whose registry metadata
explicitly identifies the currently supported OpenAI-compatible transport and has
an endpoint; it does not certify credentials, model access or inference behavior.

Only the verified instance owner may trigger
`POST /api/models/catalog/refresh` from the configured trusted web Origin. This
fixed public-registry request carries no provider token, cookie or user prompt.
Browsing and startup never trigger it. Refresh validates bounded data before
transactionally replacing the cache and recording safe audit metadata. Failures
retain the old cache; corrupted caches fall back to the bundled snapshot and can
be repaired by a valid refresh. Offline inference never depends on catalog refresh.

The first bundled capture contains 232 providers and 8,986 served model entries.
Counts will change on future captures. Model IDs remain provider-scoped; a canonical
model ID is supplementary metadata, not a substitute in inference requests.
Unknown capabilities and prices are null rather than guessed. Pricing is catalog
metadata per million tokens, not a quote or promise about an operator's account.

Registry API placeholders are treated as requiring endpoint configuration; they
are never expanded against process.env. Registry SDK package names are never
installed/imported. Documentation anchors are permitted as link metadata, while
endpoint URL credentials and fragments are rejected. Endpoints are catalog data,
not approved destinations for sending saved credentials.

Saved connections and encrypted credentials are separate from this catalog. Changing
registry metadata never updates their destination, token or enabled state. See the
module README for the configuration, discovery and selection boundaries.
