<?php
// Load the app's own framework first; extra development tools never replace its dependencies.
require '/app/vendor/autoload.php';
$tools = require '/wrenly/boost/vendor/autoload.php';
$tools->unregister();
$tools->register(false);
$app = require '/app/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();
config(['boost.enabled' => true, 'boost.browser_logs_watcher' => false]);
$app->register(Laravel\Mcp\Server\McpServiceProvider::class);
$app->register(Laravel\Boost\BoostServiceProvider::class);
exit($kernel->call('boost:mcp'));
