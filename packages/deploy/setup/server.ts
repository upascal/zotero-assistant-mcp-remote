/**
 * Zotero MCP — Local Setup Server
 *
 * A lightweight HTTP server that serves the setup wizard UI and handles
 * Zotero API testing, Cloudflare login, and Worker deployment.
 *
 * Run with: npx tsx setup/server.ts
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync, exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(join(__dirname, ".."));
const HTML_PATH = join(__dirname, "index.html");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJson(body: string): Record<string, string> {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

// -------------------------------------------------------------------------
// API: Check Cloudflare login status
// -------------------------------------------------------------------------

function checkCfLogin(): { loggedIn: boolean; account?: string } {
  try {
    const output = execSync("npx wrangler whoami 2>&1", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });

    // wrangler whoami prints something like:
    //   Getting User settings...
    //   👋 You are logged in with an API Token, associated with the email user@example.com!
    // or if using OAuth:
    //   👋 You are logged in with an OAuth Token, associated with the email user@example.com!
    if (
      output.includes("You are logged in") ||
      output.includes("associated with")
    ) {
      // Try to extract email or account name
      const emailMatch = output.match(
        /associated with the email ([^\s!]+)/
      );
      const account = emailMatch ? emailMatch[1] : undefined;
      return { loggedIn: true, account };
    }

    return { loggedIn: false };
  } catch {
    return { loggedIn: false };
  }
}

// -------------------------------------------------------------------------
// API: Cloudflare login
// -------------------------------------------------------------------------

async function cfLogin(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = exec("npx wrangler login", {
      cwd: PROJECT_ROOT,
      timeout: 120000,
    });

    let output = "";
    child.stdout?.on("data", (data: string) => (output += data));
    child.stderr?.on("data", (data: string) => (output += data));

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: "Cloudflare login failed. Please try again.",
        });
      }
    });

    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// -------------------------------------------------------------------------
// API: Test Zotero connection
// -------------------------------------------------------------------------

function testZoteroConnection(
  apiKey: string,
  libraryId: string
): Promise<{ success: boolean; error?: string; collections?: string[] }> {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.zotero.org",
      path: `/users/${libraryId}/collections?limit=25`,
      method: "GET",
      headers: {
        "Zotero-API-Key": apiKey,
        "Zotero-API-Version": "3",
      },
    };

    const req = httpsRequest(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const collections = data.map(
              (c: { data: { name: string } }) => c.data.name
            );
            resolve({ success: true, collections });
          } catch {
            resolve({ success: true, collections: [] });
          }
        } else if (res.statusCode === 403) {
          resolve({
            success: false,
            error: "Invalid API key or insufficient permissions.",
          });
        } else if (res.statusCode === 404) {
          resolve({ success: false, error: "Library ID not found." });
        } else {
          resolve({
            success: false,
            error: `Zotero API returned status ${res.statusCode}.`,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ success: false, error: `Connection failed: ${err.message}` });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ success: false, error: "Connection timed out." });
    });

    req.end();
  });
}

// -------------------------------------------------------------------------
// API: Deploy Worker + set secrets
// -------------------------------------------------------------------------

interface DeployResult {
  success: boolean;
  url?: string;
  token?: string;
  claudeConfig?: Record<string, unknown>;
  error?: string;
}

async function deployWorker(
  apiKey: string,
  libraryId: string
): Promise<DeployResult> {
  try {
    // 1. Deploy the worker
    console.log("[deploy] Running wrangler deploy...");
    const deployOutput = execSync("npx wrangler deploy 2>&1", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 120000,
    });
    console.log("[deploy] Deploy output:", deployOutput);

    // Extract the URL from deploy output
    // Looks for: https://something.workers.dev
    const urlMatch = deployOutput.match(
      /https:\/\/[^\s]+\.workers\.dev/
    );
    if (!urlMatch) {
      return {
        success: false,
        error:
          "Deployed but could not find Worker URL in output. Check wrangler output.",
      };
    }
    const workerUrl = urlMatch[0];

    // 2. Generate bearer token
    const bearerToken = randomBytes(32).toString("hex");

    // 3. Set secrets via wrangler secret:bulk (pipe JSON to stdin)
    console.log("[deploy] Setting secrets...");
    const secrets = JSON.stringify({
      ZOTERO_API_KEY: apiKey,
      ZOTERO_LIBRARY_ID: libraryId,
      BEARER_TOKEN: bearerToken,
    });

    execSync(`echo '${secrets}' | npx wrangler secret bulk 2>&1`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    console.log("[deploy] Secrets set successfully");

    // 4. Build Claude Desktop config
    const mcpUrl = `${workerUrl}/mcp`;
    const claudeConfig = {
      mcpServers: {
        zotero: {
          command: "npx",
          args: [
            "mcp-remote",
            mcpUrl,
            "--header",
            "Authorization:${AUTH_HEADER}",
          ],
          env: {
            AUTH_HEADER: `Bearer ${bearerToken}`,
          },
        },
      },
    };

    return {
      success: true,
      url: mcpUrl,
      token: bearerToken,
      claudeConfig,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[deploy] Error:", message);
    return { success: false, error: `Deployment failed: ${message}` };
  }
}

// -------------------------------------------------------------------------
// HTTP Server
// -------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve HTML
  if (url.pathname === "/" && req.method === "GET") {
    try {
      const html = readFileSync(HTML_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      jsonResponse(res, 500, { error: "Could not read index.html" });
    }
    return;
  }

  // API: Status check
  if (url.pathname === "/api/status" && req.method === "GET") {
    const result = checkCfLogin();
    jsonResponse(res, 200, result);
    return;
  }

  // API: Cloudflare login
  if (url.pathname === "/api/login" && req.method === "POST") {
    const result = await cfLogin();
    jsonResponse(res, 200, result);
    return;
  }

  // API: Test Zotero connection
  if (url.pathname === "/api/test" && req.method === "POST") {
    const body = parseJson(await readBody(req));
    if (!body.apiKey || !body.libraryId) {
      jsonResponse(res, 400, { error: "Missing apiKey or libraryId" });
      return;
    }
    const result = await testZoteroConnection(body.apiKey, body.libraryId);
    jsonResponse(res, 200, result);
    return;
  }

  // API: Deploy
  if (url.pathname === "/api/deploy" && req.method === "POST") {
    const body = parseJson(await readBody(req));
    if (!body.apiKey || !body.libraryId) {
      jsonResponse(res, 400, { error: "Missing apiKey or libraryId" });
      return;
    }
    const result = await deployWorker(body.apiKey, body.libraryId);
    jsonResponse(res, 200, result);
    return;
  }

  // API: Shutdown
  if (url.pathname === "/api/shutdown" && req.method === "GET") {
    jsonResponse(res, 200, { message: "Shutting down..." });
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // 404
  jsonResponse(res, 404, { error: "Not found" });
}

// -------------------------------------------------------------------------
// Start
// -------------------------------------------------------------------------

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    jsonResponse(res, 500, { error: "Internal server error" });
  });
});

// Find a free port
server.listen(0, async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3456;
  const url = `http://localhost:${port}`;

  console.log("");
  console.log("  \x1b[1m\x1b[31m🔬 Zotero MCP Server Setup\x1b[0m");
  console.log("");
  console.log(`  Running at: \x1b[4m${url}\x1b[0m`);
  console.log("");
  console.log("  Opening your browser...");
  console.log("  (Press Ctrl+C to stop)");
  console.log("");

  // Open browser
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    console.log(`  Could not open browser automatically.`);
    console.log(`  Please open ${url} manually.`);
  }
});
