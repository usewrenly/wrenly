// Upgrades only a disposable, explicitly named database to verify member-access compatibility.
import {expect,test,describe} from 'bun:test'
import postgres from 'postgres'
import {drizzle} from 'drizzle-orm/postgres-js'
import {migrate} from 'drizzle-orm/postgres-js/migrator'
import {pgTable,text,timestamp} from 'drizzle-orm/pg-core'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import * as schema from '../../../src/schema'
import {readActivePrincipal} from '../../../../../apps/api/src/modules/auth/access/access-policy'
import {verifyMemberAccessSchema} from '../../../../../apps/api/src/modules/auth/members/member-access-store'
const url=process.env.WRENLY_TEST_MEMBER_UPGRADE_DATABASE_URL
if(url){const parsed=new URL(url);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/wrenly_member_upgrade_test')throw Error('Use a disposable local wrenly_member_upgrade_test database.')}
const integration=url?describe:describe.skip
integration('member access migration upgrade',()=>{
 test('backfills existing authenticated sessions without changing accounts or session tokens',async()=>{
  const client=postgres(url!,{onnotice:()=>{}}),database=drizzle(client,{schema}),directory=await mkdtemp(join(tmpdir(),'wrenly-access-upgrade-'))
  const migrations=join(import.meta.dir,'../../../migrations')
  try{
   const journal=JSON.parse(await readFile(join(migrations,'meta/_journal.json'),'utf8')) as {entries:Array<{idx:number;tag:string}>}
   await mkdir(join(directory,'meta'));await writeFile(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.filter(entry=>entry.idx<19)}))
   await Promise.all(journal.entries.filter(entry=>entry.idx<19).map(entry=>copyFile(join(migrations,entry.tag+'.sql'),join(directory,entry.tag+'.sql'))))
   await migrate(database,{migrationsFolder:directory})
   const priorUser=pgTable('user',{id:text('id').primaryKey(),name:text('name').notNull(),email:text('email').notNull()})
   const priorSession=pgTable('session',{id:text('id').primaryKey(),userId:text('user_id').notNull(),token:text('token').notNull(),expiresAt:timestamp('expires_at').notNull()})
   await database.insert(priorUser).values({id:'upgrade-person',name:'Retained person',email:'retained@example.test'})
   await database.insert(priorSession).values({id:'retained-session',userId:'upgrade-person',token:'fixture-only-session-token',expiresAt:new Date(Date.now()+60000)})
   await migrate(database,{migrationsFolder:migrations});await verifyMemberAccessSchema(database)
   const [person]=await database.select().from(schema.user),[session]=await database.select().from(schema.session)
   expect(person?.banned).toBe(false);expect(person?.name).toBe('Retained person');expect(session?.token).toBe('fixture-only-session-token');expect(session?.accessRevision).toBe(person?.accessRevision)
   expect((await readActivePrincipal(database,'upgrade-person','retained-session'))?.revision).toBe(person?.accessRevision)
  }finally{await client.end();await rm(directory,{recursive:true,force:true})}
 },20000)
})
