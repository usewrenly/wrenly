# Saving project details

When the owner renames a booking app, the settings screen sends the new name along
with the name/description it originally loaded. The API checks that those original
values still match. This prevents overwriting a newer edit from another tab or device unknowingly.

`project-settings.ts` validates returned display details and requires their project
ID to match the requested project, including conflict responses. It sends authenticated
same-origin requests without caching and with a 10-second deadline. The API remains
responsible for ownership and write authorization.

A conflict response includes the current matching project details for explicit review.
A lost response is not proof the save failed: the screen keeps the reviewed change
and offers a saved-state check rather than silently submitting another edit. Network
failures never substitute another project's details or editable blank defaults.

The UI is `components/workspace/settings/project-settings.tsx`; sharing, archive and project
model permissions have their own controls and API operations. This metadata client
does not change access, publish an app or delete resources.

From the repository root:

```bash
bun test apps/web/lib/projects/settings/tests/unit
```

Full browser save/recovery acceptance lives with the API projects browser tests.
