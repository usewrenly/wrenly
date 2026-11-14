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
