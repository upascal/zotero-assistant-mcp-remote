/**
 * Zotero MCP Server — Remote (Cloudflare Workers)
 *
 * A remote Zotero management tool using the Cloudflare Agents SDK
 * and zotero-api-client. Supports search, read, write, and manage operations.
 *
 * Credentials are stored as Wrangler secrets:
 *   ZOTERO_API_KEY    — Zotero API key
 *   ZOTERO_LIBRARY_ID — Zotero user library ID
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

import {
  getItemTypes,
  listCollections,
  createItem,
  attachPdfFromUrl,
  attachSnapshot,
  searchItems,
  getItem,
  getItemFulltext,
  getCollectionItems,
  listTags,
  getRecentItems,
  createNote,
  updateItem,
  createCollection,
} from "./zotero.js";

// -------------------------------------------------------------------------
// McpAgent — Durable Object that serves the MCP protocol
// -------------------------------------------------------------------------

export class ZoteroMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "zotero-assistant",
    version: "0.2.0",
  });

  async init() {
    const getCredentials = () => {
      const apiKey = this.env.ZOTERO_API_KEY;
      const libraryId = this.env.ZOTERO_LIBRARY_ID;
      if (!apiKey || !libraryId) {
        throw new Error(
          "Zotero not configured. Set ZOTERO_API_KEY and ZOTERO_LIBRARY_ID as Wrangler secrets. " +
            "Get credentials from: https://www.zotero.org/settings/keys"
        );
      }
      return { apiKey, libraryId };
    };

    // =====================================================================
    // Utility Tools
    // =====================================================================

    this.server.tool(
      "get_help",
      "Get workflow instructions for adding items to Zotero. Call this whenever you're unsure how to proceed.",
      async () => {
        const help = {
          workflow: {
            step1_fetch:
              "Use YOUR OWN built-in tools to fetch the URL content. " +
              "DO NOT open new browser tabs — just fetch the content.",
            step2_extract:
              "Read the content and extract metadata: " +
              "title, authors (may be organizations), date, abstract (write one if missing), " +
              "publisher/website name, and 2-5 descriptive tags.",
            step3_find_collection:
              "Call list_collections to find the right folder. " +
              "If user didn't specify and multiple options match, ask them.",
            step4_assess_confidence:
              "If confident (clear metadata, no guessing) -> proceed. " +
              "If uncertain (messy source, wrote abstract, guessed fields) -> ask user to confirm.",
            step5_save:
              "Call save_item with all extracted metadata. " +
              "Include pdf_url if PDF available, OR snapshot_url for webpages.",
          },
          available_tools: {
            search_and_browse: [
              "search_items — Search library by text, tags, type, or collection",
              "get_collection_items — List items in a specific collection",
              "get_recent_items — Recently added/modified items",
              "list_collections — All collections (folders)",
              "create_collection — Create a new collection (folder)",
              "list_tags — All tags in library",
            ],
            read: [
              "get_item — Full metadata + children summary for a single item",
              "get_item_fulltext — Extracted text content (from PDFs, etc.)",
            ],
            write: [
              "save_item — Create new item with metadata + attachments",
              "attach_pdf — Attach PDF to existing item",
              "attach_snapshot — Attach webpage snapshot to existing item",
              "create_note — Create note on existing item",
              "update_item — Modify metadata/tags on existing item",
            ],
            utility: [
              "get_help — This help text",
              "get_item_types — List valid item types",
              "prepare_url — Get fetch instructions for a URL",
            ],
          },
          tips: [
            "Always include tags (2-5 descriptive keywords)",
            "Write an abstract if the source lacks one",
            "Authors can be organizations like 'World Health Organization'",
            "Use snapshot_url for webpages, pdf_url for documents",
            "Don't open browser tabs just to read content — use fetch tools instead",
            "Use search_items to find existing items before creating duplicates",
            "Use create_note to add analysis or commentary to saved items",
          ],
        };

        return {
          content: [{ type: "text", text: JSON.stringify(help, null, 2) }],
        };
      }
    );

    this.server.tool(
      "prepare_url",
      "Get instructions for fetching a URL's content before saving to Zotero. This tool does NOT fetch the content itself.",
      { url: z.string().url().describe("The URL you want to fetch content from") },
      async ({ url }) => {
        const isPdf = /\.pdf$/i.test(url) || /\/pdf\//i.test(url);

        const result = {
          url,
          is_pdf: isPdf,
          instructions: isPdf
            ? "This appears to be a PDF. When you call save_item, " +
              "include this URL as the pdf_url parameter to attach it."
            : "DO NOT open a browser tab for this URL. " +
              "Use your built-in web_fetch or read_url tool to get the content. " +
              "Then extract the metadata and call save_item.",
          next_steps: [
            `1. Fetch content from ${url} using your internal tools`,
            "2. Extract: title, authors, date, abstract, tags",
            "3. Call list_collections to find the right folder",
            `4. Call save_item with all metadata and ${isPdf ? `pdf_url='${url}'` : `snapshot_url='${url}'`}`,
          ],
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_item_types",
      "Get list of supported item types for save_item.",
      async () => {
        return {
          content: [
            { type: "text", text: JSON.stringify(getItemTypes(), null, 2) },
          ],
        };
      }
    );

    // =====================================================================
    // Search & Browse Tools
    // =====================================================================

    this.server.tool(
      "search_items",
      "Search the Zotero library by text query, tags, item type, or collection. Returns summaries with keys, titles, creators, dates, and tags.",
      {
        query: z
          .string()
          .optional()
          .describe("Free text search (searches titles + creators)"),
        tag: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Filter by tag name (string or array for AND logic)"),
        item_type: z
          .string()
          .optional()
          .describe('Filter by item type (e.g. "article", "book")'),
        collection_id: z
          .string()
          .optional()
          .describe("Limit to a specific collection"),
        sort: z
          .string()
          .default("dateModified")
          .describe("Sort field (default: dateModified)"),
        direction: z
          .enum(["asc", "desc"])
          .default("desc")
          .describe("Sort direction"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(25)
          .describe("Max results (1-100)"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await searchItems(apiKey, libraryId, {
          query: params.query,
          tag: params.tag,
          itemType: params.item_type,
          collectionId: params.collection_id,
          sort: params.sort,
          direction: params.direction,
          limit: params.limit,
          offset: params.offset,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_collection_items",
      "List items in a specific Zotero collection.",
      {
        collection_id: z
          .string()
          .describe("Collection key from list_collections"),
        sort: z.string().default("dateModified").describe("Sort field"),
        direction: z
          .enum(["asc", "desc"])
          .default("desc")
          .describe("Sort direction"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(25)
          .describe("Max results"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getCollectionItems(
          apiKey,
          libraryId,
          params.collection_id,
          {
            sort: params.sort,
            direction: params.direction,
            limit: params.limit,
            offset: params.offset,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_recent_items",
      "Get recently added or modified items from the Zotero library.",
      {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max results (1-50)"),
        sort: z
          .enum(["dateAdded", "dateModified"])
          .default("dateAdded")
          .describe("Sort by dateAdded or dateModified"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getRecentItems(apiKey, libraryId, {
          limit: params.limit,
          sort: params.sort,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "list_collections",
      "List all collections (folders) in the Zotero library. Call this before save_item to find the right collection_id.",
      async () => {
        const { apiKey, libraryId } = getCredentials();
        try {
          const collections = await listCollections(apiKey, libraryId);
          return {
            content: [
              { type: "text", text: JSON.stringify(collections, null, 2) },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: err.message }) },
            ],
          };
        }
      }
    );

    this.server.tool(
      "create_collection",
      "Create a new collection (folder) in the Zotero library. Optionally nest it under an existing collection by providing a parent ID.",
      {
        name: z.string().describe("Name for the new collection"),
        parent_collection_id: z
          .string()
          .optional()
          .describe(
            "Parent collection key to nest under (from list_collections). Omit for top-level."
          ),
      },
      async ({ name, parent_collection_id }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await createCollection(
          apiKey,
          libraryId,
          name,
          parent_collection_id
        );

        if (result.success) {
          (result as any).nextSteps = [
            `Use collection_id '${result.collection_key}' when calling save_item`,
            "Use list_collections to verify it appears",
          ];
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "list_tags",
      "List all tags in the Zotero library. Useful for discovering existing tags before filtering.",
      {
        limit: z
          .number()
          .min(1)
          .max(500)
          .default(100)
          .describe("Max tags to return"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await listTags(apiKey, libraryId, {
          limit: params.limit,
          offset: params.offset,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // =====================================================================
    // Read Tools
    // =====================================================================

    this.server.tool(
      "get_item",
      "Get full metadata for a single Zotero item by its key, including a summary of child attachments and notes.",
      {
        item_key: z.string().describe("The Zotero item key"),
      },
      async ({ item_key }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getItem(apiKey, libraryId, item_key);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "get_item_fulltext",
      "Get the full-text content of a Zotero item (extracted text from PDFs, notes, etc.). Works on parent items by checking child attachments.",
      {
        item_key: z
          .string()
          .describe("The Zotero item key (parent or attachment)"),
      },
      async ({ item_key }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await getItemFulltext(apiKey, libraryId, item_key);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // =====================================================================
    // Write Tools
    // =====================================================================

    this.server.tool(
      "save_item",
      "Create a new item in your Zotero library. " +
        "WORKFLOW: 1) Fetch and read source content thoroughly. " +
        "2) Extract ALL metadata: title, authors, date, abstract, publisher. " +
        "3) Generate 2-5 descriptive tags. 4) Call list_collections for the right folder. " +
        "5) If confident -> proceed. If uncertain -> ask user first. " +
        "ATTACHMENTS: Include pdf_url for PDFs, snapshot_url for webpages.",
      {
        title: z.string().describe("Item title (required)"),
        item_type: z
          .string()
          .default("webpage")
          .describe(
            "Type: article, journal, book, chapter, conference, thesis, report, " +
              "webpage, blog, news, magazine, document, legal, case, patent, video, podcast, presentation"
          ),
        authors: z
          .array(z.string())
          .optional()
          .describe('Author names — can be organizations like "WHO"'),
        date: z
          .string()
          .optional()
          .describe('Publication date, e.g. "2025-07-25" or "July 2025"'),
        url: z.string().optional().describe("URL of the item"),
        abstract: z
          .string()
          .optional()
          .describe("Abstract or summary — write one if missing"),
        publication: z
          .string()
          .optional()
          .describe("Journal/publication/website name"),
        volume: z.string().optional().describe("Volume number"),
        issue: z.string().optional().describe("Issue number"),
        pages: z.string().optional().describe("Page range"),
        doi: z.string().optional().describe("DOI identifier"),
        tags: z.array(z.string()).optional().describe("2-5 descriptive tags"),
        collection_id: z
          .string()
          .optional()
          .describe("Collection ID from list_collections"),
        pdf_url: z
          .string()
          .optional()
          .describe("URL to download PDF attachment from"),
        snapshot_url: z
          .string()
          .optional()
          .describe("URL to save as HTML snapshot"),
        extra: z
          .string()
          .optional()
          .describe("Additional notes for the Extra field"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();

        const result = await createItem(apiKey, libraryId, {
          title: params.title,
          itemType: params.item_type,
          authors: params.authors || [],
          date: params.date,
          url: params.url,
          abstract: params.abstract,
          publication: params.publication,
          volume: params.volume,
          issue: params.issue,
          pages: params.pages,
          doi: params.doi,
          tags: params.tags || [],
          collectionId: params.collection_id,
          pdfUrl: params.pdf_url,
          snapshotUrl: params.snapshot_url,
          extra: params.extra,
        });

        if (result.success) {
          (result as any).nextSteps = [
            "Use attach_pdf or attach_snapshot to add more attachments",
            "Use create_note to add analysis or summary",
            "Use get_item to verify the saved metadata",
          ];
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "attach_pdf",
      "Download a PDF from a URL and attach it to an existing Zotero item.",
      {
        parent_item_key: z
          .string()
          .describe("The key of the parent item to attach to"),
        pdf_url: z.string().url().describe("URL to download the PDF from"),
        filename: z.string().optional().describe("Optional filename"),
      },
      async ({ parent_item_key, pdf_url, filename }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await attachPdfFromUrl(
          apiKey,
          libraryId,
          parent_item_key,
          pdf_url,
          filename
        );

        if (result.success) {
          (result as any).nextSteps = [
            "Use create_note to add analysis or summary of the PDF",
            "Use get_item_fulltext to read the extracted text (after Zotero indexes it)",
          ];
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "attach_snapshot",
      "Save a webpage as an HTML snapshot and attach it to an existing Zotero item. Always call this for webpage sources — content can disappear.",
      {
        parent_item_key: z
          .string()
          .describe("The key returned by save_item"),
        url: z.string().url().describe("URL of the webpage to snapshot"),
        title: z
          .string()
          .optional()
          .describe("Optional title for the snapshot"),
      },
      async ({ parent_item_key, url, title }) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await attachSnapshot(
          apiKey,
          libraryId,
          parent_item_key,
          url,
          title
        );

        if (result.success) {
          (result as any).nextSteps = [
            "Use create_note to add analysis or commentary",
          ];
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "create_note",
      "Create a new note attached to an existing Zotero item. Use this to add analysis, summaries, or observations. Supports HTML content.",
      {
        item_key: z
          .string()
          .describe("Parent item key to attach the note to"),
        content: z.string().describe("Note text (supports HTML)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags to apply to the note"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await createNote(
          apiKey,
          libraryId,
          params.item_key,
          params.content,
          params.tags || []
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    this.server.tool(
      "update_item",
      "Update metadata on an existing Zotero item — fix titles, add/remove tags, change collections, update abstracts.",
      {
        item_key: z.string().describe("The item key to update"),
        title: z.string().optional().describe("New title"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Replacement tag array (replaces all tags)"),
        add_tags: z
          .array(z.string())
          .optional()
          .describe("Tags to add (preserves existing)"),
        remove_tags: z
          .array(z.string())
          .optional()
          .describe("Tags to remove"),
        collections: z
          .array(z.string())
          .optional()
          .describe("Replacement collection array"),
        abstract: z.string().optional().describe("New abstract"),
        date: z.string().optional().describe("New date"),
        extra: z.string().optional().describe("New Extra field content"),
      },
      async (params) => {
        const { apiKey, libraryId } = getCredentials();
        const result = await updateItem(apiKey, libraryId, params.item_key, {
          title: params.title,
          tags: params.tags,
          add_tags: params.add_tags,
          remove_tags: params.remove_tags,
          collections: params.collections,
          abstract: params.abstract,
          date: params.date,
          extra: params.extra,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );
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
