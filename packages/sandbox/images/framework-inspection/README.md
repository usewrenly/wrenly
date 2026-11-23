# Framework inspection toolchains

These optional images let Wrenly inspect a disposable installed copy of an application
using the framework's official MCP development tools. They are separate from app
runtime images and receive no database socket or instance/provider credentials.

Dependencies are prepared at image-build time from fixed manifests and lockfiles.
Running an inspection must not download packages or contact hosted documentation.
Application source is mounted read-only and caches use temporary container storage.
