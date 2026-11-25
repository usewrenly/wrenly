/** Source-only Next.js 16 + Tailwind 3.4 starter fixture; installs and builds inside Docker only. */
export function nextjs16Fixture(): Array<{ path: string; content: string }> {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "nextjs-16-fixture",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            next: "16.4.5",
            react: "19.2.0",
            "react-dom": "19.2.0",
          },
          devDependencies: {
            typescript: "5.8.3",
            "@types/react": "19.1.2",
            "@types/react-dom": "19.1.2",
            "@types/node": "22.14.0",
            tailwindcss: "3.4.19",
            postcss: "8.5.30",
            autoprefixer: "10.6.1",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    },
    {
      path: "next.config.ts",
      content: `import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
`,
    },
    {
      path: "tailwind.config.ts",
      content: `import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
`,
    },
    {
      path: "postcss.config.mjs",
      content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`,
    },
    {
      path: "app/globals.css",
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
    },
    {
      path: "app/layout.tsx",
      content: `import type { ReactNode } from 'react'
import './globals.css'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  )
}
`,
    },
    {
      path: "app/page.tsx",
      content: `export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-semibold">Wrenly Next.js 16</h1>
    </main>
  )
}
`,
    },
    {
      path: "app/items/[id]/page.tsx",
      content: `export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <main className="mx-auto max-w-2xl p-8">
      <p className="text-base">Item {id}</p>
    </main>
  )
}
`,
    },
  ]
}
