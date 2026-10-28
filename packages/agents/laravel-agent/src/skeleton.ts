// COMPONENT: Laravel 13 source skeleton
// Defaults supply framework boot files, not fabricated application features.
export const LARAVEL_SKELETON: Array<{ path: string; content: string }> = [
  { path: 'composer.json', content: JSON.stringify({ name: 'wrenly/generated-app', type: 'project',
    require: { php: '^8.4', 'laravel/framework': '^13.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }, null, 2) },
  { path: 'artisan', content: `#!/usr/bin/env php
<?php
define('LARAVEL_START', microtime(true));
require __DIR__.'/vendor/autoload.php';
$app = require_once __DIR__.'/bootstrap/app.php';
exit($app->handleCommand(new Symfony\\Component\\Console\\Input\\ArgvInput));
` },
  { path: 'bootstrap/app.php', content: `<?php
return Illuminate\\Foundation\\Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php', commands: __DIR__.'/../routes/console.php', health: '/up')
    ->withMiddleware(function (Illuminate\\Foundation\\Configuration\\Middleware $middleware) {})
    ->withExceptions(function (Illuminate\\Foundation\\Configuration\\Exceptions $exceptions) {})
    ->create();
` },
  { path: 'bootstrap/providers.php', content: '<?php return [];\n' },
  { path: 'public/index.php', content: `<?php
define('LARAVEL_START', microtime(true));
require __DIR__.'/../vendor/autoload.php';
$app = require_once __DIR__.'/../bootstrap/app.php';
$app->handleRequest(Illuminate\\Http\\Request::capture());
` },
  { path: 'config/app.php', content: `<?php
return ['name' => env('APP_NAME', 'Wrenly app'), 'env' => env('APP_ENV', 'production'),
    'debug' => (bool) env('APP_DEBUG', false), 'url' => env('APP_URL', 'http://localhost'),
    'timezone' => 'UTC', 'locale' => 'en', 'fallback_locale' => 'en', 'faker_locale' => 'en_US',
    'key' => env('APP_KEY'), 'cipher' => 'AES-256-CBC', 'previous_keys' => [],
    'maintenance' => ['driver' => 'file']];
` },
  { path: 'config/session.php', content: `<?php
return ['driver' => env('SESSION_DRIVER', 'file'), 'lifetime' => 120, 'encrypt' => false,
    'files' => storage_path('framework/sessions'), 'cookie' => 'app_session', 'path' => '/',
    'domain' => null, 'secure' => null, 'http_only' => true, 'same_site' => 'lax', 'lottery' => [2, 100]];
` },
  { path: 'config/cache.php', content: `<?php
return ['default' => env('CACHE_STORE', 'array'), 'stores' => ['array' => ['driver' => 'array', 'serialize' => false]], 'prefix' => 'app'];
` },
  { path: 'config/logging.php', content: `<?php
return ['default' => 'stderr', 'channels' => ['stderr' => ['driver' => 'monolog',
    'handler' => Monolog\\Handler\\StreamHandler::class, 'with' => ['stream' => 'php://stderr']]]];
` },
  { path: 'routes/console.php', content: '<?php\n' },
  { path: 'routes/web.php', content: `<?php
use Illuminate\\Support\\Facades\\Route;
Route::view('/', 'welcome');
` },
  { path: 'app/Http/Controllers/Controller.php', content: '<?php\nnamespace App\\Http\\Controllers;\nabstract class Controller {}\n' },
  { path: '.env.example', content: 'APP_NAME="My app"\nAPP_ENV=production\nAPP_DEBUG=false\nSESSION_DRIVER=file\nCACHE_STORE=array\nLOG_CHANNEL=stderr\n' },
]
