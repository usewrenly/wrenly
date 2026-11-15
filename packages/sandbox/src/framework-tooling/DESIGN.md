COMPONENT: Installed-source official MCP inspection adapter
PURPOSE: Run one credential-free official inspection before the existing sandbox removes its prepared source.
INPUTS: Claim-owned installed directory, frozen files, framework, build/claim UUIDs and existing abort signal.
OUTPUTS: Bounded available/unavailable receipt, or an explicit uncertain-cleanup error.
STEPS:

1. Resolve a prebuilt trusted local image; freeze its ID and verify labels/user.
2. Hash the exact ordered source and image identity; never accept either from the model.
3. Create a claim-labelled container with read-only source, network none and fixed limits.
4. Send one bounded request, keep stdin open and await bounded output under the caller's deadline.
5. Verify exact image/claim labels before removal, then confirm absence before settling.
   EDGE CASES: No image means unavailable. Unknown create/removal effects retain the build recovery fence.
   ERROR STATES: A known isolated inspection failure does not bypass normal validation; uncertain cleanup throws.
