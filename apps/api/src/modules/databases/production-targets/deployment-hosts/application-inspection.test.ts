import { expect, test } from "bun:test";
import { inspectProductionApplicationContainer } from "./application-inspection";
function fixture() {
  const scope = {
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    containerId: "a".repeat(64),
    imageId: `sha256:${"b".repeat(64)}`,
  };
  const config = {
    Env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
    Entrypoint: ["bun", "--no-env-file", "/wrenly/production-application.js"],
    Cmd: null,
  };
  const image = {
    Id: scope.imageId,
    Config: {
      ...config,
      Labels: { "io.wrenly.database-runtime-version": "1" },
    },
  };
  const container = {
    Id: scope.containerId,
    Image: scope.imageId,
    Config: {
      ...structuredClone(config),
      User: "0:0",
      OpenStdin: true,
      Tty: false,
      Labels: {
        "io.wrenly.deployment-id": scope.deploymentId,
        "io.wrenly.project-id": scope.projectId,
        "io.wrenly.database-id": scope.resourceId,
        "io.wrenly.database-environment": "production",
        "io.wrenly.role": "production-application",
      },
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      AutoRemove: false,
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      CapDrop: ["ALL"],
      CapAdd: ["SETUID", "SETGID", "CHOWN"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 2147483648,
      NanoCpus: 2000000000,
      PidsLimit: 256,
      RestartPolicy: { Name: "no" },
      Tmpfs: {
        "/run/wrenly-bootstrap":
          "rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0700",
      },
      Binds: null,
      Devices: [],
      DeviceRequests: [],
    },
    Mounts: [
      {
        Type: "volume",
        Name: `wrenly-deployment-http-${scope.deploymentId}`,
        Destination: "/run/wrenly-http",
        RW: true,
        Driver: "local",
      },
      {
        Type: "volume",
        Name: `wrenly-deployment-db-${scope.deploymentId}`,
        Destination: "/run/wrenly-database",
        RW: false,
        Driver: "local",
      },
    ],
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
  };
  return { scope, image, container };
}
test("application inspection accepts only the saved guardian image and isolated topology", () => {
  const { scope, image, container } = fixture();
  expect(
    inspectProductionApplicationContainer(container, image, scope),
  ).toEqual({
    containerId: scope.containerId,
    imageId: scope.imageId,
    running: false,
  });
  container.State.Running = true;
  expect(
    inspectProductionApplicationContainer(container, image, scope).running,
  ).toBe(true);
});
test("application inspection rejects retargeting, added secrets, privileges and writable database mounts", () => {
  const changes: Array<(value: ReturnType<typeof fixture>) => void> = [
    (value) => {
      value.container.Id = "c".repeat(64);
    },
    (value) => {
      value.image.Config.Labels["io.wrenly.database-runtime-version"] = "0";
    },
    (value) => {
      value.container.Config.Env.push("DATABASE_URL=secret");
    },
    (value) => {
      value.container.Config.Entrypoint = ["sh"];
    },
    (value) => {
      value.container.Config.Labels["io.wrenly.project-id"] =
        crypto.randomUUID();
    },
    (value) => {
      value.container.HostConfig.NetworkMode = "bridge";
    },
    (value) => {
      value.container.HostConfig.Privileged = true;
    },
    (value) => {
      value.container.HostConfig.ReadonlyRootfs = false;
    },
    (value) => {
      value.container.HostConfig.CapAdd.push("SYS_ADMIN");
    },
    (value) => {
      value.container.HostConfig.SecurityOpt = [];
    },
    (value) => {
      value.container.Mounts[1]!.RW = true;
    },
    (value) => {
      value.container.Mounts[0]!.Name = "foreign";
    },
    (value) => {
      value.container.HostConfig.RestartPolicy.Name = "always";
    },
    (value) => {
      value.container.HostConfig.PidMode = "host";
    },
    (value) => {
      value.container.Config.User = "1000:1000";
    },
    (value) => {
      value.container.HostConfig.Tmpfs["/run/wrenly-bootstrap"] =
        "rw,size=1m,uid=1000,gid=1000,mode=0777";
    },
    (value) => {
      value.container.Mounts.push({
        ...value.container.Mounts[0]!,
        Destination: "/var/run/docker.sock",
      });
    },
  ];
  for (const change of changes) {
    const value = fixture();
    change(value);
    expect(() =>
      inspectProductionApplicationContainer(
        value.container,
        value.image,
        value.scope,
      ),
    ).toThrow("isolation could not be verified");
  }
});
