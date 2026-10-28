<?php
/**
 * Trusted Artisan bridge, invoked only in an offline migration container.
 * INPUT: bounded JSON on stdin containing one resource's migrator credentials/paths.
 * OUTPUT: a fixed success marker or a redacted failure; generated console output is discarded.
 * STEPS: validate identity, ignore cached config, bootstrap Laravel, force the scoped
 * Unix-socket connection, run only the reviewed paths, then confirm native completion.
 * The caller owns source/digest checks, image identity, deadlines, leases and cleanup.
 * This bridge alone is not authorization to run migrations or expose a database API.
 */
const MAX_INPUT_BYTES = 65536;
const MAX_MIGRATIONS = 128;
const DATABASE_SOCKET_DIRECTORY = '/run/wrenly-database';
const DATABASE_SOCKET_PORT = 6432;

try {
    $raw = stream_get_contents(STDIN, MAX_INPUT_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_INPUT_BYTES) {
        throw new RuntimeException('Invalid input');
    }
    $request = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($request)) {
        throw new RuntimeException('Invalid input');
    }
    $keys = array_keys($request);
    sort($keys);
    if ($keys !== ['password', 'paths', 'resourceId', 'user'] ||
        !is_string($request['resourceId']) ||
        !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/D', $request['resourceId']) ||
        $request['user'] !== 'wrenly_'.str_replace('-', '', $request['resourceId']).'_migrate' ||
        !is_string($request['password']) || !preg_match('/^[a-f0-9]{64}$/D', $request['password']) ||
        !is_array($request['paths']) || !array_is_list($request['paths']) ||
        count($request['paths']) < 1 || count($request['paths']) > MAX_MIGRATIONS) {
        throw new RuntimeException('Invalid identity');
    }
    $seen = [];
    foreach ($request['paths'] as $path) {
        if (!is_string($path) || strlen($path) > 256 ||
            !preg_match('~^database/migrations/[a-zA-Z0-9_-]+\.php$~D', $path) || isset($seen[$path])) {
            throw new RuntimeException('Invalid path');
        }
        $seen[$path] = true;
    }

    // Secrets stay in process memory/stdin, never Docker Env/Cmd or source files.
    // Providers may run during bootstrap, so give them only this migrator connection.
    foreach (['APP_ENV' => 'production', 'APP_DEBUG' => 'false',
        'APP_KEY' => 'base64:'.base64_encode(random_bytes(32)),
        'DB_CONNECTION' => 'pgsql', 'DB_HOST' => DATABASE_SOCKET_DIRECTORY,
        'DB_PORT' => (string) DATABASE_SOCKET_PORT, 'DB_DATABASE' => 'app',
        'DB_USERNAME' => $request['user'], 'DB_PASSWORD' => $request['password'],
        'SESSION_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'LOG_CHANNEL' => 'stderr'] as $key => $value) {
        putenv($key.'='.$value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }
    if (file_exists('/app/bootstrap/cache/config.php') || file_exists('/app/.env')) {
        throw new RuntimeException('Unexpected runtime configuration');
    }
    foreach (['/app/storage/framework/sessions', '/app/storage/framework/views',
        '/app/storage/framework/cache', '/app/storage/logs'] as $directory) {
        if (!is_dir($directory) && !mkdir($directory, 0700, true)) {
            throw new RuntimeException('Runtime directory unavailable');
        }
    }
    chdir('/app');
    require '/app/vendor/autoload.php';
    $app = require '/app/bootstrap/app.php';
    $kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
    $kernel->bootstrap();
    $app->make('config')->set('database.default', 'wrenly_migrator');
    $app->make('config')->set('database.connections.wrenly_migrator', [
        'driver' => 'pgsql', 'host' => DATABASE_SOCKET_DIRECTORY,
        'port' => DATABASE_SOCKET_PORT, 'database' => 'app',
        'username' => $request['user'], 'password' => $request['password'],
        'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public',
        'sslmode' => 'disable', // Local authenticated Unix socket; no IP destination.
    ]);
    $input = new Symfony\Component\Console\Input\ArrayInput([
        'command' => 'migrate', '--force' => true, '--no-interaction' => true,
        '--database' => 'wrenly_migrator', '--path' => $request['paths'],
    ]);
    $output = new Symfony\Component\Console\Output\NullOutput();
    $code = $kernel->handle($input, $output);
    $kernel->terminate($input, $code);
    if ($code !== 0) {
        throw new RuntimeException('Migration failed');
    }
    // Native journal identity must match the whole reviewed migration history.
    // Exit zero alone could represent a no-op or an application-overridden command.
    $expected = array_map(static fn (string $path): string => basename($path, '.php'), $request['paths']);
    $applied = $app->make('migration.repository')->getRan();
    sort($expected);
    sort($applied);
    if ($applied !== $expected) {
        throw new RuntimeException('Migration journal mismatch');
    }
    fwrite(STDOUT, "WRENLY_DATABASE_MIGRATIONS_APPLIED_V1\n");
} catch (Throwable $error) {
    fwrite(STDERR, "Laravel database migration could not be confirmed.\n");
    exit(1);
}
