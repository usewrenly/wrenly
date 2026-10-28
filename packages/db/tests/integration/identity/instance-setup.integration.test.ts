import { saveProfilePicture, getProfilePicture, readProfilePicture } from "../../../../../apps/api/src/modules/auth/profile/pictures/profile-picture-store"
import { getAvailableCatalog, refreshProviderCatalog } from '../../../../../apps/api/src/modules/models/catalog/provider-catalog-store'
import { getOwnedBuild } from '../../../../../apps/api/src/modules/builds/persistence/build-queries'
import { createInvitationAuth } from '../../../../../apps/api/src/modules/auth/invitations/invitation-auth'
import { initializeInstanceMembership, listInstanceAccess, issueInstanceInvitation, inspectInstanceInvitation, acceptInstanceInvitation, revokeInstanceInvitation } from '../../../../../apps/api/src/modules/auth/invitations/invitation-store'
import { listLegacyProjects, reviewLegacyProjects, confirmLegacyProjects } from '../../../../../apps/api/src/modules/auth/recovery/legacy-project-recovery-store'
import { issueOwnerRecoveryProof, recoverInstanceOwner } from '../../../../../apps/api/src/modules/auth/recovery/owner-recovery-store'
import { resolve } from 'node:path'
import { createOwnerAccount } from '../../../../../apps/api/src/modules/auth/setup/owner-account'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { claimInstanceOwner, getInstanceSetupStatus, issueOwnerSetupProof } from '../../../../../apps/api/src/modules/auth/setup/instance-setup-store'
const url = process.env.WRENLY_TEST_SETUP_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/wrenly_setup_test') throw new Error('Use only a disposable local wrenly_setup_test database.')
}
const integration = url ? describe : describe.skip
integration('protected first-owner initialization', () => {
  const client = postgres(url ?? 'postgresql://localhost/wrenly_setup_test', { onnotice: () => {} })
  const database = drizzle(client, { schema })
  const config = { secret: 'fixture-auth-secret-012345678901234567890', apiUrl: 'http://localhost:3002', webUrl: 'http://localhost:3000' }
  const credentials = { name: 'Owner fixture', email: 'owner@example.test', password: 'test1234' }
  beforeAll(async () => { await migrate(database, { migrationsFolder: `${import.meta.dir}/../../../migrations` }) })
  afterEach(async () => {
    await database.delete(schema.memberAccessAudit)
    await database.delete(schema.providerCatalogRefreshAudit)
    await database.delete(schema.providerCatalogCache)
    await database.delete(schema.invitationAudit)
    await database.delete(schema.invitationAuthorization)
    await database.delete(schema.invitation)
    await database.delete(schema.member)
    await database.delete(schema.legacyProjectRecovery)
    await database.delete(schema.previewAccess)
    await database.delete(schema.previewRequests)
    await database.delete(schema.previews)
    await database.delete(schema.deployments)
    await database.delete(schema.deploymentResources)
    await database.delete(schema.conversations)
    await database.delete(schema.projects)
    await database.delete(schema.instanceOwnerRecoveryAudit)
    await database.delete(schema.instanceOwnerRecovery)
    await database.delete(schema.instanceSetup)
    await database.delete(schema.organization)
    // This entire database is explicitly isolated by the URL/name guard above.
    await database.delete(schema.user)
  })
  afterAll(async () => { await client.end() })
  test('proof is hashed, concurrent claims create one owner, credentials work with normal Better Auth', async () => {
    expect(await getInstanceSetupStatus(database)).toBe('setup-required')
    const proof = await issueOwnerSetupProof(database)
    const [pending] = await database.select().from(schema.instanceSetup)
    expect(pending?.proofHash).not.toBe(proof)
    expect(JSON.stringify(pending)).not.toContain(proof)
    await expect(claimInstanceOwner(database, { ...credentials, password: '1234567', proof, requestId: crypto.randomUUID() }, config)).rejects.toThrow('8–128')
    const input = { ...credentials, proof, requestId: crypto.randomUUID() }
    const results = await Promise.all([claimInstanceOwner(database, input, config), claimInstanceOwner(database, input, config)])
    expect(results.filter(result => result.replayed)).toHaveLength(1)
    expect(await database.select().from(schema.user)).toHaveLength(1)
    expect(await database.select().from(schema.account)).toHaveLength(1)
    expect(await database.select().from(schema.session)).toHaveLength(0)
    const [account] = await database.select().from(schema.account)
    expect(account?.password).not.toBe(credentials.password)
    expect(await getInstanceSetupStatus(database)).toBe('initialized')
    await expect(issueOwnerSetupProof(database)).rejects.toThrow('already has users')
    await expect(claimInstanceOwner(database, { ...input, requestId: crypto.randomUUID() }, config)).rejects.toThrow('already consumed')
    const authPath = resolve(import.meta.dir, '../../../../../apps/api/src/modules/auth/configuration/auth.ts')
    const script = `import {auth} from ${JSON.stringify(authPath)};
      const response=await auth.handler(new Request('http://localhost:3002/api/auth/sign-in/email',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ email: credentials.email, password: credentials.password }))}}));
      if(!response.ok)throw Error('Login failed');
      const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const verified=await auth.api.getSession({headers:new Headers({Cookie:cookie})});
      if(verified?.user.email!=='owner@example.test')throw Error('Session was not established');
      process.stdout.write('LOGIN_OK');process.exit(0);`

    const child = Bun.spawn([process.execPath, '--eval', script], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin', WRENLY_DATABASE_URL: url!,
      WRENLY_AUTH_SECRET: config.secret, WRENLY_APP_URL: config.apiUrl, WRENLY_WEB_URL: config.webUrl }, stdout: 'pipe', stderr: 'ignore' })
    const timeout = setTimeout(() => child.kill(), 5000)
    try { expect(await new Response(child.stdout).text()).toContain('LOGIN_OK'); expect(await child.exited).toBe(0) } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
    expect(await database.select().from(schema.session)).toHaveLength(1)
  })
  test('native account settings preserve ownership, validate names and rotate password sessions', async () => {
    const proof = await issueOwnerSetupProof(database)
    await claimInstanceOwner(database, { ...credentials, proof, requestId: crypto.randomUUID() }, config)
    await database.transaction(tx => createOwnerAccount(tx, config, { name: 'Other person', email: 'other@example.test', password: 'other123' }))
    const authPath = resolve(import.meta.dir, '../../../../../apps/api/src/modules/auth/configuration/auth.ts')
    const script = `import {auth} from ${JSON.stringify(authPath)};
      const check=(ok,label)=>{if(!ok)throw Error(label)};
      const call=(path,body,cookie='',origin='http://localhost:3000')=>auth.handler(new Request('http://localhost:3002/api/auth/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}));
      const cookies=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const session=cookie=>auth.api.getSession({headers:new Headers({Cookie:cookie}),query:{disableCookieCache:true}});
      const login=async(email,password)=>{const response=await call('sign-in/email',{email,password});check(response.ok,'Fixture login failed');return cookies(response)};
      const first=await login('owner@example.test','test1234'),second=await login('owner@example.test','test1234'),other=await login('other@example.test','other123');
      check((await call('update-user',{name:'Anonymous'})).status===401,'Anonymous profile write');
      check((await call('update-user',{name:'Forbidden'},first,'http://attacker.invalid')).status===403,'Untrusted origin profile write');
      for(const body of [{name:' '},{name:'x'.repeat(101)},{name:'Other',email:'changed@example.test'},{name:'Other',role:'owner'},{name:'Other',id:'another-user'}])check((await call('update-user',body,first)).status===400,'Profile shape escaped policy');
      check((await call('update-user',{name:'  Renamed owner  '},first)).ok,'Owner profile save failed');
      check((await session(first))?.user.name==='Renamed owner','Canonical profile not persisted');
      check((await session(other))?.user.name==='Other person','Another profile changed');
      check((await call('update-user',{name:'Renamed member'},other)).ok,'Member own profile rejected');
      check((await call('change-password',{currentPassword:'wrong123',newPassword:'fresh123',revokeOtherSessions:true},first)).status===400,'Wrong current password accepted');
      check((await call('change-password',{currentPassword:'test1234',newPassword:'1234567',revokeOtherSessions:true},first)).status===400,'Short new password accepted');
      const changed=await call('change-password',{currentPassword:'test1234',newPassword:'fresh123',revokeOtherSessions:true},first);check(changed.ok,'Password change failed');
      check(!(await session(first)),'Previous current session remained active');check(!(await session(second)),'Other owner session remained active');check((await session(cookies(changed)))?.user.name==='Renamed owner','Rotated session not established');check((await session(other))?.user.name==='Renamed member','Unrelated session revoked');
      check(!(await call('sign-in/email',{email:'owner@example.test',password:'test1234'})).ok,'Old password still accepted');await login('owner@example.test','fresh123');
      process.stdout.write('ACCOUNT_POLICY_OK');process.exit(0);`
    const child = Bun.spawn([process.execPath, '--eval', script], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin', WRENLY_DATABASE_URL: url!, WRENLY_AUTH_SECRET: config.secret, WRENLY_APP_URL: config.apiUrl, WRENLY_WEB_URL: config.webUrl }, stdout: 'pipe', stderr: 'pipe' })
    const timer=setTimeout(()=>child.kill(),15000)
    try { const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,errors).toBe(0);expect(output).toContain('ACCOUNT_POLICY_OK') }
    finally {clearTimeout(timer);if(child.exitCode===null)child.kill()}
  },20000)
  test('picture revisions serialize first upload, exact replay, conflict and removal tombstones', async () => {
    const proof = await issueOwnerSetupProof(database)
    const owner = await claimInstanceOwner(database, { ...credentials, proof, requestId: crypto.randomUUID() }, config)
    const actorId = (await database.select().from(schema.user))[0]!.id
    expect(owner).toBeDefined()
    const change = { mutationId: crypto.randomUUID(), expectedRevision: null }
    const bytes = new Uint8Array([1,2,3])
    const [first, replay] = await Promise.all([saveProfilePicture(database,actorId,change,bytes),saveProfilePicture(database,actorId,change,bytes)])
    expect(replay.revision).toBe(first.revision)
    expect(await getProfilePicture(database,actorId)).toEqual(first)
    expect(await readProfilePicture(database,actorId,actorId,first.revision!)).toEqual(bytes)
    await expect(saveProfilePicture(database,actorId,change,new Uint8Array([4]))).rejects.toThrow('conflicts')
    await expect(saveProfilePicture(database,actorId,{...change,mutationId:crypto.randomUUID()},bytes)).rejects.toThrow('changed elsewhere')
    const removed = await saveProfilePicture(database,actorId,{mutationId:crypto.randomUUID(),expectedRevision:first.revision},null)
    expect(removed.url).toBeNull();expect(removed.revision).not.toBe(first.revision)
    await expect(readProfilePicture(database,actorId,actorId,first.revision!)).rejects.toThrow('unavailable')
    await expect(saveProfilePicture(database,actorId,change,bytes)).rejects.toThrow('changed elsewhere')
    expect(await database.select().from(schema.profilePictures)).toHaveLength(1)
  })
  test('native sessions protect picture uploads, directory access and canonical reads', async () => {
    const proof=await issueOwnerSetupProof(database)
    await claimInstanceOwner(database,{...credentials,proof,requestId:crypto.randomUUID()},config)
    const ownerId=(await database.select().from(schema.user))[0]!.id
    await initializeInstanceMembership(database,ownerId,config)
    const otherId=await database.transaction(tx=>createOwnerAccount(tx,config,{name:'Other',email:'other@example.test',password:'other123'}))
    const setup=(await database.select().from(schema.instanceSetup))[0]!
    await database.insert(schema.member).values({id:crypto.randomUUID(),organizationId:setup.organizationId!,userId:otherId,role:'member',createdAt:new Date()})
    const authPath=resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/configuration/auth.ts')
    const modulePath=(name:string):string=>resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/'+name+'.ts')
    const script=`import {auth} from ${JSON.stringify(authPath)};import {db} from ${JSON.stringify(resolve(import.meta.dir,'../../../src/index.ts'))};
      import {getUserId} from ${JSON.stringify(modulePath('access/session'))};import {createProfilePictureHandlers} from ${JSON.stringify(modulePath('profile/pictures/profile-picture-http'))};import {decodeProfilePicture} from ${JSON.stringify(modulePath('profile/pictures/profile-picture-decoder'))};import {getProfilePicture,saveProfilePicture,readProfilePicture} from ${JSON.stringify(modulePath('profile/pictures/profile-picture-store'))};
      const check=(ok,label)=>{if(!ok)throw Error(label)};const login=async(email,password)=>{const response=await auth.handler(new Request('http://localhost:3002/api/auth/sign-in/email',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({email,password})}));check(response.ok,'login');return response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
      const owner=await login('owner@example.test','test1234'),other=await login('other@example.test','other123');
      const sharp=(await import(Bun.resolveSync('sharp',${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api'))}))).default;const bytes=await sharp({create:{width:30,height:20,channels:3,background:'#789abc'}}).withMetadata().png().toBuffer();
      const h=createProfilePictureHandlers({webUrl:'http://localhost:3000',session:getUserId,metadata:id=>getProfilePicture(db,id),image:(id,target,revision)=>readProfilePicture(db,id,target,revision),decode:decodeProfilePicture,save:(id,input,bytes)=>saveProfilePicture(db,id,input,bytes)});
      const request=(cookie,method='GET',path='',body,origin='http://localhost:3000')=>new Request('http://localhost:3002/api/account/profile-picture'+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'image/png','Idempotency-Key':crypto.randomUUID()},body});
      check((await h.save(request('','PUT','',bytes))).status===401,'anonymous upload');check((await h.save(request(other,'PUT','',bytes,'https://outside.invalid'))).status===403,'bad origin');
      const upload=await h.save(request(other,'PUT','',bytes));check(upload.ok,'upload');const saved=await upload.json();check(saved.userId===${JSON.stringify(otherId)}&&saved.url,'saved identity');
      const own=await h.image(request(other,'GET',saved.url.replace('/api/account/profile-picture','')));check(own.ok,'own image');check(own.headers.get('Content-Type')==='image/webp'&&own.headers.get('Cache-Control').includes('no-store')&&own.headers.get('X-Content-Type-Options')==='nosniff','headers');const result=await sharp(await own.arrayBuffer()).metadata();check(result.width===256&&result.height===256&&!result.exif,'canonical bytes');
      check((await h.image(request(owner,'GET',saved.url.replace('/api/account/profile-picture','')))).ok,'owner member read');
      const ownerUpload=await h.save(request(owner,'PUT','',bytes));check(ownerUpload.ok,'owner upload');const ownerPicture=await ownerUpload.json();check((await h.image(request(other,'GET',ownerPicture.url.replace('/api/account/profile-picture','')))).status===404,'member read owner');
      const remove=await h.remove(request(other,'DELETE','?expectedRevision='+saved.revision));check(remove.ok,'remove');check((await h.image(request(other,'GET',saved.url.replace('/api/account/profile-picture','')))).status===404,'old picture still available');
      const tombstone=await remove.json();const replacement=await h.save(request(other,'PUT','?expectedRevision='+tombstone.revision,bytes));check(replacement.ok,'replacement after removal');const replaced=await replacement.json();check((await h.image(request(owner,'GET',replaced.url.replace('/api/account/profile-picture','')))).ok,'owner read before membership removal');await db.delete((await import(${JSON.stringify(resolve(import.meta.dir,'../../../src/schema/index.ts'))})).member);check((await h.image(request(owner,'GET',replaced.url.replace('/api/account/profile-picture','')))).status===404,'removed member read');
      process.stdout.write('PICTURE_NATIVE_OK');process.exit(0);`
    const child=Bun.spawn([process.execPath,'--no-env-file','--eval',script],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin',WRENLY_DATABASE_URL:url!,WRENLY_AUTH_SECRET:config.secret,WRENLY_APP_URL:config.apiUrl,WRENLY_WEB_URL:config.webUrl},stdout:'pipe',stderr:'pipe'})
    const timer=setTimeout(()=>child.kill(),15000)
    try {const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,errors).toBe(0);expect(output).toContain('PICTURE_NATIVE_OK')}
    finally {clearTimeout(timer);if(child.exitCode===null)child.kill()}
    await database.delete(schema.user).where(eq(schema.user.id,otherId))
    expect(await database.select().from(schema.profilePictures).where(eq(schema.profilePictures.userId,otherId))).toHaveLength(0)
  },20000)
  test('member access uses native Better Auth, preserves projects, revokes previews and fences delayed sessions/admission', async () => {
    const proof=await issueOwnerSetupProof(database)
    await claimInstanceOwner(database,{...credentials,proof,requestId:crypto.randomUUID()},config)
    const ownerId=(await database.select().from(schema.user))[0]!.id
    await initializeInstanceMembership(database,ownerId,config)
    const targetId=await database.transaction(tx=>createOwnerAccount(tx,config,{name:'Managed member',email:'managed@example.test',password:'member12'}))
    const setup=(await database.select().from(schema.instanceSetup))[0]!
    await database.insert(schema.member).values({id:crypto.randomUUID(),organizationId:setup.organizationId!,userId:targetId,role:'member',createdAt:new Date()})
    const authRoot=resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth')
    const script=`import {auth} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/configuration/auth.ts'))};import {db} from ${JSON.stringify(resolve(import.meta.dir,'../../../src/index.ts'))};import * as schema from ${JSON.stringify(resolve(import.meta.dir,'../../../src/schema/index.ts'))};
      import {changeMemberAccess,getMemberAccessAction} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/members/member-access-store.ts'))};import {accessSessionHooks,readActivePrincipal} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/access/access-policy.ts'))};import {accessContext} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/access/access-context.ts'))};import {getUserId} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/auth/access/session.ts'))};import {admitBuild} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/builds/admission/build-admission.ts'))};import {issuePreviewGrant,consumePreviewGrant,authorizePreviewSession} from ${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api/src/modules/previews/access/preview-access.ts'))};
      const {eq}=await import(Bun.resolveSync('drizzle-orm',${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api'))}));const {betterAuth}=await import(Bun.resolveSync('better-auth',${JSON.stringify(resolve(import.meta.dir,'../../../../../apps/api'))}));
      const check=(value,label)=>{if(!value)throw Error(label)};const rejected=async(promise,label)=>{let refused=false;try{await promise}catch{refused=true}check(refused,label)};
      const call=(path,body,cookie='')=>auth.handler(new Request('http://localhost:3002/api/auth/'+path,{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}));const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const ownerResponse=await call('sign-in/email',{email:'owner@example.test',password:'test1234'});check(ownerResponse.ok,'owner login');const owner=cookie(ownerResponse),headers=new Headers({Cookie:owner});const memberResponse=await call('sign-in/email',{email:'managed@example.test',password:'member12'});check(memberResponse.ok,'member login');const memberCookie=cookie(memberResponse),memberHeaders=new Headers({Cookie:memberCookie});const memberSession=await auth.api.getSession({headers:memberHeaders});const principal=await readActivePrincipal(db,${JSON.stringify(targetId)},memberSession.session.id);check(principal,'principal');
      const config=${JSON.stringify(config)};const input={requestId:crypto.randomUUID(),targetId:${JSON.stringify(targetId)},action:'suspend',expectedRevision:principal.revision};
      check((await call('admin/ban-user',{userId:input.targetId},owner)).status===403,'raw admin exposed');await rejected(changeMemberAccess(db,input.targetId,memberHeaders,input,config),'member administration');await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,{...input,targetId:${JSON.stringify(ownerId)}},config),'owner self suspension');
      const [project]=await db.insert(schema.projects).values({userId:input.targetId,name:'Retained private project',stack:'nextjs'}).returning();const [build]=await db.insert(schema.builds).values({projectId:project.id,prompt:'private fixture',status:'pending'}).returning();await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config),'active build did not block');await db.update(schema.builds).set({status:'success',files:[]}).where(eq(schema.builds.id,build.id));
      const [conversation]=await db.insert(schema.conversations).values({projectId:project.id}).returning();const [turn]=await db.insert(schema.conversationTurns).values({conversationId:conversation.id,actorId:project.userId,idempotencyKey:crypto.randomUUID(),requestIdentity:'fixture',mode:'auto',prompt:'private',model:'fixture',provider:'fixture'}).returning();await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config),'conversation did not block');await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.id,turn.id));
      await db.insert(schema.deploymentResources).values({projectId:project.id,gitInstanceUrl:'http://fixture.invalid',repositoryOwner:'fixture',repositoryName:'fixture',coolifyInstanceUrl:'http://fixture.invalid',coolifyProjectUuid:'fixture',coolifyServerUuid:'fixture',coolifyEnvironmentName:'production'});const [deployment]=await db.insert(schema.deployments).values({projectId:project.id,buildId:build.id,userId:input.targetId,idempotencyKey:crypto.randomUUID(),requestIdentity:'fixture',stack:'nextjs',files:[],sourceSha256:'fixture',status:'interrupted'}).returning();await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config),'interrupted publishing did not block');await db.delete(schema.deployments).where(eq(schema.deployments.id,deployment.id));
      const [preview]=await db.insert(schema.previews).values({buildId:build.id,projectId:project.id,userId:input.targetId,files:[],status:'ready',leaseExpiresAt:new Date(Date.now()+60000),expiresAt:new Date(Date.now()+60000)}).returning();for(const status of ['queued','preparing','starting']){await db.update(schema.previews).set({status}).where(eq(schema.previews.id,preview.id));await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config),'preview '+status+' did not block');}await db.update(schema.previews).set({status:'ready'}).where(eq(schema.previews.id,preview.id));
      await db.insert(schema.conversationQueue).values({id:1}).onConflictDoNothing();let releaseQueue,enteredQueue;const queueHold=new Promise(resolve=>releaseQueue=resolve),queueReady=new Promise(resolve=>enteredQueue=resolve);const lock=db.transaction(async tx=>{await tx.select().from(schema.conversationQueue).where(eq(schema.conversationQueue.id,1)).for('update');enteredQueue();await queueHold});await queueReady;await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config),'queue contention did not block');releaseQueue();await lock;
      const grant=await issuePreviewGrant(db,preview.id,input.targetId,memberSession.session.id);const viewer=await consumePreviewGrant(db,preview.id,grant);check(viewer,'viewer grant');
      let release,entered;const hold=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);const delayed=betterAuth({...auth.options,databaseHooks:{session:{create:{before:async value=>{const result=await accessSessionHooks(db).create.before(value);entered();await hold;return result}}}}});const delayedLogin=delayed.api.signInEmail({body:{email:'managed@example.test',password:'member12'},returnHeaders:true});await ready;
      await rejected(changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config,async()=>{throw Error('fixture audit failure')}),'audit failure did not roll back');check(await getUserId(memberHeaders)===input.targetId,'rollback revoked member');
      const suspended=await changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config);check((await getMemberAccessAction(db,${JSON.stringify(ownerId)},input.requestId)).action.revision===suspended.revision,'saved action');check((await changeMemberAccess(db,${JSON.stringify(ownerId)},headers,input,config)).replayed,'exact replay');check(await getUserId(memberHeaders)===null,'old cookie active');check(!(await call('sign-in/email',{email:'managed@example.test',password:'member12'})).ok,'suspended sign-in');check(await authorizePreviewSession(db,preview.id,viewer)===null,'viewer still authorized');check((await db.select().from(schema.previews).where(eq(schema.previews.id,preview.id)))[0].status==='stopped','preview cleanup not requested');
      const restore={requestId:crypto.randomUUID(),targetId:input.targetId,action:'restore',expectedRevision:suspended.revision};await changeMemberAccess(db,${JSON.stringify(ownerId)},headers,restore,config);release();const late=await delayedLogin;const lateCookie=late.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');check(await getUserId(new Headers({Cookie:lateCookie}))===null,'delayed stale session revived');
      await rejected(accessContext.run({principal},()=>admitBuild({projectId:project.id,prompt:'A stale request',stack:'nextjs'},input.targetId,crypto.randomUUID(),{db,resolveProvider:()=>({id:'fixture'}),defaultModel:'fixture'})),'stale admission after restore');
      check((await call('sign-in/email',{email:'managed@example.test',password:'member12'},lateCookie)).ok,'restored sign-in with stale cookie');check(await getUserId(memberHeaders)===null,'restore revived old cookie');const retained=(await db.select().from(schema.projects).where(eq(schema.projects.id,project.id)))[0];check(retained.userId===input.targetId&&retained.name==='Retained private project','ownership changed');check((await db.select().from(schema.memberAccessAudit)).length===2,'audit rollback/replay');
      process.stdout.write('MEMBER_ACCESS_OK');process.exit(0);`
    const child=Bun.spawn([process.execPath,'--no-env-file','--eval',script],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin',WRENLY_DATABASE_URL:url!,WRENLY_AUTH_SECRET:config.secret,WRENLY_APP_URL:config.apiUrl,WRENLY_WEB_URL:config.webUrl},stdout:'pipe',stderr:'pipe'})
    const timer=setTimeout(()=>child.kill(),20000)
    try{const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,errors).toBe(0);expect(output).toContain('MEMBER_ACCESS_OK')}
    finally{clearTimeout(timer);if(child.exitCode===null)child.kill()}
  },25000)
  test('invalid proof consumes bounded attempts; exhausted/expired codes never create accounts', async () => {
    const proof = await issueOwnerSetupProof(database)
    for (let index = 0; index < 10; index++) await expect(claimInstanceOwner(database,
      { ...credentials, proof: 'x'.repeat(43), requestId: crypto.randomUUID() }, config)).rejects.toThrow('invalid')
    await expect(claimInstanceOwner(database, { ...credentials, proof, requestId: crypto.randomUUID() }, config)).rejects.toThrow('exhausted')
    expect(await database.select().from(schema.user)).toHaveLength(0)
    const replacement = await issueOwnerSetupProof(database)
    await database.update(schema.instanceSetup).set({ proofExpiresAt: new Date(Date.now() - 1) }).where(eq(schema.instanceSetup.id, 1))
    await expect(claimInstanceOwner(database, { ...credentials, proof: replacement, requestId: crypto.randomUUID() }, config)).rejects.toThrow('expired')
  })
  test('existing accounts are recovery-only and never adopted through a setup link', async () => {
    await database.insert(schema.user).values({ id: 'existing', name: 'Existing', email: 'existing@example.test' })
    expect(await getInstanceSetupStatus(database)).toBe('recovery-required')
    await expect(issueOwnerSetupProof(database)).rejects.toThrow('already has users')
    await expect(claimInstanceOwner(database, { ...credentials, proof: 'x'.repeat(43), requestId: crypto.randomUUID() }, config)).rejects.toThrow('verified owner recovery')
    expect((await database.select().from(schema.user))[0]?.id).toBe('existing')
  })
  test('owner persistence failure rolls back the Better Auth account creation', async () => {
    const proof = await issueOwnerSetupProof(database)
    await expect(claimInstanceOwner(database, { ...credentials, proof, requestId: crypto.randomUUID() }, config, async (...args) => {
      await createOwnerAccount(...args)
      throw new Error('Injected failure after actual credential insertion')
    })).rejects.toThrow('unavailable')
    expect(await database.select().from(schema.user)).toHaveLength(0)
    expect(await database.select().from(schema.account)).toHaveLength(0)
    const [saved] = await database.select().from(schema.instanceSetup)
    expect(saved?.ownerId).toBeNull(); expect(saved?.proofExpiresAt).not.toBeNull()
  })
  test('recovery binds operator proof to one account and preserves legacy project ownership', async () => {
    await database.insert(schema.user).values([
      { id: 'selected', name: 'Selected', email: 'selected@example.test' },
      { id: 'local-user-wrenly', name: 'Legacy', email: 'legacy@example.test' },
    ])
    const [project] = await database.insert(schema.projects).values({ userId: 'local-user-wrenly', name: 'Preserved project' }).returning()
    const replaced = await issueOwnerRecoveryProof(database, 'selected@example.test')
    const proof = await issueOwnerRecoveryProof(database, 'selected@example.test')
    await expect(recoverInstanceOwner(database, { proof: replaced, requestId: crypto.randomUUID() }, 'selected')).rejects.toThrow('invalid')
    await expect(recoverInstanceOwner(database, { proof, requestId: crypto.randomUUID() }, 'local-user-wrenly')).rejects.toThrow('does not match')
    const input = { proof, requestId: crypto.randomUUID() }
    const results = await Promise.all([recoverInstanceOwner(database, input, 'selected'), recoverInstanceOwner(database, input, 'selected')])
    expect(results.filter(result => result.replayed)).toHaveLength(1)
    expect((await database.select().from(schema.instanceSetup))[0]?.ownerId).toBe('selected')
    expect(await database.select().from(schema.instanceOwnerRecoveryAudit)).toHaveLength(1)
    expect((await database.select().from(schema.projects).where(eq(schema.projects.id, project!.id)))[0]?.userId).toBe('local-user-wrenly')
    expect(await database.select().from(schema.user)).toHaveLength(2)
    await expect(issueOwnerRecoveryProof(database, 'legacy@example.test')).rejects.toThrow('already has an owner')
    await expect(recoverInstanceOwner(database, { proof, requestId: crypto.randomUUID() }, 'selected')).rejects.toThrow('consumed')
  })
  test('recovery expiry, attempt bounds and atomic audit failure preserve the unclaimed instance', async () => {
    await database.insert(schema.user).values({ id: 'selected', name: 'Selected', email: 'selected@example.test' })
    let proof = await issueOwnerRecoveryProof(database, 'selected@example.test')
    for (let index = 0; index < 10; index++) await expect(recoverInstanceOwner(database, { proof: 'x'.repeat(43), requestId: crypto.randomUUID() }, 'selected')).rejects.toThrow('invalid')
    await expect(recoverInstanceOwner(database, { proof, requestId: crypto.randomUUID() }, 'selected')).rejects.toThrow('invalid')
    proof = await issueOwnerRecoveryProof(database, 'selected@example.test')
    await database.update(schema.instanceOwnerRecovery).set({ expiresAt: new Date(Date.now() - 1) })
    await expect(recoverInstanceOwner(database, { proof, requestId: crypto.randomUUID() }, 'selected')).rejects.toThrow('expired')
    proof = await issueOwnerRecoveryProof(database, 'selected@example.test')
    const requestId = crypto.randomUUID()
    await database.insert(schema.instanceOwnerRecoveryAudit).values({ requestId, ownerId: 'selected' })
    await expect(recoverInstanceOwner(database, { proof, requestId }, 'selected')).rejects.toThrow('unavailable')
    expect((await database.select().from(schema.instanceSetup))[0]?.ownerId).toBeNull()
    expect((await database.select().from(schema.instanceOwnerRecovery))[0]?.completedAt).toBeNull()
  })

  async function legacyFixture(): Promise<{ projectId: string; buildId: string; previewId: string; deploymentId: string; turnId: string; key: string }> {
    await database.insert(schema.user).values([{ id: 'owner', name: 'Owner', email: 'owner@example.test' }, { id: 'local-user-wrenly', name: 'Legacy', email: 'legacy@example.test' }, { id: 'other', name: 'Other', email: 'other@example.test' }])
    await database.insert(schema.instanceSetup).values({ id: 1, ownerId: 'owner' })
    const projectId = crypto.randomUUID(), buildId = crypto.randomUUID(), previewId = crypto.randomUUID(), deploymentId = crypto.randomUUID(), conversationId = crypto.randomUUID(), turnId = crypto.randomUUID(), key = crypto.randomUUID()
    await database.insert(schema.projects).values({ id: projectId, name: 'Legacy app', userId: 'local-user-wrenly' })
    await database.insert(schema.builds).values({ id: buildId, projectId, prompt: 'Preserve me', status: 'success', files: [{ path: 'app/page.tsx', content: 'saved source' }] })
    await database.insert(schema.buildJobs).values({ buildId, projectId, userId: 'local-user-wrenly', idempotencyKey: key, requestIdentity: 'original request', input: { prompt: 'Preserve me', stack: 'nextjs', model: 'fixture', provider: 'fixture', previousFiles: [], previousErrors: [] }, status: 'success' })
    await database.insert(schema.previews).values({ id: previewId, buildId, projectId, userId: 'local-user-wrenly', files: [], status: 'stopped', cleanupCompletedAt: new Date() })
    await database.insert(schema.previewRequests).values({ previewId, userId: 'local-user-wrenly', key })
    await database.insert(schema.previewAccess).values({ previewId, projectRevision: (await database.select().from(schema.projects).where(eq(schema.projects.id,projectId)))[0]!.accessRevision, userId: 'local-user-wrenly', grantHash: 'fixture-grant', grantExpiresAt: new Date(Date.now() + 60000), sessionHash: 'fixture-session', sessionExpiresAt: new Date(Date.now() + 60000) })
    await database.insert(schema.deploymentResources).values({ projectId, gitInstanceUrl: 'https://git.example.test', repositoryOwner: 'apps', repositoryName: 'preserve', coolifyInstanceUrl: 'https://coolify.example.test', coolifyProjectUuid: 'project', coolifyServerUuid: 'server', coolifyEnvironmentName: 'production', coolifyApplicationUuid: 'remote-app' })
    await database.insert(schema.deployments).values({ id: deploymentId, projectId, buildId, userId: 'local-user-wrenly', idempotencyKey: key, requestIdentity: 'original publish', stack: 'nextjs', files: [], sourceSha256: 'fixture', status: 'success', remoteDeploymentUuid: 'remote-deploy' })
    await database.insert(schema.conversations).values({ id: conversationId, projectId })
    await database.insert(schema.conversationTurns).values({ id: turnId, conversationId, actorId: 'local-user-wrenly', idempotencyKey: key, requestIdentity: 'original chat', mode: 'auto', prompt: 'Preserve chat', model: 'fixture', provider: 'fixture', status: 'completed' })
    return { projectId, buildId, previewId, deploymentId, turnId, key }
  }
  test('legacy recovery is owner-only, exact-selection, atomic and replayable without losing history', async () => {
    const fixture = await legacyFixture()
    await expect(listLegacyProjects(database, 'other')).rejects.toThrow('Only the verified')
    expect((await listLegacyProjects(database, 'owner')).projects).toEqual([{ id: fixture.projectId, name: 'Legacy app' }])
    await expect(reviewLegacyProjects(database, 'owner', { projectIds: [fixture.projectId, fixture.projectId] })).rejects.toThrow('distinct')
    const review = await reviewLegacyProjects(database, 'owner', { projectIds: [fixture.projectId] })
    expect(review.blockers).toEqual([])
    const input = { reviewId: review.reviewId, requestId: crypto.randomUUID() }
    expect(await confirmLegacyProjects(database, 'owner', input)).toEqual({ transferred: 1, replayed: false })
    expect(await confirmLegacyProjects(database, 'owner', input)).toEqual({ transferred: 1, replayed: true })
    await expect(confirmLegacyProjects(database, 'owner', { ...input, requestId: crypto.randomUUID() })).rejects.toThrow('different request')
    expect((await database.select().from(schema.projects))[0]?.userId).toBe('owner')
    expect((await database.select().from(schema.buildJobs))[0]?.userId).toBe('owner')
    expect((await database.select().from(schema.deployments))[0]?.userId).toBe('owner')
    expect((await database.select().from(schema.previews))[0]?.userId).toBe('owner')
    expect((await database.select().from(schema.previewRequests))[0]?.userId).toBe('owner')
    expect(await database.select().from(schema.previewAccess)).toHaveLength(0)
    expect((await database.select().from(schema.builds))[0]?.files).toEqual([{ path: 'app/page.tsx', content: 'saved source' }])
    expect((await database.select().from(schema.conversationTurns))[0]?.prompt).toBe('Preserve chat')
    expect((await database.select().from(schema.deploymentResources))[0]?.coolifyApplicationUuid).toBe('remote-app')
    expect((await database.select().from(schema.deployments))[0]?.remoteDeploymentUuid).toBe('remote-deploy')
    expect((await database.select().from(schema.legacyProjectRecovery))[0]?.completedAt).not.toBeNull()
    expect(await database.select().from(schema.user)).toHaveLength(3)
  })
  test('every active legacy execution state blocks review, including old builds without job assumptions', async () => {
    const f = await legacyFixture()
    const review = (): ReturnType<typeof reviewLegacyProjects> => reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })
    for (const status of ['pending', 'generating', 'building'] as const) {
      await database.update(schema.builds).set({ status }); expect((await review()).reviewId).toBeNull()
    }
    await database.update(schema.builds).set({ status: 'success' })
    for (const status of ['queued', 'running'] as const) {
      await database.update(schema.buildJobs).set({ status }); expect((await review()).reviewId).toBeNull()
    }
    await database.update(schema.buildJobs).set({ status: 'success' })
    for (const status of ['queued', 'running', 'waiting_build'] as const) {
      await database.update(schema.conversationTurns).set({ status }); expect((await review()).reviewId).toBeNull()
    }
    await database.update(schema.conversationTurns).set({ status: 'completed' })
    for (const status of ['queued', 'preparing', 'starting', 'ready', 'failed', 'expired', 'stopped', 'interrupted'] as const) {
      await database.update(schema.previews).set({ status, cleanupCompletedAt: null }); expect((await review()).reviewId).toBeNull()
    }
    await database.update(schema.previews).set({ status: 'stopped', cleanupCompletedAt: new Date() })
    for (const status of ['queued', 'preparing', 'deploying', 'verifying', 'interrupted'] as const) {
      await database.update(schema.deployments).set({ status }); expect((await review()).reviewId).toBeNull()
    }
    await database.update(schema.deployments).set({ status: 'failed', mutationIntent: { kind: 'trigger_deploy', operationId: 'unresolved' } })
    expect((await review()).reviewId).toBeNull()
    await database.update(schema.deployments).set({ mutationIntent: null })
    expect((await review()).reviewId).not.toBeNull()
  })
  test('stale or expired reviews and a late audit conflict roll back every selected project', async () => {
    const f = await legacyFixture()
    const secondId = crypto.randomUUID()
    await database.insert(schema.projects).values({ id: secondId, name: 'Second', userId: 'local-user-wrenly' })
    const selection = { projectIds: [f.projectId, secondId] }
    let review = await reviewLegacyProjects(database, 'owner', selection)
    await database.update(schema.projects).set({ name: 'Changed' }).where(eq(schema.projects.id, secondId))
    await expect(confirmLegacyProjects(database, 'owner', { reviewId: review.reviewId, requestId: crypto.randomUUID() })).rejects.toThrow('history changed')
    review = await reviewLegacyProjects(database, 'owner', selection)
    await database.update(schema.legacyProjectRecovery).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.legacyProjectRecovery.id, review.reviewId!))
    await expect(confirmLegacyProjects(database, 'owner', { reviewId: review.reviewId, requestId: crypto.randomUUID() })).rejects.toThrow('expired')
    review = await reviewLegacyProjects(database, 'owner', selection)
    const requestId = crypto.randomUUID()
    await database.insert(schema.legacyProjectRecovery).values({ id: crypto.randomUUID(), actorId: 'owner', sourceId: 'local-user-wrenly', projectIds: [], fingerprint: 'collision', expiresAt: new Date(), requestId, completedAt: new Date() })
    await expect(confirmLegacyProjects(database, 'owner', { reviewId: review.reviewId, requestId })).rejects.toThrow('request identity')
    expect((await database.select().from(schema.projects)).every(row => row.userId === 'local-user-wrenly')).toBe(true)
    expect((await database.select().from(schema.buildJobs))[0]?.userId).toBe('local-user-wrenly')
    expect(await database.select().from(schema.previewAccess)).toHaveLength(1)
    expect((await database.select().from(schema.legacyProjectRecovery).where(eq(schema.legacyProjectRecovery.id, review.reviewId!)))[0]?.completedAt).toBeNull()
  })
  test('inconsistent ownership and destination request-key collisions block recovery', async () => {
    const f = await legacyFixture()
    await database.update(schema.buildJobs).set({ userId: 'other' })
    expect((await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })).blockers.join(' ')).toContain('inconsistent')
    await database.update(schema.buildJobs).set({ userId: 'local-user-wrenly' })
    const destinationProject = crypto.randomUUID(), destinationBuild = crypto.randomUUID(), destinationPreview = crypto.randomUUID()
    await database.insert(schema.projects).values({ id: destinationProject, name: 'Owner app', userId: 'owner' })
    await database.insert(schema.builds).values({ id: destinationBuild, projectId: destinationProject, prompt: 'owner', status: 'success' })
    await database.insert(schema.previews).values({ id: destinationPreview, buildId: destinationBuild, projectId: destinationProject, userId: 'owner', files: [], status: 'stopped', cleanupCompletedAt: new Date() })
    await database.insert(schema.previewRequests).values({ previewId: destinationPreview, userId: 'owner', key: f.key })
    expect((await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })).blockers.join(' ')).toContain('conflicts')
    await database.delete(schema.previewRequests).where(eq(schema.previewRequests.previewId, destinationPreview))
    const [job] = await database.select().from(schema.buildJobs)
    await database.insert(schema.buildJobs).values({ ...job!, buildId: destinationBuild, projectId: destinationProject, userId: 'owner' })
    expect((await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })).blockers.join(' ')).toContain('conflicts')
    await database.delete(schema.buildJobs).where(eq(schema.buildJobs.buildId, destinationBuild))
    const [resource] = await database.select().from(schema.deploymentResources)
    await database.insert(schema.deploymentResources).values({ ...resource!, projectId: destinationProject })
    const [deployment] = await database.select().from(schema.deployments)
    await database.insert(schema.deployments).values({ ...deployment!, id: crypto.randomUUID(), projectId: destinationProject, buildId: destinationBuild, userId: 'owner' })
    expect((await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })).blockers.join(' ')).toContain('conflicts')
    await expect(reviewLegacyProjects(database, 'owner', { projectIds: [destinationProject] })).rejects.toThrow('outside legacy')
  })
  test('queue contention refuses transfer instead of racing with admission', async () => {
    const f = await legacyFixture()
    const review = await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })
    let release: (() => void) | undefined
    let locked: (() => void) | undefined
    const ready = new Promise<void>(resolve => { locked = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const holding = database.transaction(async tx => {
      await tx.select().from(schema.conversationQueue).where(eq(schema.conversationQueue.id, 1)).for('update')
      locked?.(); await wait
    })
    await ready
    try { await expect(confirmLegacyProjects(database, 'owner', { reviewId: review.reviewId, requestId: crypto.randomUUID() })).rejects.toThrow('busy') }
    finally { release?.(); await holding }
    expect((await database.select().from(schema.projects))[0]?.userId).toBe('local-user-wrenly')
  })

  test('work admitted after review blocks confirmation without changing any ownership', async () => {
    const f = await legacyFixture()
    const review = await reviewLegacyProjects(database, 'owner', { projectIds: [f.projectId] })
    await database.update(schema.buildJobs).set({ status: 'queued' })
    await expect(confirmLegacyProjects(database, 'owner', { reviewId: review.reviewId, requestId: crypto.randomUUID() })).rejects.toThrow('queued and running')
    expect((await database.select().from(schema.projects))[0]?.userId).toBe('local-user-wrenly')
    expect(await database.select().from(schema.previewAccess)).toHaveLength(1)
  })

  async function invitationFixture(): Promise<{ ownerId: string; headers: Headers }> {
    const ownerId = await database.transaction(tx => createOwnerAccount(tx, config, credentials))
    await database.insert(schema.instanceSetup).values({ id: 1, ownerId })
    const login = await database.transaction(tx => createInvitationAuth(tx, config).api.signInEmail({ body: { email: credentials.email, password: credentials.password }, returnHeaders: true }))
    const headers = new Headers({ Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') })
    return { ownerId, headers }
  }
  function invitationInput(link: string): { id: string; proof: string } {
    const fragment = new URLSearchParams(new URL(link).hash.slice(1))
    return { id: fragment.get('invitation')!, proof: fragment.get('proof')! }
  }
  test('Better Auth invitation membership initializes once and new acceptance is atomic, replayable and signs in normally', async () => {
    const f = await invitationFixture()
    await initializeInstanceMembership(database, f.ownerId, config)
    await initializeInstanceMembership(database, f.ownerId, config)
    expect(await database.select().from(schema.organization)).toHaveLength(1)
    expect(await database.select().from(schema.member)).toHaveLength(1)
    const issued = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'invited@example.test', requestId: crypto.randomUUID() }, config)
    const input = invitationInput(issued.link)
    const [authorization] = await database.select().from(schema.invitationAuthorization)
    expect(authorization?.proofHash).not.toBe(input.proof)
    expect(await inspectInstanceInvitation(database, input)).toEqual({ email: 'invited@example.test', existingAccount: false, accepted: false })
    const accept = { ...input, requestId: crypto.randomUUID(), name: 'Invited', password: 'invite12' }
    await expect(acceptInstanceInvitation(database, new Headers(), { ...accept, password: '1234567' }, config)).rejects.toThrow('8–128')
    const sessionsBefore = (await database.select().from(schema.session)).length
    expect(await acceptInstanceInvitation(database, new Headers(), accept, config)).toEqual({ email: 'invited@example.test', accountCreated: true, replayed: false })
    expect(await acceptInstanceInvitation(database, new Headers(), accept, config)).toEqual({ email: 'invited@example.test', accountCreated: true, replayed: true })
    expect((await database.select().from(schema.session)).length).toBe(sessionsBefore)
    expect(await database.select().from(schema.user)).toHaveLength(2)
    expect(await database.select().from(schema.member)).toHaveLength(2)
    expect((await database.select().from(schema.invitation))[0]?.status).toBe('accepted')
    const [invited] = await database.select().from(schema.user).where(eq(schema.user.email, 'invited@example.test'))
    expect(invited?.emailVerified).toBe(false)
    expect((await database.select().from(schema.member).where(eq(schema.member.userId, invited!.id)))[0]?.role).toBe('member')
    const login = await database.transaction(tx => createInvitationAuth(tx, config).api.signInEmail({ body: { email: 'invited@example.test', password: accept.password }, returnHeaders: true }))
    const headers = new Headers({ Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') })
    const verified = await database.transaction(tx => createInvitationAuth(tx, config).api.getSession({ headers }))
    expect(verified?.user.id).toBe(invited?.id)
    const projectId = crypto.randomUUID(), buildId = crypto.randomUUID()
    await database.insert(schema.projects).values({ id: projectId, name: 'Owner private app', userId: f.ownerId })
    await database.insert(schema.builds).values({ id: buildId, projectId, prompt: 'private prompt', status: 'success' })
    expect(await getOwnedBuild(database, buildId, invited!.id)).toBeNull()
    expect((await getOwnedBuild(database, buildId, f.ownerId))?.build.prompt).toBe('private prompt')
    await expect(listInstanceAccess(database, invited!.id)).rejects.toThrow('Only the instance owner')
  })
  test('existing invited accounts must authenticate and owner revocation invalidates proofs without changing credentials', async () => {
    const f = await invitationFixture()
    await database.transaction(tx => createOwnerAccount(tx, config, { name: 'Existing', email: 'existing@example.test', password: 'existing-password-12345' }))
    const issued = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'existing@example.test', requestId: crypto.randomUUID() }, config)
    const input = { ...invitationInput(issued.link), requestId: crypto.randomUUID() }
    await expect(acceptInstanceInvitation(database, new Headers(), input, config)).rejects.toThrow('Sign in to that account')
    await expect(acceptInstanceInvitation(database, f.headers, input, config)).rejects.toThrow('named in this invitation')
    const login = await database.transaction(tx => createInvitationAuth(tx, config).api.signInEmail({ body: { email: 'existing@example.test', password: 'existing-password-12345' }, returnHeaders: true }))
    const headers = new Headers({ Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') })
    expect((await acceptInstanceInvitation(database, headers, input, config)).accountCreated).toBe(false)
    const second = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'revoked@example.test', requestId: crypto.randomUUID() }, config)
    await revokeInstanceInvitation(database, f.ownerId, f.headers, { id: second.id }, config)
    await expect(inspectInstanceInvitation(database, invitationInput(second.link))).rejects.toThrow('revoked')
    expect(await database.select().from(schema.user)).toHaveLength(2)
    expect((await listInstanceAccess(database, f.ownerId)).invitations.some(row => row.status === 'revoked')).toBe(true)
  })

  test('invitation proof attempts, expiry, duplicate issuance and role overrides cannot bypass authorization', async () => {
    const f = await invitationFixture()
    const requestId = crypto.randomUUID()
    const issued = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'bounded@example.test', requestId }, config)
    await expect(issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'bounded@example.test', requestId }, config)).rejects.toThrow('already recorded')
    await expect(issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'bounded@example.test', requestId: crypto.randomUUID() }, config)).rejects.toThrow('pending invitation')
    await expect(issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'role@example.test', requestId: crypto.randomUUID(), role: 'owner' }, config)).rejects.toThrow('valid email')
    const input = invitationInput(issued.link)
    for (let index = 0; index < 10; index++) await expect(inspectInstanceInvitation(database, { ...input, proof: 'x'.repeat(43) })).rejects.toThrow('invalid')
    await expect(inspectInstanceInvitation(database, input)).rejects.toThrow('exhausted')
    expect((await database.select().from(schema.invitationAuthorization))[0]?.failedAttempts).toBe(10)
    await revokeInstanceInvitation(database, f.ownerId, f.headers, { id: issued.id }, config)
    const replacement = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'bounded@example.test', requestId: crypto.randomUUID() }, config)
    await expect(inspectInstanceInvitation(database, input)).rejects.toThrow('revoked')
    await database.update(schema.invitation).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.invitation.id, (await database.select().from(schema.invitationAuthorization).where(eq(schema.invitationAuthorization.id, replacement.id)))[0]!.invitationId))
    await expect(inspectInstanceInvitation(database, invitationInput(replacement.link))).rejects.toThrow('expired')
    const fresh = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'bounded@example.test', requestId: crypto.randomUUID() }, config)
    expect((await inspectInstanceInvitation(database, invitationInput(fresh.link))).accepted).toBe(false)
    expect(await database.select().from(schema.user)).toHaveLength(1)
  })
  test('failure after actual Better Auth acceptance rolls back new credentials, session, member and consumption', async () => {
    const f = await invitationFixture()
    const issued = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'rollback@example.test', requestId: crypto.randomUUID() }, config)
    const input = { ...invitationInput(issued.link), requestId: crypto.randomUUID(), name: 'Rollback', password: 'rollback-password-12345' }
    const beforeSessions = await database.select().from(schema.session)
    await expect(acceptInstanceInvitation(database, new Headers(), input, config, async () => { throw new Error('Injected post-membership failure') })).rejects.toThrow('unavailable')
    expect(await database.select().from(schema.user)).toHaveLength(1)
    expect(await database.select().from(schema.account)).toHaveLength(1)
    expect(await database.select().from(schema.member)).toHaveLength(1)
    expect(await database.select().from(schema.session)).toHaveLength(beforeSessions.length)
    expect((await database.select().from(schema.invitation))[0]?.status).toBe('pending')
    expect((await database.select().from(schema.invitationAuthorization))[0]?.acceptedAt).toBeNull()
    expect((await database.select().from(schema.invitationAudit)).map(row => row.action)).toEqual(['issued'])
    expect((await acceptInstanceInvitation(database, new Headers(), input, config)).accountCreated).toBe(true)
  })
  test('concurrent invitation acceptance creates one member and a late existing account requires its real login', async () => {
    const f = await invitationFixture()
    const issued = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'concurrent@example.test', requestId: crypto.randomUUID() }, config)
    const input = { ...invitationInput(issued.link), requestId: crypto.randomUUID(), name: 'Concurrent', password: 'concurrent-password-12345' }
    const results = await Promise.all([acceptInstanceInvitation(database, new Headers(), input, config), acceptInstanceInvitation(database, new Headers(), input, config)])
    expect(results.filter(row => row.replayed)).toHaveLength(1)
    expect(await database.select().from(schema.user)).toHaveLength(2)
    expect(await database.select().from(schema.member)).toHaveLength(2)
    const later = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'later@example.test', requestId: crypto.randomUUID() }, config)
    const proof = invitationInput(later.link)
    expect((await inspectInstanceInvitation(database, proof)).existingAccount).toBe(false)
    await database.transaction(tx => createOwnerAccount(tx, config, { name: 'Later', email: 'later@example.test', password: 'existing-later-password-12345' }))
    await expect(acceptInstanceInvitation(database, new Headers(), { ...proof, requestId: crypto.randomUUID(), name: 'Attempt', password: 'attempt-password-12345' }, config)).rejects.toThrow('Sign in to that account')
    expect(await database.select().from(schema.member)).toHaveLength(2)
  })
  test('production Better Auth HTTP cannot expose organization bypasses to a signed-in owner', async () => {
    const f = await invitationFixture()
    await initializeInstanceMembership(database, f.ownerId, config)
    const authPath = resolve(import.meta.dir, '../../../../../apps/api/src/modules/auth/configuration/auth.ts')
    const script = `import {auth} from ${JSON.stringify(authPath)};
      const headers=new Headers(${JSON.stringify(Object.fromEntries(f.headers))});headers.set('Content-Type','application/json');headers.set('Origin','http://localhost:3000');
      for(const path of ['create','invite-member','accept-invitation','get-full-organization']){
        const body=path==='create'?{name:'Unauthorized',slug:'unauthorized'}:path==='invite-member'?{email:'bypass@example.test',role:'owner'}:{invitationId:'fixture'};
        const res=await auth.handler(new Request('http://localhost:3002/api/auth/organization/'+path,{method:path==='get-full-organization'?'GET':'POST',headers,...(path==='get-full-organization'?{}:{body:JSON.stringify(body)})}));
        if(res.ok||res.status!==403)throw Error('Organization bypass: '+path+' '+res.status);
      }process.stdout.write('ORGANIZATION_CLOSED');process.exit(0);`
    const child = Bun.spawn([process.execPath, '--eval', script], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin', WRENLY_DATABASE_URL: url!, WRENLY_AUTH_SECRET: config.secret, WRENLY_APP_URL: config.apiUrl, WRENLY_WEB_URL: config.webUrl }, stdout: 'pipe', stderr: 'ignore' })
    const timeout = setTimeout(() => child.kill(), 5000)
    try { expect(await new Response(child.stdout).text()).toContain('ORGANIZATION_CLOSED'); expect(await child.exited).toBe(0) } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
  })

  test('pending invitation capacity is enforced and the issuing owner must have a real matching session', async () => {
    const f = await invitationFixture()
    await initializeInstanceMembership(database, f.ownerId, config)
    await expect(issueInstanceInvitation(database, f.ownerId, new Headers(), { email: 'anonymous@example.test', requestId: crypto.randomUUID() }, config)).rejects.toThrow('unavailable')
    const organizationId = (await database.select().from(schema.instanceSetup))[0]!.organizationId!
    await database.insert(schema.invitation).values(Array.from({ length: 20 }, (_, index) => ({ id: crypto.randomUUID(), organizationId, inviterId: f.ownerId, role: 'member', email: `pending${index}@example.test`, status: 'pending', expiresAt: new Date(Date.now() + 60000) })))
    await expect(issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'overflow@example.test', requestId: crypto.randomUUID() }, config)).rejects.toThrow('capacity is full')
    expect(await database.select().from(schema.invitationAuthorization)).toHaveLength(0)
  })

  test('live pending invitations remain manageable beyond the recent history window', async () => {
    const f = await invitationFixture()
    const active = await issueInstanceInvitation(database, f.ownerId, f.headers, { email: 'active@example.test', requestId: crypto.randomUUID() }, config)
    const authorization = (await database.select().from(schema.invitationAuthorization))[0]!
    const organizationId = (await database.select().from(schema.instanceSetup))[0]!.organizationId!
    await database.update(schema.invitation).set({ createdAt: new Date(Date.now() - 60000) }).where(eq(schema.invitation.id, authorization.invitationId))
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: crypto.randomUUID(), organizationId, inviterId: f.ownerId, role: 'member', email: `history${index}@example.test`, status: 'canceled', expiresAt: new Date() }))
    await database.insert(schema.invitation).values(rows)
    await database.insert(schema.invitationAuthorization).values(rows.map(row => ({ id: crypto.randomUUID(), invitationId: row.id, issueRequestId: crypto.randomUUID(), proofHash: '0'.repeat(64), revokedAt: new Date() })))
    expect((await listInstanceAccess(database, f.ownerId)).invitations.some(row => row.id === active.id && row.status === 'pending')).toBe(true)
  })

  test('catalog offline fallback, owner refresh, corrupted-cache repair and failed-refresh retention work in PostgreSQL', async () => {
    await database.insert(schema.user).values([{ id: 'owner', email: 'owner@example.test', name: 'Owner' }, { id: 'member', email: 'member@example.test', name: 'Member' }])
    await database.insert(schema.instanceSetup).values({ id: 1, ownerId: 'owner' })
    expect((await getAvailableCatalog(database)).origin).toBe('bundled')
    let calls = 0
    const fetcher = (async (): Promise<Response> => { calls++; return Response.json({ fixture: { id: 'fixture', name: 'Fixture', npm: '@ai-sdk/openai-compatible', api: 'https://provider.example/v1', models: { served: { id: 'served', name: 'Served' } } } }) })
    await expect(refreshProviderCatalog(database, 'member', fetcher)).rejects.toThrow('Only the instance owner')
    expect(calls).toBe(0)
    const refreshed = await refreshProviderCatalog(database, 'owner', fetcher)
    const available = await getAvailableCatalog(database)
    expect(available.origin).toBe('cached'); expect(available.snapshot.version).toBe(refreshed.version)
    expect(available.snapshot.providers[0]?.models[0]?.id).toBe('served')
    expect(calls).toBe(1)
    await expect(refreshProviderCatalog(database, 'owner', (async () => { throw new Error('Network offline') }))).rejects.toThrow('unchanged')
    expect((await getAvailableCatalog(database)).snapshot.version).toBe(refreshed.version)
    expect(await database.select().from(schema.providerCatalogRefreshAudit)).toHaveLength(1)
    await database.update(schema.providerCatalogCache).set({ snapshot: { corrupt: true } })
    expect((await getAvailableCatalog(database)).origin).toBe('bundled')
    expect((await getAvailableCatalog(database)).cacheUnavailable).toBe(true)
    await refreshProviderCatalog(database, 'owner', fetcher)
    expect((await getAvailableCatalog(database)).origin).toBe('cached')
    expect(await database.select().from(schema.providerCatalogRefreshAudit)).toHaveLength(2)
  })

})
