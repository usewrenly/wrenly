# Private reference files

COMPONENT: Attachment image normalization
PURPOSE: Preserve screenshot information while removing metadata and rejecting unsafe input.
INPUTS: Bounded JPEG/PNG/WebP bytes and caller cancellation.
OUTPUTS: A static canonical WebP, or explicit failure.
STEPS:

1. Check input limits and allow one active decoder per API process.
2. Spawn a short-lived worker without inherited environment credentials.
3. Bound actual input/output, pixels, native decoder threads and wall-clock time.
4. Reject animation, orient and resize inside the image bounds without cropping.
5. Kill and await the worker on completion, timeout, cancellation or failure.
   EDGE CASES: An image header is not decoding proof; APNG must be checked explicitly.
   ERROR STATES: Invalid/corrupt/animated/oversized/cancelled input yields no stored object.

The image worker does not perform authorization, storage, network requests or inference.
Production HTTP adapters connect those responsibilities without granting decoder networking.

COMPONENT: Canonical object store
PURPOSE: Retain exact private bytes independently of original filenames.
INPUTS: Canonical bounded bytes, generated IDs and saved hash/length metadata.
OUTPUTS: Exclusive private objects or verified bounded reads.
STEPS:

1. Require a private real directory and recheck its filesystem identity.
2. Exclusively create generated object IDs, flush and close before returning metadata.
3. Open reads without following symlinks; reject nonregular/shared files.
4. Bound reads by saved length and verify their SHA-256 before returning bytes.
5. Remove only explicit generated IDs; callers enforce retention and authorization.
   EDGE CASES: Missing cleanup targets are idempotent; changed content is never substituted.
   ERROR STATES: Unsafe permissions, changed identity or corrupt content fail closed.
   The instance account and private parent directories are trusted; this is not a defense
   against a compromised host administrator. Cleanup receives only durable tombstoned IDs.

COMPONENT: Durable upload ownership
PURPOSE: Keep unsubmitted files personal and bind submitted files to exactly one saved request.
INPUTS: Verified actor, canonical object identity, upload request ID, project/request IDs.
OUTPUTS: Durable metadata and a versioned immutable request snapshot.
STEPS:

1. Serialize actor uploads and use a unique actor/upload identity for exact save replay.
2. Bound pending uploads and give personal unsubmitted metadata a 24-hour expiry.
3. Within authorized request admission, lock upload IDs in sorted order and bind all or none.
4. Recheck current account/project authority on retrieval. Only owners read personal uploads.
5. Tombstone only unused uploads; retained history cannot be deleted by a composer removal.
   EDGE CASES: Replay never binds another person's file or silently reuses a different request.
   ERROR STATES: Expired, changed or already bound references fail before model work.
   Physical orphan/expired-object cleanup is a separate bounded lifecycle step; these functions
   alone do not expose HTTP routes or activate a sweeper.

COMPONENT: Attachment HTTP adapters
PURPOSE: Read a bounded explicit upload independently of prompt execution.
INPUTS: Verified session, exact trusted web origin for mutations, UUID upload key and file bytes.
OUTPUTS: Safe public metadata or authorized private content with no-store/nosniff headers.
STEPS:

1. Authenticate and validate origin before consuming the body.
2. Bound streamed bytes and read duration, sanitize according to actual content.
3. Reserve durable ownership before writing bytes; verify the stored object before marking it ready.
4. Hide storage object IDs from browser metadata and recheck authorization after file reads.
5. Remove only unbound upload metadata; cleanup handles retained byte objects separately.
   EDGE CASES: Exact upload replay uses its reserved object identity and verifies existing bytes.
   ERROR STATES: Format/size/content errors are explicit; unknown persistence never pretends success.
   Production mounts these factories behind the existing authenticated API middleware.

COMPONENT: Frozen request propagation
PURPOSE: Ensure conversation/build/retry uses the references selected at admission.
INPUTS: Explicit attachment IDs or a trusted server-frozen snapshot from a conversation.
OUTPUTS: Saved immutable metadata, claimed references and a verified versioned MCP payload.
STEPS:

1. Bind personal references within existing queue/account/project admission transactions.
2. Validate configured model capability before committing; missing validation rejects attachments.
3. Carry snapshots from conversations to builds and retain originals on explicit retry.
4. Resolve bytes once for an owned build claim and reuse them through repair attempts.
5. Negotiate MCP attachment version, validate both ends and bound complete tool request size.
   EDGE CASES: Historical jobs have empty snapshots; unsupported MCP servers never drop files.
   ERROR STATES: Missing storage or references fails before inference; no substitute files/model.

COMPONENT: Upload completion and cleanup
PURPOSE: Keep interrupted file writes unusable and discoverable for bounded cleanup.
INPUTS: Reserved metadata, verified object bytes, expiry and tombstoned object IDs.
OUTPUTS: Ready references or idempotent private-file removal.
STEPS:

1. Commit a pending ownership reservation before opening an exclusive file.
2. Verify exact length/hash, then mark the unexpired actor-owned reservation ready.
3. Refuse pending references at reads, acknowledgement lookup and request binding.
4. Every minute expire a bounded page of abandoned uploads and unlink a bounded page
   of tombstoned objects. Revisit tombstones so a late interrupted write is removed.
5. Wait for in-flight cleanup on shutdown; never remove retained project references.
   EDGE CASES: Unknown reservation outcomes write no bytes; incomplete existing files are
   not overwritten. Remove and select the file again if an explicit retry cannot verify it.
   ERROR STATES: Cleanup failure retains durable evidence and retries the same page.

COMPONENT: Composer references and image capability
PURPOSE: Let users deliberately send reference files through their selected model.
INPUTS: Explicit file selection, upload acknowledgements and owner-reviewed model IDs.
OUTPUTS: Ready chips, exact submitted IDs and authorized conversation links.
STEPS:

1. Share one upload controller between Home and workspace composers.
2. Disable Send while selected uploads are incomplete; retain identities for explicit retry.
3. Carry Home IDs through its project handoff and clear chips only after accepted submission.
4. Owners save exact image-capable model IDs with an independent revision check.
5. Check current capability at admission and execution; empty lists remain text-only.
   EDGE CASES: Stale capability editors must reload settings before saving; no automatic model switch.
   ERROR STATES: Upload and model errors remain actionable; no failed image is silently omitted.
