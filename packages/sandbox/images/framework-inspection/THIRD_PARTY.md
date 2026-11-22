# Upstream components

The official tools remain upstream code, with their original licenses:

- Laravel Boost 2.10.4: https://github.com/laravel/boost (MIT).
- Laravel MCP and Boost's other locked PHP dependencies retain notices under vendor/.
- Next DevTools MCP 0.4.0: https://github.com/vercel/next-devtools-mcp (MIT).
- MCP TypeScript SDK: its notice accompanies the bundled worker in the Laravel image;
  Next's image retains its node_modules licenses.
- Chromium 158.0.8127.36-r0: distributed by Alpine Linux; Chromium's BSD-style license
  and third-party components have their own notices. See https://www.chromium.org/chromium-projects/
  and the installed Alpine package license records. It runs only inside the restricted
  inspection image, never as a browser installed on the API host.

Bun, Node, PHP and the base Linux image retain their upstream distribution notices.
Do not strip vendor/package license files when packaging these trusted images.
