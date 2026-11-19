/** Independent Node TLS fixture for testing Bun's PostgreSQL protocol upgrade client. */
import { createServer, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
const [mode, certificatePath, keyPath] = process.argv.slice(2);
if (!certificatePath || !keyPath)
  throw new Error("Missing fixture certificate");
const context = createSecureContext({
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
});
const clients = new Set<Socket>();
const requests: string[] = [];
const server = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => clients.delete(socket));
  socket.once("data", (data) => {
    requests.push(data.toString("hex"));
    if (mode === "silent") return;
    if (mode !== "tls") {
      socket.end(mode === "refuse" ? "N" : "SS");
      return;
    }
    socket.write("S", () => {
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: context,
      });
      clients.add(secure);
      secure.on("error", () => {});
      secure.once("close", () => clients.delete(secure));
      secure.on("data", (data) => requests.push(data.toString("hex")));
    });
  });
});
server.listen(0, "127.0.0.1", () => {
  const location = server.address();
  if (!location || typeof location === "string")
    throw new Error("Missing fixture port");
  process.stdout.write(`${location.port}\n`);
});
process.stdin.resume();
process.stdin.once("end", () => {
  for (const socket of clients) socket.destroy();
  server.close(() => process.stdout.write(`${JSON.stringify(requests)}\n`));
});
