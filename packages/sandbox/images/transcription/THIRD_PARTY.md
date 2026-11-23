# Third-party speech components

Whisper.cpp is distributed under MIT. This image builds revision
`d1be6fde11ac6e0407606b4e42fe72d34add8037` (v1.9.5). The Dockerfile copies its LICENSE
into `/wrenly/WHISPER_LICENSE` so the notice accompanies the binary.

Source and license:
https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037
https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/LICENSE

The optional converted multilingual base weights come from the upstream model repository,
whose model card declares MIT. They are downloaded separately, not included in Wrenly's
source or image. Preserve the model notices when redistributing weights.
https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1

The upstream JFK speech sample is used only as an opt-in acceptance fixture. No user's
recording is part of the tests or source distribution.
