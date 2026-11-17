# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project foundation: Express server on Bun that also runs on Node, with a `/health` endpoint reporting the running version.
- Transport-agnostic JSON-RPC 2.0 core: message parsing and classification, and dispatch to method handlers with standard error responses.
- The five supported spec revisions (2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05) and their era, modern or legacy.
- Official `schema.json` of every revision, vendored under `schemas/`, and a test harness that validates messages against them.
- Tests through the official MCP TypeScript SDK client.

[Unreleased]: https://github.com/axium-lab/mcp-mock/commits/main
