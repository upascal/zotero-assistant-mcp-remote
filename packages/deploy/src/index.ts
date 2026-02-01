/**
 * Zotero MCP Server — Cloudflare Workers Deployment
 *
 * Wraps the transport-agnostic zotero-assistant-mcp package in a
 * Cloudflare Worker with Durable Objects and bearer token authentication.
 *
 * Credentials are stored as Wrangler secrets:
 *   ZOTERO_API_KEY    — Zotero API key
 *   ZOTERO_LIBRARY_ID — Zotero user library ID
 *   BEARER_TOKEN      — Authentication token for MCP clients
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "zotero-assistant-mcp";

// ---------------------------------------------------------------------------
// Patch global fetch for Cloudflare Workers compatibility.
// The zotero-api-client library passes `cache: 'default'` to every fetch()
// call, but Cloudflare Workers does not support browser cache modes and will
// throw "Unsupported cache mode: default". We intercept and strip it.
// ---------------------------------------------------------------------------
const _origFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (init) {
    // Remove the unsupported cache property
    const { cache: _, ...rest } = init as RequestInit & { cache?: string };
    return _origFetch(input, rest);
  }
  return _origFetch(input);
};

// -------------------------------------------------------------------------
// McpAgent — Durable Object that serves the MCP protocol
// -------------------------------------------------------------------------

export class ZoteroMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "zotero-assistant",
    version: "0.3.0",
  });

  async init() {
    registerTools(this.server, {
      apiKey: this.env.ZOTERO_API_KEY,
      libraryId: this.env.ZOTERO_LIBRARY_ID,
    });
  }
}

// -------------------------------------------------------------------------
// Worker fetch handler
// -------------------------------------------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check — no secrets exposed
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "zotero-assistant",
          version: "0.3.0",
          status: "ok",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // -----------------------------------------------------------------------
    // Authentication — supports two methods:
    //   1. URL token:    /mcp/t/{token}  (for Claude Desktop UI connector)
    //   2. Bearer header: Authorization: Bearer {token}  (for API/CLI)
    // -----------------------------------------------------------------------

    // Method 1: Token in URL path — /mcp/t/{token} or /mcp/t/{token}/...
    const tokenMatch = url.pathname.match(/^\/mcp\/t\/([^/]+)(\/.*)?$/);
    if (tokenMatch) {
      const urlToken = tokenMatch[1];
      if (!env.BEARER_TOKEN || urlToken !== env.BEARER_TOKEN) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }
      // Rewrite URL: strip /t/{token} so the MCP handler sees /mcp
      const rewrittenPath = "/mcp" + (tokenMatch[2] || "");
      const rewrittenUrl = new URL(rewrittenPath, url.origin);
      rewrittenUrl.search = url.search;
      const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
      return (
        ZoteroMCP.serve("/mcp") as {
          fetch: (
            req: Request,
            env: Env,
            ctx: ExecutionContext
          ) => Response | Promise<Response>;
        }
      ).fetch(rewrittenRequest, env, ctx);
    }

    // Method 2: Bearer header on /mcp
    if (url.pathname.startsWith("/mcp")) {
      const auth = request.headers.get("Authorization");
      if (!env.BEARER_TOKEN || !auth || auth !== `Bearer ${env.BEARER_TOKEN}`) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "WWW-Authenticate": "Bearer",
            },
          }
        );
      }
    }

    return (
      ZoteroMCP.serve("/mcp") as {
        fetch: (
          req: Request,
          env: Env,
          ctx: ExecutionContext
        ) => Response | Promise<Response>;
      }
    ).fetch(request, env, ctx);
  },
};
