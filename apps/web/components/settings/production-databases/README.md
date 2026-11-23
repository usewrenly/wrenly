# Connect the servers used by generated apps

The instance owner connects infrastructure once. For example, an owner connects a
private PostgreSQL server, then individual projects can request separate databases
without asking every teammate to paste a database password.

The two forms have different jobs:

- `production-server-setup.tsx` connects the dedicated PostgreSQL server. Its
  management account is used by trusted provisioning code, never generated apps.
- `production-host-setup.tsx` connects the machine running published apps. SSH is
  the encrypted connection to that machine; its public host key identifies the
  reviewed destination. Only the fixed Wrenly helper can receive runtime requests.

Each form reads saved status before allowing a submission. A submission receives a
unique request ID. If the server saves it but the browser loses the reply, the form
looks up that exact request rather than creating another one. Only the request ID
is stored in this browser tab. Passwords and private keys are not stored there.

A connection check does not create a project database or publish an application.
A successful check also does not establish that the full publishing path is ready.
The API owns activation and independently verifies the current owner's authority.
Without that API capability, these forms cannot enable Production services.

The transport helpers live in `lib/databases/production-connection.ts` and
`production-host.ts`. They validate shared contracts, bound responses and distinguish
an explicitly refused write from one whose result is unknown. The browser acceptance
uses disposable HTTP responses to simulate a lost reply and verifies that no second
write is sent. It does not contact an operator's database or deployment host.
