// apps/web/next.config.ts
//
// Rewrites proxy all /api/* requests to apps/api.
// Keep browser requests on the web origin while forwarding them server-side to
// the configured API origin. Cookies are scoped by host/domain/path, not by port;
// the rewrite avoids browser CORS handling and keeps request paths consistent.

import type { NextConfig } from 'next'
import { readApiOrigin } from './lib/configuration/api-origin'
import { readDocumentationBase } from './lib/documentation-url'

readDocumentationBase(process.env.NEXT_PUBLIC_DOCS_URL, process.env.NODE_ENV)

const apiOrigin = readApiOrigin(process.env.NEXT_PUBLIC_API_URL)

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ]
  },
}

export default nextConfig