# Local speech runtime

This trusted image turns one short WAV recording into words. It runs Whisper.cpp's
CPU CLI, then exits. It is separate from generated apps and does not use their model
provider credentials. The API owns the request lifecycle and the browser reviews recognized text before
inserting it. Building this image alone does not enable dictation; follow the
voice-dictation guide to configure the model and opt in.

The source revision and multilingual base model are pinned in `model-manifest.json`.
The Dockerfile also pins its base images. It builds no server, ffmpeg converter or
remote speech client. `transcribe.ts` accepts only canonical audio over stdin, keeps
that input open as a controller-lifetime signal and stops native inference on EOF or
a 90-second deadline. Audio is written only to the container's private `/tmp` mount.

From the repository root:

```bash
docker build -t wrenly/transcription-runtime:1 \
  -f packages/sandbox/images/transcription/Dockerfile .
```

The image must only run through a verified lifecycle adapter with network disabled,
read-only root/model, private tmpfs, non-root identity, 2 CPU, 1 GiB RAM, pids 64, dropped
capabilities, no-new-privileges and **Docker logging disabled**. Its stdout contains the
transcript, so a default Docker log driver would retain private content. Never mount
the Docker socket, host audio directories or instance credentials in this image.

Model download is an explicit installation step, not a recording side effect. Verify
both the exact 147,951,465 byte size and SHA-256 in the manifest. The official pinned URL is:

```text
https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin
```

No weights are committed or bundled. Preserve upstream license notices when distributing
this image or model. The upstream project and model repository declare MIT licensing;
see THIRD_PARTY.md. Offline/native/microphone checks remain distinct: a known-audio test
proves engine execution, not recognition accuracy for every speaker or language.
