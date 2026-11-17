/** PostgreSQL's credential-free SSL negotiation, followed by certificate/hostname verification. */
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import {
  pinProductionDatabaseTarget,
  recheckProductionDatabaseTarget,
  ProductionDestinationError,
  type DatabaseAddressLookup,
  type PinnedProductionTarget,
} from "./target-policy";
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CA_BYTES = 32 * 1024;
// PostgreSQL SSLRequest: eight-byte length/code message, code (1234 << 16) | 5679.
const SSL_ACCEPTED = 0x53;
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
export interface ProductionTlsEvidence {
  target: PinnedProductionTarget;
  address: string;
  certificateFingerprint: string;
}
/** The caller supplies an already pinned socket. Never send startup fields, passwords or SQL in this check. */
export async function verifyPostgresTls(
  socket: Socket,
  hostname: string,
  options: { signal?: AbortSignal; certificateAuthority?: string } = {},
): Promise<string> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    if (
      options.certificateAuthority !== undefined &&
      (!options.certificateAuthority.length ||
        Buffer.byteLength(options.certificateAuthority) > MAX_CA_BYTES)
    )
      throw new ProductionDestinationError();
    return await new Promise<string>((resolve, reject) => {
      let secure: TLSSocket | undefined;
      let settled = false;
      const finish = (fingerprint?: string): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        secure?.destroy();
        socket.destroy();
        if (fingerprint) resolve(fingerprint);
        else reject(new ProductionDestinationError());
      };
      const abort = (): void => finish();
      socket.once("error", abort);
      socket.once("close", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return finish();
      socket.once("data", (reply: Buffer) => {
        if (reply.length !== 1 || reply[0] !== SSL_ACCEPTED) return finish();
        try {
          const upgraded = connectTls({
            socket,
            servername: hostname,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            ...(options.certificateAuthority
              ? { ca: options.certificateAuthority }
              : {}),
          });
          if (!upgraded) return finish();
          secure = upgraded;
          upgraded.once("error", abort);
          upgraded.once("close", abort);
          upgraded.once("secureConnect", () => {
            const certificate = upgraded.getPeerCertificate();
            if (
              !upgraded.authorized ||
              typeof certificate.fingerprint256 !== "string" ||
              !certificate.fingerprint256.length
            )
              return finish();
            finish(certificate.fingerprint256);
          });
        } catch {
          finish();
        }
      });
      // net.Socket buffers this fixed SSLRequest until TCP connects. No user input is serialized.
      socket.write(SSL_REQUEST);
    });
  } catch {
    socket.destroy();
    throw new ProductionDestinationError();
  }
}
/** Check a reviewed private destination without authenticating or modifying PostgreSQL. Evidence is not resource readiness. */
export async function probeProductionDatabaseTls(
  saved: PinnedProductionTarget,
  controlDatabaseUrl: string,
  options: {
    lookup?: DatabaseAddressLookup;
    signal?: AbortSignal;
    certificateAuthority?: string;
  } = {},
): Promise<ProductionTlsEvidence> {
  const bounded = {
    ...options,
    signal: AbortSignal.any([
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
    ]),
  };
  try {
    const current = await recheckProductionDatabaseTarget(
      saved,
      controlDatabaseUrl,
      bounded,
    );
    const address = current.addresses[0];
    if (!address) throw new ProductionDestinationError();
    bounded.signal.throwIfAborted();
    const socket = connectTcp({ host: address, port: current.target.port });
    const fingerprint = await verifyPostgresTls(
      socket,
      current.target.host,
      bounded,
    );
    // A completed probe cannot authorize a changed target discovered before returning its evidence.
    const after = await pinProductionDatabaseTarget(
      current.target,
      controlDatabaseUrl,
      bounded,
    );
    if (JSON.stringify(after.addresses) !== JSON.stringify(current.addresses))
      throw new ProductionDestinationError();
    return { target: current, address, certificateFingerprint: fingerprint };
  } catch {
    throw new ProductionDestinationError();
  }
}
