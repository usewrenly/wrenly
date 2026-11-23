# Source is immutable; the host verifies the resulting local image identity before use.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS builder
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src \
    && git remote add origin https://github.com/ggml-org/whisper.cpp.git \
    && git fetch --depth=1 origin d1be6fde11ac6e0407606b4e42fe72d34add8037 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = d1be6fde11ac6e0407606b4e42fe72d34add8037 \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build build --target whisper-cli -j2
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
USER root
RUN mkdir -p /wrenly /model && chmod 0755 /wrenly /model
COPY --from=builder /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=builder /src/LICENSE /wrenly/WHISPER_LICENSE
COPY packages/audio/src /wrenly/audio
COPY packages/sandbox/images/transcription/transcribe.ts /wrenly/transcribe.ts
LABEL org.wrenly.transcription.version="1" \
      org.wrenly.transcription.whisper-revision="d1be6fde11ac6e0407606b4e42fe72d34add8037"
USER 1000:1000
ENTRYPOINT ["bun", "--no-env-file", "/wrenly/transcribe.ts"]
