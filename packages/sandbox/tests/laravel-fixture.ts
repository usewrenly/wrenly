import { LARAVEL_SKELETON } from '../../agents/laravel-agent/src/skeleton'

/** Source-only fixture; PHP is executed exclusively in the Docker test adapters. */
export function laravelFixture(): Array<{ path: string; content: string }> {
  return [...LARAVEL_SKELETON.map(file => ({ ...file })),
    { path: 'resources/views/welcome.blade.php', content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Laravel acceptance</title></head><body><main><p class="eyebrow">WRENLY / LARAVEL</p><h1>Équipe, together.</h1><p>Working Blade, isolated runtime, local assets.</p><button>Start a project</button></main></body></html>` },
    { path: 'public/app.css', content: 'body{margin:0;background:#f4f2ec;color:#25241f;font:18px system-ui}main{max-width:680px;margin:12vh auto;padding:32px;border:1px solid #d7d3c8;border-radius:16px;background:#faf9f5}h1{font-size:56px;letter-spacing:-3px}.eyebrow{font-size:12px;letter-spacing:3px}button{background:#25241f;color:white;border:0;padding:14px 24px;border-radius:8px}' },
  ]
}
