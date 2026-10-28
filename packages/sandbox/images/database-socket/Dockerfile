FROM oven/bun:alpine
USER root
RUN apk add --no-cache pgbouncer \
    && mkdir -p /run/wrenly-database \
    && chown 1000:1000 /run/wrenly-database \
    && chmod 0755 /run/wrenly-database
COPY entrypoint.ts /wrenly/entrypoint.ts
USER 1000:1000
ENTRYPOINT ["bun", "--no-env-file", "/wrenly/entrypoint.ts"]
