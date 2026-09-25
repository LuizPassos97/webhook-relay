# Security policy

## Supported versions

Webhook Relay is pre-1.0. Security fixes are made on the latest release and the `main` branch.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/LuizPassos97/webhook-relay/security/advisories/new). Do not open a public issue or pull request.

Include the affected version or commit, a description of the impact and steps to reproduce. You should receive an acknowledgement within seven days. Once a fix is available, the advisory is published with credit to the reporter unless you prefer to stay anonymous.

This is a volunteer-maintained project without a hosted service; there is no bug bounty.

## Scope

In scope: the API, worker, database migrations and the published container images. The demo receiver is a local teaching tool and not intended to be exposed, but reports about it are still welcome.

See [docs/security.md](docs/security.md) for the threat model and known limitations.
