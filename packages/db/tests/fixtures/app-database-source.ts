// Minimal saved-source fixtures for metadata/journal tests; they do not prove app execution.
import { laravelFixture } from "../../../sandbox/tests/laravel-fixture";
export function appDatabaseSource(
  framework: "nextjs" | "laravel",
): Array<{ path: string; content: string }> {
  const path =
    framework === "nextjs"
      ? "drizzle/0000_notes.sql"
      : "database/migrations/2026_10_24_000000_notes.php";
  const manifest = {
    path: "wrenly.app.json",
    content: JSON.stringify({
      version: 1,
      database: {
        engine: "postgresql",
        adapter: framework === "nextjs" ? "drizzle-postgres" : "laravel",
        migrations: [path],
      },
    }),
  };
  if (framework === "laravel")
    return [
      ...laravelFixture(),
      manifest,
      {
        path,
        content: String.raw`<?php return new class extends \Illuminate\Database\Migrations\Migration { public function up(): void {} public function down(): void {} };`,
      },
    ];
  return [
    manifest,
    { path, content: "CREATE TABLE notes(id integer PRIMARY KEY);" },
    {
      path: "drizzle/meta/_journal.json",
      content: JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            tag: "0000_notes",
            when: 1,
            breakpoints: true,
          },
        ],
      }),
    },
  ];
}
