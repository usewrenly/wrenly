# Prompt reference controls

COMPONENT: Shared composer file selection
PURPOSE: Let people review image/text references before explicitly sending a prompt.
INPUTS: Explicit local file choice, current model, prompt submission acknowledgement.
OUTPUTS: Bounded upload chips, immutable reference IDs or an actionable error.
STEPS:

1. Offer the same Add → Reference files action on Home and project composers.
2. Bound count/bytes before upload and retain local previews without remote retrieval.
3. Upload with a stable UUID; reconcile a lost response through the acknowledgement endpoint.
4. Disable Send until every selected reference is ready. Failed files require Retry or Remove.
5. Pass IDs with the explicit request; clear only on acknowledged submission/handoff.
6. Stop client uploads and release browser preview URLs on unmount; expiry handles abandoned files.
   EDGE CASES: Home handoff saves IDs with its request; it never stores raw files in sessionStorage.
   ERROR STATES: Failed uploads preserve the typed prompt. Retry retains the original upload identity.

COMPONENT: Saved reference links
PURPOSE: Show which files accompanied a saved prompt without eager downloads.
INPUTS: Validated public attachment metadata in authorized conversation history.
OUTPUTS: Named authenticated reference links, never instance filesystem paths.
STEPS: Render one link per saved reference; the API rechecks access when opened.
EDGE CASES: Historical text-only messages have no links. Revoked access cannot fetch content.
ERROR STATES: Invalid history metadata is rejected by the browser contract.
