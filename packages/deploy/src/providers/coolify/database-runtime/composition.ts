/** Fixed publishing topology; credentials, generated commands and arbitrary mounts are deliberately absent. */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE = /^[a-z0-9.:-]+\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const INGRESS_MEMORY_BYTES = 128 * 1024 * 1024;
export interface DatabaseRuntimeCompositionInput {
  deploymentId: string;
  projectId: string;
  resourceId: string;
  appImage: string;
  ingressImage: string;
  framework: "nextjs" | "laravel";
}
export interface DatabaseRuntimeComposition {
  document: string;
  httpVolume: string;
  databaseVolume: string;
}
/** Call only after provenance checks. This function does not create volumes, deliver credentials or contact Coolify. */
export function createDatabaseRuntimeComposition(
  input: DatabaseRuntimeCompositionInput,
): DatabaseRuntimeComposition {
  if (
    ![input.deploymentId, input.projectId, input.resourceId].every((value) =>
      UUID.test(value),
    ) ||
    !IMAGE.test(input.appImage) ||
    !IMAGE.test(input.ingressImage) ||
    input.appImage === input.ingressImage ||
    !["nextjs", "laravel"].includes(input.framework)
  )
    throw new Error("Invalid database publishing composition.");
  const httpVolume = `wrenly-deployment-http-${input.deploymentId}`;
  const databaseVolume = `wrenly-deployment-db-${input.deploymentId}`;
  const labels = {
    "io.wrenly.deployment-id": input.deploymentId,
    "io.wrenly.project-id": input.projectId,
    "io.wrenly.database-id": input.resourceId,
    "io.wrenly.database-environment": "production",
  };
  const document = {
    services: {
      application: {
        image: input.appImage,
        user: "0:0",
        network_mode: "none",
        read_only: true,
        stdin_open: true,
        tty: false,
        restart: "no",
        cpus: 2,
        mem_limit: MEMORY_BYTES,
        pids_limit: 256,
        cap_drop: ["ALL"],
        cap_add: ["SETUID", "SETGID", "CHOWN"],
        security_opt: ["no-new-privileges:true"],
        labels: { ...labels, "io.wrenly.role": "production-application" },
        volumes: ["http:/run/wrenly-http", "database:/run/wrenly-database:ro"],
        tmpfs: [
          "/run/wrenly-bootstrap:rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0700",
          "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
          ...(input.framework === "laravel"
            ? [
                "/app/storage:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
                "/app/bootstrap/cache:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
              ]
            : ["/app/.next/cache:rw,noexec,nosuid,size=64m,uid=1000,gid=1000"]),
        ],
      },
      ingress: {
        image: input.ingressImage,
        user: "1000:1000",
        read_only: true,
        restart: "no",
        cpus: 1,
        mem_limit: INGRESS_MEMORY_BYTES,
        pids_limit: 64,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        expose: ["3000"],
        labels: { ...labels, "io.wrenly.role": "production-ingress" },
        volumes: ["http:/run/wrenly-http:ro"],
      },
    },
    volumes: {
      http: { external: true, name: httpVolume },
      database: { external: true, name: databaseVolume },
    },
  };
  return {
    document: JSON.stringify(document, null, 2),
    httpVolume,
    databaseVolume,
  };
}
