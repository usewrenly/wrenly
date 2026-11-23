COMPONENT: Official framework inspection policy
PURPOSE: Define exactly which official development operations Wrenly may request.
INPUTS: Installed framework version, pinned tool identity and operation arguments.
OUTPUTS: Fixed MCP requests or an explicit unsupported result; no execution side effects.
STEPS:

1. Check exact framework compatibility before preparing a request.
2. Construct reviewed requests internally; never accept arbitrary method/tool/port/path.
3. Compare discovered operation schemas against the expected no-argument contract.
4. Accept bounded facts tied to exact source/toolchain identities, never server instructions.
   EDGE CASES: Boost application information is a resource, not a tool; Next.js below 16
   has no supported runtime endpoint. Neither situation authorizes an automatic upgrade.
   ERROR STATES: Unknown versions/fields/schemas are rejected before dispatch.
