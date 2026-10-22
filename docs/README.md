# Calab documentation — index

The docs are mostly in Russian. Files are not renamed: code and ADRs link to them by name. The public developer documentation (bots, MCP, OAuth, SSO) is on the website; its sources are in `apps/landing/src/content/docs/`.

## Architecture and protocol
- [01-architecture.md](01-architecture.md) — components and flows
- [02-media.md](02-media.md) — audio/video (the echo-cancellation rules are mandatory)
- [03-network.md](03-network.md) — network, TURN, ports
- [04-data-model.md](04-data-model.md) — data model, permissions, plan limits
- [05-realtime-protocol.md](05-realtime-protocol.md) — gateway and events
- [16-permissions-matrix.md](16-permissions-matrix.md) — who can do what
- [i18n-glossary.md](i18n-glossary.md) — terms for translations

## Development and quality
- [11-maintenance.md](11-maintenance.md) — CI, dependencies, PRs
- [12-tech-backlog.md](12-tech-backlog.md) — server/infra backlog
- [14-energy.md](14-energy.md), [18-optimization-audit.md](18-optimization-audit.md) — CPU/energy budget and measurements
- [../TESTING.md](../TESTING.md) — manual test scenarios (including [MCP](../TESTING.md#mcp-endpoint-for-bots-adr-0114)); [20-calendar-testing.md](20-calendar-testing.md), [21-boards-testing.md](21-boards-testing.md)
- [mobile/](mobile/shared-web-status.md) — the phone shell (ADR-0067), testing notes

## Bots, SDK, MCP
- [19-bot-api.md](19-bot-api.md) ([English](19-bot-api.en.md)) — overview and where the bot docs live
- Website (sources in `apps/landing/src/content/docs/{ru,en}/bots/`): quickstart, token and permissions, REST by group, gateway, webhooks, [sdk.md](../apps/landing/src/content/docs/en/bots/sdk.md), [mcp.md](../apps/landing/src/content/docs/en/bots/mcp.md) (MCP server, ADR-0114)
- Smoke test of MCP: [../tools/mcp-smoke.sh](../tools/mcp-smoke.sh)
- [17-gptunnel-api.md](17-gptunnel-api.md) — the transcription/AI provider API
- Routes reference: `apps/landing/src/content/docs/_routes.json` (generated from `apps/server/internal/app/botroutes.go`)

## Release and operations
- [06-deployment.md](06-deployment.md) — stand, production in Kubernetes, release runbook
- [07-roadmap.md](07-roadmap.md) — roadmap
- [13-usage.md](13-usage.md) — usage statistics
- [plans/](plans/release-2.0-boards.md) — release and feature plans; [qa/](qa/) — QA evidence per release

## Design and brand
- [08-design.md](08-design.md) — design system and UX rules (mandatory for UI code)
- [09-ui-backlog.md](09-ui-backlog.md) — UI backlog
- [10-branding.md](10-branding.md) — branding

## Decisions
- [adr/README.md](adr/README.md) — the list of ADRs (changing a decision = a new ADR); recent: [0114 MCP endpoint](adr/0114-mcp-endpoint-for-bots.md)
- [legal/](legal/README.md) — legal texts
