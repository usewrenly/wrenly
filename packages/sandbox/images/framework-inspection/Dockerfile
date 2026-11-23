FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS tools
WORKDIR /src
COPY packages/sandbox/images/framework-inspection/nextjs/package.json packages/sandbox/images/framework-inspection/nextjs/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/inference/package.json packages/inference/package.json
COPY packages/inference/src/framework-tooling packages/inference/src/framework-tooling
RUN mkdir -p node_modules/@wrenly && ln -s ../../packages/inference node_modules/@wrenly/inference
COPY packages/sandbox/src/framework-tooling/worker.ts packages/sandbox/src/framework-tooling/worker.ts
RUN bun build packages/sandbox/src/framework-tooling/worker.ts --target=bun --outfile=/worker.mjs
FROM wrenly/laravel-runtime:13-php8.4 AS boost
WORKDIR /wrenly/boost
COPY packages/sandbox/images/framework-inspection/laravel/composer.json packages/sandbox/images/framework-inspection/laravel/composer.lock ./
RUN composer install --no-dev --no-plugins --no-scripts --prefer-dist --no-interaction && composer audit --no-dev
FROM boost AS laravel
COPY --from=tools /src/node_modules/@modelcontextprotocol/sdk/LICENSE /wrenly/licenses/mcp-sdk.txt
COPY --from=tools /worker.mjs /wrenly/worker.mjs
COPY packages/sandbox/images/framework-inspection/boost-launcher.php /wrenly/boost-launcher.php
LABEL org.wrenly.framework-inspection="1" org.wrenly.framework="laravel" org.wrenly.upstream="9cd5e7d81300b5dee4c8b1619ec4b36f4a6367fd"
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["bun","--no-env-file","/wrenly/worker.mjs"]
FROM oven/bun:alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS alpine-bun
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS nextjs
RUN apk add --no-cache chromium=158.0.8127.36-r0
COPY --from=alpine-bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /src/node_modules /wrenly/tools/node_modules
COPY --from=tools /worker.mjs /wrenly/worker.mjs
LABEL org.wrenly.framework-inspection="1" org.wrenly.framework="nextjs" org.wrenly.upstream="95794e09857b87d7e6fb3f8caf9a2ee591e3e10f"
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["bun","--no-env-file","/wrenly/worker.mjs"]
