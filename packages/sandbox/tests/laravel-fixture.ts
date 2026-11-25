import { LARAVEL_SKELETON } from '../../agents/laravel-agent/src/skeleton'

/** Source-only fixture; PHP is executed exclusively in the Docker test adapters. */
export function laravelFixture(): Array<{ path: string; content: string }> {
  return [...LARAVEL_SKELETON.map(file => ({ ...file })),
    { path: 'resources/views/welcome.blade.php', content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Laravel acceptance</title></head><body><main><p class="eyebrow">WRENLY / LARAVEL</p><h1>Équipe, together.</h1><p>Working Blade, isolated runtime, local assets.</p><button>Start a project</button></main></body></html>` },
    { path: 'public/app.css', content: 'body{margin:0;background:#f4f2ec;color:#25241f;font:18px system-ui}main{max-width:680px;margin:12vh auto;padding:32px;border:1px solid #d7d3c8;border-radius:16px;background:#faf9f5}h1{font-size:56px;letter-spacing:-3px}.eyebrow{font-size:12px;letter-spacing:3px}button{background:#25241f;color:white;border:0;padding:14px 24px;border-radius:8px}' },
  ]
}

/** Source-only Inertia + React Laravel 13 fixture; installs and compiles inside Docker only. */
export function laravelInertiaFixture(): Array<{ path: string; content: string }> {
  const base = LARAVEL_SKELETON.map(file => ({ ...file }))
  const composerIndex = base.findIndex(file => file.path === 'composer.json')
  base[composerIndex] = {
    path: 'composer.json',
    content: JSON.stringify({
      name: 'wrenly/generated-inertia-app',
      type: 'project',
      require: {
        php: '^8.4',
        'laravel/framework': '^13.0',
        'inertiajs/inertia-laravel': '^3.0',
      },
      autoload: { 'psr-4': { 'App\\': 'app/' } },
    }, null, 2),
  }
  const bootstrapIndex = base.findIndex(file => file.path === 'bootstrap/app.php')
  base[bootstrapIndex] = {
    path: 'bootstrap/app.php',
    content: `<?php
return Illuminate\\Foundation\\Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php', commands: __DIR__.'/../routes/console.php', health: '/up')
    ->withMiddleware(function (Illuminate\\Foundation\\Configuration\\Middleware $middleware) {
        $middleware->web(append: [\\App\\Http\\Middleware\\HandleInertiaRequests::class]);
    })
    ->withExceptions(function (Illuminate\\Foundation\\Configuration\\Exceptions $exceptions) {})
    ->create();
`,
  }
  const routesIndex = base.findIndex(file => file.path === 'routes/web.php')
  base[routesIndex] = {
    path: 'routes/web.php',
    content: `<?php
use Illuminate\\Support\\Facades\\Route;
use Inertia\\Inertia;

Route::get('/', fn () => Inertia::render('Home', [
    'heading' => 'Équipe, Inertia ready.',
]));
`,
  }
  return [
    ...base,
    {
      path: 'app/Http/Middleware/HandleInertiaRequests.php',
      content: `<?php
namespace App\\Http\\Middleware;

use Illuminate\\Http\\Request;
use Inertia\\Middleware;

class HandleInertiaRequests extends Middleware
{
    protected $rootView = 'app';

    public function share(Request $request): array
    {
        return array_merge(parent::share($request), []);
    }
}
`,
    },
    {
      path: 'resources/views/app.blade.php',
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/app.css">
  @inertiaHead
</head>
<body>
  @inertia
  <script type="module" src="/build/app.js"></script>
</body>
</html>
`,
    },
    {
      path: 'public/app.css',
      content: 'body{margin:0;background:#f4f2ec;color:#25241f;font:18px system-ui}main{max-width:680px;margin:12vh auto;padding:32px;border:1px solid #d7d3c8;border-radius:16px;background:#faf9f5}',
    },
    {
      path: 'package.json',
      content: JSON.stringify({
        type: 'module',
        scripts: {
          build: 'bun build resources/js/app.tsx --outdir public/build --entry-naming=app.js --minify --target=browser',
        },
        dependencies: {
          '@inertiajs/react': '^3.0.0',
          react: '^19.0.0',
          'react-dom': '^19.0.0',
        },
      }, null, 2),
    },
    {
      path: 'resources/js/Pages/Home.tsx',
      content: `import React from 'react'

export default function Home({ heading }: { heading: string }) {
  return (
    <main>
      <h1>{heading}</h1>
    </main>
  )
}
`,
    },
    {
      path: 'resources/js/app.tsx',
      content: `import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInertiaApp } from '@inertiajs/react'
import Home from './Pages/Home'

const pages: Record<string, React.ComponentType<any>> = { Home }

createInertiaApp({
  resolve: (name) => pages[name],
  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />)
  },
})
`,
    },
  ]
}
