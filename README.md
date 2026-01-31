# Zotero Assistant MCP — Remote (Cloudflare Workers)

A remote MCP server for reading, writing, and managing items in your Zotero library, deployed on Cloudflare Workers.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A [Zotero API key](https://www.zotero.org/settings/keys) with read/write access
- Your Zotero user library ID (visible on the same settings page)

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure local development credentials

Edit `.dev.vars` with your Zotero credentials:

```
ZOTERO_API_KEY=your-api-key-here
ZOTERO_LIBRARY_ID=your-library-id-here
```

### 3. Run locally

```sh
npm run dev
```

The server starts at `http://localhost:8787/mcp`.

### 4. Test with MCP Inspector

In a separate terminal:

```sh
npx @modelcontextprotocol/inspector@latest
```

Open `http://localhost:5173` in your browser and connect to `http://localhost:8787/mcp`.

## Deploy to Cloudflare

### 1. Set production secrets

```sh
npx wrangler secret put ZOTERO_API_KEY
npx wrangler secret put ZOTERO_LIBRARY_ID
```

### 2. Deploy

```sh
npm run deploy
```

Your server will be live at `https://zotero-assistant-mcp.<your-account>.workers.dev/mcp`.

## Connect from Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "zotero-assistant": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://zotero-assistant-mcp.<your-account>.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop to load the server.

## Available Tools (14)

| Category | Tool | Description |
|----------|------|-------------|
| Utility | `get_help` | Workflow instructions |
| Utility | `get_item_types` | List valid item types |
| Utility | `prepare_url` | Get fetch instructions for a URL |
| Search | `search_items` | Search by text, tags, type, or collection |
| Search | `get_collection_items` | List items in a collection |
| Search | `get_recent_items` | Recently added/modified items |
| Search | `list_collections` | All collections (folders) |
| Search | `create_collection` | Create a new collection |
| Search | `list_tags` | All tags in library |
| Read | `get_item` | Full metadata + children for an item |
| Read | `get_item_fulltext` | Extracted text content |
| Write | `save_item` | Create new item with metadata |
| Write | `attach_pdf` | Attach PDF to existing item |
| Write | `attach_snapshot` | Attach webpage snapshot |
| Write | `create_note` | Create note on existing item |
| Write | `update_item` | Modify metadata/tags |

## Security Note

This is a single-user, auth-less deployment. Your Zotero credentials are stored as Wrangler secrets and never exposed to clients. However, the MCP endpoint itself is publicly accessible — anyone who knows the URL can use your Zotero library.

For production use, consider adding OAuth authentication. See the [Cloudflare MCP auth docs](https://developers.cloudflare.com/agents/model-context-protocol/authorization/).
