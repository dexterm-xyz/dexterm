---
id: docs-configuration-the-analyst-s-launch
title: Configuration and files on disk › The analyst's launch
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: The analyst's launch
anchor: the-analyst-s-launch
url: https://dexterm.xyz/docs/configuration#the-analyst-s-launch
tags:
  - docs
  - configuration
  - analyst
  - launch
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

For the record, the analyst is spawned as `claude -p` with `--output-format stream-json`, `--tools ''` (no built-in tools), `--strict-mcp-config` pointing at the dexterm server only, `--allowedTools mcp__dexterm__*`, `--permission-mode dontAsk`, `--setting-sources ''` (none of your Claude Code settings or other plugins), the dexterm plugin directory for the skills, the analyst system prompt appended, a JSON schema for structured skills, and `--disallowedTools` for the action tools in scan mode. It cannot read files, run commands or reach any other MCP server from inside dexterm.
