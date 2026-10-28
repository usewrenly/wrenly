import { expect, test } from "bun:test";
import {
  managedDatabaseNames,
  managedDatabaseLabels,
  assertManagedDatabaseLabels,
  verifyManagedDatabaseResources,
  localDatabaseSocketConfiguration,
  type ManagedDatabaseInspection,
  type ManagedDatabaseScope,
} from "../../src/databases/database-resource-policy";
const scope: ManagedDatabaseScope = {
  resourceId: "101e4567-e89b-12d3-a456-426614174007",
  projectId: "201e4567-e89b-12d3-a456-426614174007",
  environment: "development",
};
const names = managedDatabaseNames(scope);
test("cleanup ownership checks include environment and exact resource purpose", () => {
  for (const kind of ["database", "database-initializer", "database-data", "database-network"] as const) {
    const labels = managedDatabaseLabels(scope, kind);
    expect(() => assertManagedDatabaseLabels({ Labels: labels }, scope, kind)).not.toThrow();
    for (const key of Object.keys(labels)) {
      expect(() => assertManagedDatabaseLabels({ Labels: { ...labels, [key]: "foreign" } }, scope, kind)).toThrow();
      const missing = { ...labels };
      delete missing[key];
      expect(() => assertManagedDatabaseLabels({ Labels: missing }, scope, kind)).toThrow();
    }
    expect(() => assertManagedDatabaseLabels({ Labels: { ...labels, "io.wrenly.role": "database-socket" } }, scope, kind)).toThrow();
  }
});
const identity = {
  containerId: "fixture-container",
  networkId: "fixture-network",
  volumeName: names.volume,
  imageId: `sha256:${"a".repeat(64)}`,
};
function fixture(): ManagedDatabaseInspection {
  return {
    volume: {
      Name: names.volume,
      Driver: "local",
      Labels: managedDatabaseLabels(scope, "database-data"),
    },
    network: {
      Id: identity.networkId,
      Name: names.network,
      Internal: true,
      Driver: "bridge",
      Labels: managedDatabaseLabels(scope, "database-network"),
    },
    container: {
      Id: identity.containerId,
      Name: `/${names.container}`,
      Image: identity.imageId,
      Config: {
        Labels: managedDatabaseLabels(scope, "database"),
        User: "70:70",
      },
      HostConfig: {
        NetworkMode: identity.networkId,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      },
      NetworkSettings: {
        Networks: {
          [names.network]: {
            NetworkID: identity.networkId,
            IPAddress: "172.30.1.2",
          },
        },
        Ports: { "5432/tcp": null },
      },
      Mounts: [
        {
          Type: "volume",
          Name: names.volume,
          Destination: "/var/lib/postgresql/data",
        },
      ],
    },
  };
}
test("saved identity verifies exact private project resources; names alone cannot authorize adoption", () => {
  expect(verifyManagedDatabaseResources(scope, identity, fixture())).toEqual({
    address: "172.30.1.2",
    port: 5432,
  });
  const mutations: Array<(value: ManagedDatabaseInspection) => void> = [
    (value) => {
      value.container.Config.User = "0:0";
    },
    (value) => {
      value.container.Config.Env = ["PGPASSWORD=must-not-be-saved"];
    },
    (value) => {
      value.container.HostConfig.ReadonlyRootfs = false;
    },
    (value) => {
      value.container.HostConfig.CapAdd = ["SYS_ADMIN"];
    },
    (value) => {
      value.volume.Labels = {};
    },
    (value) => {
      value.volume.Name = "undefined";
    },
    (value) => {
      value.volume.Options = { device: "/var/run/docker.sock", o: "bind" };
    },
    (value) => {
      value.network.Internal = false;
    },
    (value) => {
      value.network.Id = "control-network";
    },
    (value) => {
      value.container.Image = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.container.HostConfig.NetworkMode = "host";
    },
    (value) => {
      value.container.HostConfig.Privileged = true;
    },
    (value) => {
      value.container.HostConfig.PortBindings = { "5432/tcp": [] };
    },
    (value) => {
      value.container.NetworkSettings.Ports = {
        "5432/tcp": [{ HostPort: "5432" }],
      };
    },
    (value) => {
      value.container.NetworkSettings.Networks!.other = {
        NetworkID: "other-project",
        IPAddress: "172.30.2.1",
      };
    },
    (value) => {
      value.container.NetworkSettings.Networks![names.network]!.IPAddress =
        "169.254.169.254";
    },
    (value) => {
      value.container.Mounts.push({ Type: "bind", Destination: "/host" });
    },
  ];
  for (const mutate of mutations) {
    const inspection = fixture();
    mutate(inspection);
    expect(() =>
      verifyManagedDatabaseResources(scope, identity, inspection),
    ).toThrow();
  }
  expect(() =>
    managedDatabaseNames({ ...scope, resourceId: "../foreign" }),
  ).toThrow();
});
test("socket configuration selects one non-admin role, no TCP listener and no wildcard database mapping", () => {
  const upstream = verifyManagedDatabaseResources(scope, identity, fixture());
  const role = {
    kind: "runtime" as const,
    user: `wrenly_${scope.resourceId.replaceAll("-", "")}_runtime`,
    password: "c".repeat(64),
  };
  const result = localDatabaseSocketConfiguration(scope, upstream, role);
  expect(result.configuration).toContain("listen_addr =\n");
  expect(result.configuration).toContain("pool_mode = session");
  expect(result.configuration).toContain("auth_type = scram-sha-256");
  expect(result.configuration).not.toContain("* =");
  expect(result.configuration).not.toContain("admin_users");
  expect(result.authentication).toBe(`"${role.user}" "${role.password}"\n`);
  expect(() =>
    localDatabaseSocketConfiguration(scope, upstream, {
      ...role,
      user: role.user.replace("_runtime", "_admin"),
    }),
  ).toThrow();
  expect(() =>
    localDatabaseSocketConfiguration(
      scope,
      { address: "127.0.0.1", port: 5432 },
      role,
    ),
  ).toThrow();
  expect(() =>
    localDatabaseSocketConfiguration(
      scope,
      { address: "169.254.169.254", port: 5432 },
      role,
    ),
  ).toThrow();
  expect(() =>
    localDatabaseSocketConfiguration(
      scope,
      { address: "db.example.com", port: 5432 },
      role,
    ),
  ).toThrow();
  expect(() =>
    localDatabaseSocketConfiguration(scope, upstream, {
      ...role,
      password: "bad\nadmin_users = root",
    }),
  ).toThrow();
});
