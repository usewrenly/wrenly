# Reading project summaries

The sidebar and Projects page need a compact description of each accessible app,
such as “Booking app · Laravel · build failed.” They do not need its generated files,
full build logs or request metadata.

`contracts.ts` validates and projects the response from the project-list API. It
checks names, timestamps, optional archive/sharing facts and the latest saved build's
identity, state and attempt count. An unreadable response produces an error instead
of being treated as an empty account. Unknown extra fields are not retained.

The `Project` type comes from this schema, so its compile-time shape and runtime
validation have one owner. `hooks/use-projects.ts` handles authenticated requests,
no caching, cancellation/deadlines and distinct expired-session errors. It re-exports
the type for existing hook consumers without defining a second copy.

The API decides which projects the user may access. Validating a summary does not
grant access to the source, previews or publishing operations. The server's collection
pagination/performance review is a separate concern from validating returned data.

```bash
bun test apps/web/lib/projects/collection/tests/unit
```
