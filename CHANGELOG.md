# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project-scoped HTTP API with operator, `manage` and `publish` keys, OpenAPI document and per-project rate limiting shared across API processes.
- Transactional event ingestion with idempotency keys, canonical content comparison and fan-out to subscribed endpoints.
- Delivery worker with PostgreSQL leases, bounded concurrency, retries with backoff and jitter, crash recovery and replay of finished deliveries.
- HMAC-SHA256 request signing, encrypted endpoint secrets and outbound protection against private and reserved destinations, DNS rebinding and redirects.
- Health checks, OpenTelemetry traces linking each publishing request to its delivery attempts, and delivery metrics.
- Retention cleanup, a local failure demo with a sample receiver, a reproducible benchmark and operational documentation.
