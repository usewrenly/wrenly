import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("legacy single-user flag cannot bypass sessions or enable direct public signup", async () => {
  const sessionPath = resolve(import.meta.dir, "../../access/session.ts");
  const authPath = resolve(import.meta.dir, "../../configuration/auth.ts");
  const source = `import {getUserId,requireUserId} from ${JSON.stringify(sessionPath)};
    import {auth} from ${JSON.stringify(authPath)};
    if(await getUserId(new Headers())!==null)throw Error('Anonymous identity granted');
    let rejected=false;try{await requireUserId(new Headers())}catch{rejected=true}
    if(!rejected)throw Error('Ownership access bypassed');
    const response=await auth.handler(new Request('http://localhost:3002/api/auth/sign-up/email',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},
      body:JSON.stringify({name:'Fixture',email:'fixture@example.test',password:'fixture-password-123'})}));
    const body=await response.json();
    if(response.ok||body.code!=='EMAIL_PASSWORD_SIGN_UP_DISABLED')throw Error('Public signup not disabled');
    for (const path of ['create','invite-member','accept-invitation','get-full-organization']) {
      const blocked=await auth.handler(new Request('http://localhost:3002/api/auth/organization/'+path,{
        method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},body:'{}'}));
      if(blocked.ok)throw Error('Direct organization endpoint was exposed');
    }
    for (const path of ['request-password-reset','reset-password']) {
      const blocked = await auth.handler(new Request('http://localhost:3002/api/auth/'+path, {
        method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},
        body:JSON.stringify({email:'fixture@example.test',token:'untrusted',newPassword:'fixture-password'})}));
      if(blocked.status!==403)throw Error('Raw native password recovery was exposed');
    }
    const removed=await auth.handler(new Request('http://localhost:3002/api/auth/user-count'));
    if(removed.status!==404)throw Error('Removed public count endpoint remains available');
    process.stdout.write('POLICY_OK');process.exit(0);`;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: "/tmp",
    env: {
      PATH: "/usr/bin:/bin",
      WRENLY_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/unused",
      WRENLY_AUTH_SECRET: "fixture-secret-only-for-this-test-123456789",
      WRENLY_APP_URL: "http://localhost:3002",
      WRENLY_WEB_URL: "http://localhost:3000",
      WRENLY_SINGLE_USER_MODE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, errors).toBe(0);
    expect(output).toContain("POLICY_OK");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}, 8000);
