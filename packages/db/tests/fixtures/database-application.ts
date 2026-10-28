// Real framework pages perform insert/read/update/delete through runtime credentials.
// These sources are compiled/executed only inside trusted Docker adapters.
import { laravelFixture } from "../../../sandbox/tests/laravel-fixture";
export function databaseApplication(
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
  if (framework === "laravel") {
    const files = laravelFixture();
    files.find((file) => file.path === "routes/web.php")!.content =
      String.raw`<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\DB;
Route::get('/', function () {
    DB::table('notes')->updateOrInsert(['id'=>1], ['body'=>'created']);
    if (DB::table('notes')->where('id',1)->value('body') !== 'created') { abort(500); }
    DB::table('notes')->where('id',1)->update(['body'=>'verified']);
    if (DB::table('notes')->where('id',1)->value('body') !== 'verified') { abort(500); }
    DB::table('notes')->where('id',1)->delete();
    if (DB::table('notes')->where('id',1)->exists()) { abort(500); }
    return response('<!doctype html><link rel="stylesheet" href="/app.css"><h1>Runtime database CRUD verified</h1>');
});`;
    return [
      ...files,
      manifest,
      {
        path,
        content: String.raw`<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
  public function up(): void { Schema::create('notes', function (Blueprint $table) { $table->integer('id')->primary(); $table->text('body'); }); }
  public function down(): void { Schema::dropIfExists('notes'); }
};`,
      },
    ];
  }
  return [
    manifest,
    {
      path,
      content:
        "CREATE TABLE notes(id integer PRIMARY KEY, body text NOT NULL);",
    },
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
    {
      path: "package.json",
      content: JSON.stringify({
        name: "database-application-fixture",
        scripts: { build: "next build" },
        dependencies: {
          next: "15.5.28",
          react: "19.3.1",
          "react-dom": "19.3.1",
          postgres: "3.4.9",
          "drizzle-orm": "0.45.3",
        },
      }),
    },
    {
      path: "next.config.mjs",
      content: "export default {experimental:{cpus:1}}",
    },
    {
      path: "app/layout.jsx",
      content:
        "export default function Layout({children}){return <html lang='en'><body>{children}</body></html>}",
    },
    {
      path: "app/page.jsx",
      content: `import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {pgTable,integer,text} from 'drizzle-orm/pg-core';
import {eq} from 'drizzle-orm';
export const dynamic='force-dynamic';
const notes=pgTable('notes',{id:integer('id').primaryKey(),body:text('body').notNull()});
export default async function Page(){
 const client=postgres({max:1,connect_timeout:3}); const db=drizzle(client);
 try {
  await db.insert(notes).values({id:1,body:'created'}).onConflictDoUpdate({target:notes.id,set:{body:'created'}});
  if((await db.select().from(notes).where(eq(notes.id,1)))[0]?.body!=='created') throw Error('Read failed');
  await db.update(notes).set({body:'verified'}).where(eq(notes.id,1));
  if((await db.select().from(notes).where(eq(notes.id,1)))[0]?.body!=='verified') throw Error('Update failed');
  await db.delete(notes).where(eq(notes.id,1));
  if((await db.select().from(notes).where(eq(notes.id,1))).length) throw Error('Delete failed');
  return <main>Runtime database CRUD verified</main>;
 } finally { await client.end({timeout:1}); }
}`,
    },
  ];
}
