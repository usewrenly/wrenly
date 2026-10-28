# Trusted operator toolchain, never built from generated application Dockerfiles.
FROM composer:2 AS composer
FROM oven/bun:1-alpine AS bun
FROM dunglas/frankenphp:1-php8.4-alpine
RUN install-php-extensions bcmath mbstring pdo_pgsql zip intl
# Bind only unprivileged port 3000: file capabilities conflict with CapDrop ALL.
RUN setcap -r /usr/local/bin/frankenphp
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY Caddyfile verify.ts migrate.php migration-watchdog.ts /wrenly/
WORKDIR /app
ENTRYPOINT []
CMD ["frankenphp", "run", "--config", "/wrenly/Caddyfile"]
EXPOSE 3000
