# Speech into an editable prompt

Transcription means turning recorded speech into written words. For example, a person
says “Make the heading larger”, reviews those words and inserts them into their draft.
This module never submits that draft, changes a project or calls the app-building model.

The HTTP factory authenticates before consuming audio, allows one recording at a time
per API process and validates the shared canonical WAV format. It rechecks the session
before returning text. The adapter is the replaceable piece that actually recognizes
speech; it must stop its native execution before its promise settles, including after
cancellation. Otherwise a new request could start while the old model still uses CPU.

Audio is temporary request data, not a saved attachment. Do not log it or its transcript.
The local runtime runs with no network access and bounded CPU/RAM. Startup enables native execution only after the owner opts in and the pinned local
artifacts pass verification. Without configuration, capability reads report unavailable
and transcription requests fail closed; normal typed chat stays available.
