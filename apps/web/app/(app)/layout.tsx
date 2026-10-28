// apps/web/app/(app)/layout.tsx
//
// App layout — hairline Shell chrome (top bar + project rail) around all
// authenticated routes. AuthGuard handles session redirects.

import { AuthGuard } from '@/components/auth/auth-guard'
import { Shell } from '@/components/shell/shell'

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthGuard>
      <Shell>{children}</Shell>
    </AuthGuard>
  )
}