// COMPONENT: Laravel source policy and trusted runtime commands
// Composer plugins/scripts and Bun lifecycle hooks stay disabled during installation.
// Generated PHP and asset builds run only in the subsequent offline container.
import { randomBytes } from 'node:crypto'
import { validateFilePaths } from './file-paths'

export const LARAVEL_RUNTIME_IMAGE = 'wrenly/laravel-runtime:13-php8.4'
export const LARAVEL_START_COMMAND = ['frankenphp', 'run', '--config', '/wrenly/Caddyfile']
export const LARAVEL_INSTALL_COMMAND = ['sh', '-ec',
  'composer install --no-interaction --prefer-dist --no-dev --no-plugins --no-scripts --no-progress && ' +
  'composer audit --locked --no-plugins --no-scripts && ' +
  'if [ -f package.json ]; then bun install --ignore-scripts --cache-dir /tmp/bun-cache; fi']
const LARAVEL_COMPILE_SCRIPT =
  'mkdir -p bootstrap/cache storage/framework/sessions storage/framework/views storage/framework/cache storage/logs && ' +
  'composer dump-autoload --no-dev --no-plugins --no-scripts && ' +
  'php -l artisan && find app routes config bootstrap public -name "*.php" -print0 | xargs -0 -n1 php -l && ' +
  'php artisan package:discover --ansi && php artisan route:list && php artisan view:cache && ' +
  'if [ -f package.json ]; then bun run build; fi'
// Database image preparation must compile without probing a page that needs a
// database. The later disposable validation performs that HTTP check with a socket.
export const LARAVEL_COMPILE_COMMAND = ['sh', '-ec', LARAVEL_COMPILE_SCRIPT]
export const LARAVEL_BUILD_COMMAND = ['sh', '-ec', `${LARAVEL_COMPILE_SCRIPT} && bun /wrenly/verify.ts`]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Rejects executable installation policy and unsupported revisions before Docker effects. */
export function validateLaravelSource(files: Array<{ path: string; content: string }>): void {
  validateFilePaths(files)
  const required = ['composer.json', 'artisan', 'bootstrap/app.php', 'bootstrap/providers.php', 'routes/web.php',
    'routes/console.php', 'public/index.php', 'config/app.php', 'config/session.php', 'config/cache.php', 'config/logging.php']
  if (required.some(name => !files.some(file => file.path === name)))
    throw new Error('Laravel 13 source is missing required bootstrap, route or configuration files.')
  if (files.some(file => file.path.split('/').some(part => ['vendor', 'node_modules', '.git'].includes(part) ||
    part.startsWith('.env') && part !== '.env.example') || file.path.startsWith('bootstrap/cache/') || file.path.startsWith('storage/')))
    throw new Error('Laravel source cannot include installed dependencies, private environments or generated runtime caches.')
  if (files.some(file => file.path === '.env.example' && /^\s*APP_KEY\s*=/m.test(file.content)))
    throw new Error('Laravel application keys are injected at runtime; do not define APP_KEY in generated source.')
  const composer: unknown = JSON.parse(files.find(file => file.path === 'composer.json')!.content)
  if (!record(composer) || !record(composer.require) || typeof composer.require['laravel/framework'] !== 'string' ||
    !/^\^13\.\d+(?:\.\d+)?$/.test(composer.require['laravel/framework']))
    throw new Error('This runtime requires Laravel ^13.0. Existing projects are not automatically upgraded.')
  if ('scripts' in composer || 'repositories' in composer || composer.type === 'composer-plugin' ||
    Object.keys(composer.require).some(name => name === 'composer-plugin-api' || name === 'composer-runtime-api') ||
    'config' in composer && (!record(composer.config) || Object.keys(composer.config).some(key =>
      !['optimize-autoloader', 'sort-packages', 'preferred-install'].includes(key))))
    throw new Error('Laravel installation does not accept Composer scripts, plugins, custom repositories or policy overrides.')
  // A browser cannot compile utility directives; without an asset build these files
  // would load successfully while leaving the generated page visibly unstyled.
  if (!files.some(file => file.path === 'package.json') && files.some(file =>
    file.path.startsWith('public/') && file.path.endsWith('.css') &&
    /@(tailwind|apply|theme|utility|source|config|plugin)\b|@import\s*(?:url\()?\s*["']tailwindcss(?:["'/])/i.test(file.content.replace(/\/\*[\s\S]*?\*\//g, ''))))
    throw new Error('Laravel public CSS contains uncompiled Tailwind instructions. Supply complete CSS rules or an offline asset build that compiles the stylesheet linked by Blade.')
  const manifest = files.find(file => file.path === 'package.json')
  if (manifest) {
    const value: unknown = JSON.parse(manifest.content)
    if (!record(value) || !record(value.scripts) || typeof value.scripts.build !== 'string' ||
      Object.keys(value.scripts).some(name => name !== 'build') || 'trustedDependencies' in value || 'workspaces' in value)
      throw new Error('Laravel assets require only an offline build script; install hooks and trusted dependencies are unsupported.')
  }
  if (files.some(file => /(?:^|\/)(?:composer\.phar|auth\.json|\.npmrc|bunfig\.toml)$/.test(file.path)))
    throw new Error('Laravel source cannot override trusted package tooling or include package credentials.')
}

/** Preview and validation keys are ephemeral and never written into source or committed images. */
export function laravelValidationEnvironment(): string[] {
  return ['APP_ENV=production', 'APP_DEBUG=false', `APP_KEY=base64:${randomBytes(32).toString('base64')}`,
    'SESSION_DRIVER=file', 'CACHE_STORE=array', 'LOG_CHANNEL=stderr', 'HOME=/tmp',
    'COMPOSER_HOME=/tmp/composer', 'COMPOSER_CACHE_DIR=/tmp/composer-cache',
    'XDG_CONFIG_HOME=/tmp/config', 'XDG_DATA_HOME=/tmp/data', 'NODE_ENV=development']
}
