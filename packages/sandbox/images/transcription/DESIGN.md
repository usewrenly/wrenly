COMPONENT: One-recording trusted Whisper process
PURPOSE: Stop native inference after a bounded recording, deadline or API disconnect.
INPUTS: One canonical WAV over stdin; verified read-only multilingual model at fixed path.
OUTPUTS: Bounded transcript JSON on stdout; no retained audio or native diagnostics.
STEPS:
1. Read the fixed WAV header then exactly its declared bounded payload while keeping
   stdin open. EOF before completion fails. A separate90-second deadline covers input.
2. Validate canonical bytes again and write only /tmp/recording.wav in private tmpfs.
3. Start fixed CPU-only CLI flags without environment secrets or arbitrary arguments.
4. Race child completion against stdin EOF and the deadline. Host keeps stdin open
   until completion, so early EOF means its controlling process disappeared.
5. Kill/await child on abort; bound stdout as it arrives. Discard all temporary files
   when Docker removes the exact labelled container. Host independently verifies cleanup.
EDGE CASES: Truncated header,extra input,disconnect during inference,oversized stdout.
ERROR STATES: Nonzero exit with no raw audio/transcript diagnostics. HTTP adapter maps
safe errors only. Docker limits/network/ownership are enforced by the host adapter.
