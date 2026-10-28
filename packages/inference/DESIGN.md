COMPONENT: Shared inference HTTP transport
PURPOSE: Apply the approved provider destination boundary to API conversations and MCP model calls consistently.
INPUTS: Immutable endpoint, explicit local/cloud scope, supported HTTP request and cancellation signal.
OUTPUTS: Bounded non-streaming Fetch Response, or safe connection error.
STEPS:
  1. Validate request origin/path against the configured endpoint before reading credentials.
  2. Validate every DNS answer and pin one address while retaining the original Host/TLS identity.
  3. Issue one native HTTP request with no redirects, proxy credential inheritance or pooled connection reuse.
  4. Bound body size, response size and total request time; cancel underlying sockets on abort.
  5. Return a Fetch-compatible buffered response for the existing non-streaming SDK calls.
EDGE CASES:
  - SDK retries issue fresh validated requests; no implicit endpoint fallback.
  - Saved network scope is explicit; legacy HTTP endpoints remain restricted to local scope.
  - Unsupported request paths, streaming bodies and cross-origin requests fail before forwarding tokens.
ERROR STATES:
  - DNS/network/TLS/redirect/size/deadline failure -> safe error without prompt/token/upstream body.
  - Non-success HTTP response -> SDK receives safe status metadata, never raw credential-bearing diagnostics.
