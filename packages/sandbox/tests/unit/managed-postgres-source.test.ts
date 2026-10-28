import { expect, test } from "bun:test";
import { managedDatabaseRenderingProblem, managedPostgresConnectionProblem } from "../../src/source-policy/managed-postgres-source";
const source = (content: string) => [{ path: "db/index.ts", content }];
test("managed Postgres.js rejects the saved preview's URL fallback and returns credential-free repair guidance", () => {
  const problem = managedPostgresConnectionProblem(source(`import postgres from 'postgres';const url=process.env.DATABASE_URL || 'postgres://example:private-value@localhost/db';const sql=postgres(url);`));
  expect(problem).toContain("PGHOST");
  expect(problem).toContain("not DATABASE_URL");
  expect(problem).not.toContain("private-value");
  expect(managedPostgresConnectionProblem(source(`const postgres=require('postgres');postgres(process.env['POSTGRES_URL']);`))).not.toBeNull();
});
test("managed Postgres.js accepts PG defaults and explicit socket options without interpreting code or comments", () => {
  for (const text of [
    `import postgres from 'postgres';const sql=postgres();`,
    `import postgres from 'postgres';const sql=postgres({host:process.env.PGHOST,database:process.env.PGDATABASE,username:process.env.PGUSER,password:process.env.PGPASSWORD});`,
    `import postgres from 'postgres';/* do not use process.env.DATABASE_URL */const sql=postgres();`,
    `import postgres from 'postgres';// never use 'postgres://example:secret@localhost/db'\nconst sql=postgres();`,
  ]) expect(managedPostgresConnectionProblem(source(text))).toBeNull();
  expect(managedPostgresConnectionProblem([{path:"README.md",content:"postgres://example@localhost/db"}])).toBeNull();
});

test("database server pages cannot query a missing database during offline prerendering", () => {
  const page = { path: "app/page.tsx", content: "import {getNotes} from './actions';export default async function Page(){const notes=await getNotes();return null;}" };
  expect(managedDatabaseRenderingProblem([page])).toContain("force-dynamic");
  for (const exportLine of ["export const dynamic='force-dynamic';", "export const revalidate=0;"]) {
    expect(managedDatabaseRenderingProblem([{...page,content:exportLine+page.content}])).toBeNull();
    expect(managedDatabaseRenderingProblem([page,{path:'app/layout.tsx',content:exportLine+'export default function Layout(){return null;}'}])).toBeNull();
  }
  expect(managedDatabaseRenderingProblem([{...page,content:'"use client";\nexport default function Page(){return null;}'}])).toBeNull();
  expect(managedDatabaseRenderingProblem([{...page,content:"// export const dynamic='force-dynamic'\n"+page.content}])).not.toBeNull();
});
