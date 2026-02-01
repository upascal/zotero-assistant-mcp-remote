#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for zotero-assistant-mcp
 *
 * Usage: npx zotero-assistant-mcp
 *
 * Starts a stdio MCP server for use with Claude Desktop, Claude Code, or
 * any MCP-compatible client.
 *
 * Required environment variables:
 *   ZOTERO_API_KEY    — Your Zotero API key (from https://www.zotero.org/settings/keys)
 *   ZOTERO_LIBRARY_ID — Your Zotero user library ID
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "../src/index.js";

const apiKey = process.env.ZOTERO_API_KEY;
const libraryId = process.env.ZOTERO_LIBRARY_ID;

if (!apiKey || !libraryId) {
  console.error("Error: Missing required environment variables.");
  console.error("");
  console.error("  ZOTERO_API_KEY    — Your Zotero API key");
  console.error("  ZOTERO_LIBRARY_ID — Your Zotero user library ID");
  console.error("");
  console.error("Get your credentials at: https://www.zotero.org/settings/keys");
  console.error("");
  console.error("Example:");
  console.error("  ZOTERO_API_KEY=abc123 ZOTERO_LIBRARY_ID=12345 npx zotero-assistant-mcp");
  process.exit(1);
}

const server = new McpServer({
  name: "zotero-assistant",
  version: "0.3.0",
});

registerTools(server, { apiKey, libraryId });

const transport = new StdioServerTransport();
await server.connect(transport);
