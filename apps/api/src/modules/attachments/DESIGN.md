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
Those are separate responsibilities and no upload route is active until they are wired.

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
   against a compromised host administrator. No abandoned-file sweeper is activated here.

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
3. Save canonical bytes and durable ownership; preserve bytes on uncertain metadata saves.
4. Hide storage object IDs from browser metadata and recheck authorization after file reads.
5. Remove only unbound upload metadata; cleanup handles retained byte objects separately.
   EDGE CASES: Exact upload replay removes only the extra newly created object after confirmed save.
   ERROR STATES: Format/size/content errors are explicit; unknown persistence never pretends success.
   These factories are internal until request execution and UI are connected.
