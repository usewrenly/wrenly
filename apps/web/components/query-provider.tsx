//
// React Query provider — manages server state for project and build data.
// All data fetching in the app goes through React Query for caching,
// background refetch, and loading/error states.

'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // Create QueryClient inside component to avoid shared state across requests
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,   // 30 seconds before refetch
        retry: 1,            // retry once on failure
      },
    },
  }))

  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  )
}