# Contributing

Thanks for your interest in Webhook Relay. Issues and pull requests are welcome.

## Setup

Requirements: Node.js 24 LTS, npm and Docker (or another free container runtime) for PostgreSQL.

```sh
npm ci
docker compose up -d postgres
npm test
```

Integration tests create and drop temporary databases on the Compose PostgreSQL (`localhost:55432`). Set `TEST_DATABASE_URL` to use another server, never one with real data.

## Before opening a pull request

```sh
npm run lint            # ESLint (type-aware) and Prettier
npm run typecheck
npm run build
npm run test:coverage   # at least 85% lines and 80% branches
```

If you change route schemas, regenerate the OpenAPI document with `npm run openapi` and commit `docs/openapi.json`.

## Conventions

- **Tests first.** Add a test that fails without your change. Concurrency, security and recovery behavior need tests against real PostgreSQL, not mocks.
- **Readable code.** One statement per line, descriptive names, small functions. Comments explain why something is done (a security decision, an invariant, a limit), not what the next line does.
- **English everywhere:** code, comments, documentation, commit messages, issues and pull requests.
- **Commits:** one coherent change per commit, with an imperative subject such as `Handle expired delivery leases`. Do not add `Co-authored-by` trailers.
- **SQL stays visible** where locks, constraints or transaction boundaries matter; avoid abstractions that hide them.
- **Security-sensitive changes** (authentication, destination policy, signing, secrets) should explain the threat they address in the pull request.

## Reporting security issues

Do not open a public issue for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
