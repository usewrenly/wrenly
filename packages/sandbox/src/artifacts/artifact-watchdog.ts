// Trusted container PID 1 bounds generated command lifetime even if the API dies.
// The generated child drops to UID/GID 1000 and cannot signal its privileged guardian.
export const ARTIFACT_WATCHDOG_SOURCE = `const remaining=Number(process.argv[2]);
if(!Number.isSafeInteger(remaining)||remaining<1||remaining>300000)process.exit(125);
const timer=setTimeout(()=>process.exit(137),remaining);
try{const child=Bun.spawn(process.argv.slice(3),{cwd:'/app',uid:1000,gid:1000,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
const code=await child.exited;clearTimeout(timer);process.exit(code)}catch{process.exit(125)}`
