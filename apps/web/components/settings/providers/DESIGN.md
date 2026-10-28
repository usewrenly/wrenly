# Guided provider settings

These components help the owner connect a model-hosting service. For example, an
owner can save an Ollama address, check its installed models and choose the instance
default without editing server environment files. The API stores credentials; the
browser receives connection metadata and whether a token has been configured.

COMPONENT: Owner provider setup page and connection forms
PURPOSE: Configure inference without routine environment-file edits.
INPUTS: Owner session, cached catalog search, safe connection metadata and explicit form submissions.
OUTPUTS: Saved encrypted connection, read-only connection check and instance default.
STEPS:
  1. Load owner-only connection metadata before showing credential controls; members get an access explanation.
  2. Offer local Ollama, searchable hosted catalog and advanced compatible gateways.
  3. Show the reviewed destination and protocol availability before requesting credentials.
  4. Save using a stable request UUID across uncertain retries; clear it when settings change.
  5. Keep tokens only in password inputs/component memory, clear after success, never persist or echo them.
  6. Let the owner explicitly check a saved connection, choose a served model or clearly labeled catalog/manual ID, and save the instance default.
  7. Allow token replacement and disable/re-enable on the same immutable connection; invalidate model discovery after changes.
EDGE CASES:
  - Search races/unmount -> abort old requests and ignore their results.
  - Catalog unavailable -> retain saved connection controls and local/custom setup.
  - Model listing unsupported -> explicit model ID remains possible, without claiming live verification.
  - Local service empty -> explain installation on the Wrenly server, not the browser computer.
  - Device override -> distinguish it from the instance default and provide a reset in settings.
ERROR STATES:
  - 401/403 -> sign-in/owner-only explanation, no credential form.
  - Lost save acknowledgement -> retain creation identity for exact retry; offer saved-list refresh.
  - Stale catalog -> require renewed destination review rather than automatically resubmitting a token.
  - Probe failure -> show safe server guidance, no fallback inference or automatic paid request.

Environment compatibility import follows the implementation pass in
GUIDED_PROVIDER_CONFIGURATION.md. Metadata includes only a reviewed destination
fingerprint. The Import action sends no token/endpoint override; the API copies
server-side credentials. Imported sources remain visibly imported, including when
their saved connection is disabled. Stale legacy selections must be refreshed.

## Models visual refinement — approved account/settings scope

COMPONENT: Model preference cards and searchable inventory
PURPOSE: Make available inference choices legible within the established settings design.
INPUTS: Existing model discovery response, browser selection and safe owner-role summary.
OUTPUTS: Browser-only model preference; no new provider calls, credentials or shared writes.
STEPS:
  1. Present the current choice and shared default as substantial summary cards.
  2. Search model identifiers, labels and provider names; filter All, Local or Cloud.
  3. Keep selection keyed by provider plus model; expose pressed state on each choice.
  4. Show unavailable saved choices explicitly without substituting another model.
  5. Preserve reset-to-default, discovery retry and provider reachability guidance.
  6. Keep provider administration owner-only; retain the existing recovery notice.
EDGE CASES:
  - Duplicate model IDs across providers remain distinct choices.
  - No search matches is distinct from no discovered models.
  - Refetch failure retains cached results with a visible warning.
  - A shared default missing from discovery is not an available choice.
ERROR STATES:
  - Discovery failure -> explicit retry, no fabricated models.
  - Saved choice unavailable -> show identifier and ask user to choose or reset explicitly.

Visual reference: the owner's AI Gateway model cards in
inspirations/other/Screenshot From 2026-10-16 22-54-42.png, adapted to Wrenly's
paper/ink palette, hairlines and restrained corners. No usage rankings, prices,
promotions or capabilities are inferred from a model name. This refines the
approved account/settings component without changing provider architecture.

## Owner-requested guided presentation — 20 October 2026

COMPONENT: Existing provider page and Models orientation
PURPOSE: Replace the long connect/manage stack with explicit setup stages and clear model/provider language.
INPUTS: Existing authorized saved connections/defaults, catalog and discovery responses.
OUTPUTS: Connect / Choose model stages and a clear route to browser model preferences.
STEPS:
  1. First load selects Connect for empty installations and Choose model for existing connections.
  2. Label stages with numbers and selected state; keep both panels mounted so switching cannot discard pending requests or credentials.
  3. Confirmed provider creation advances to Choose model; existing checks/model/default controls stay unchanged.
  4. Put legacy environment import inside explicit advanced disclosure in Connect.
  5. Explain provider = service, model = selected inference model, instance default versus this-browser preference.
EDGE CASES:
  - Stage switching never marks a connection verified or selects a model automatically.
  - Missing/disabled default remains visibly unavailable; keep probe and uncertain-save recovery.
ERROR STATES:
  - Existing auth, catalog and persistence errors remain explicit, never replaced with decorative completion.
This is presentation of the approved provider architecture, without new credential ownership, transports or writes.

Owner presentation amendment 20 October: present Local, Hosted and Custom sources
as descriptive bundled-icon cards; keep existing forms mounted and credential/retry
semantics. Models shows provider status above inventory. Do not load remote catalog
logos without a separately reviewed asset policy. Shared dialogs use opaque themed
surfaces and a dimmed backdrop. Remove redundant back navigation inside Settings.
