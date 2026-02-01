#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for deploy-zotero-assistant-mcp
 *
 * Usage: npx deploy-zotero-assistant-mcp
 *
 * Launches the browser-based setup wizard that handles Cloudflare login,
 * Zotero credential testing, and Worker deployment.
 */

// Just run the setup server — it handles everything
import "../setup/server.js";
