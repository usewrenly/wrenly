# Attachment validation

COMPONENT: Shared attachment policy
PURPOSE: Give upload and inference code the same file and request budgets.
INPUTS: Untrusted byte lengths or uploaded bytes.
OUTPUTS: Validated text, preliminary image format, or an actionable error.
STEPS:

1. Bound file count and total bytes before processing content.
2. Decode text strictly as UTF-8 and reject empty/binary documents.
3. Recognize image headers before handing bytes to a separate bounded decoder.
   EDGE CASES: A matching image header is not proof of a safe or complete image.
   ERROR STATES: Invalid content or exceeded budgets fail before inference.

This policy alone activates no uploads. Image sanitization, private storage, authority,
saved references and provider/MCP delivery must all be connected before exposing UI.

COMPONENT: Provider message content
PURPOSE: Send exact canonical references without giving the provider local paths.
INPUTS: Server-resolved bytes/hash/type and explicit image capability.
OUTPUTS: Bounded compatible text and inline image message parts.
STEPS: Verify hash, enforce type/capability, quote text as untrusted context, encode
canonical images inline and bound the serialized content.
EDGE CASES: This accepts only trusted decoder output; header checks alone are insufficient.
ERROR STATES: Changed bytes or unsupported image capability abort before provider access.
The caller also enforces the full request budget including source, history and instructions.
