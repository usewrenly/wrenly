FROM oven/bun:alpine AS builder
WORKDIR /source
COPY src/deployment-runtime/ ./
RUN bun build ingress-entry.mts --target=bun --env=disable --outfile=/ingress.js

FROM oven/bun:alpine
USER root
COPY --from=builder /ingress.js /wrenly/ingress.js
RUN chmod 0444 /wrenly/ingress.js
LABEL io.wrenly.runtime-role="deployment-ingress" io.wrenly.runtime-version="1"
USER 1000:1000
ENTRYPOINT ["bun", "--no-env-file", "/wrenly/ingress.js"]
