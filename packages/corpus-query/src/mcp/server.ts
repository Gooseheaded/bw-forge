#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError, isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createReplayCorpusMcpServer } from "./tools.js";

type TransportMode = "stdio" | "http";

type ServerOptions = {
  dbPath?: string;
  transport: TransportMode;
  host: string;
  port: number;
  path: string;
};

type HttpSession = {
  server: ReturnType<typeof createReplayCorpusMcpServer>;
  transport: StreamableHTTPServerTransport;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.dbPath) {
    process.env.BW_REPLAY_DB_PATH = resolve(options.dbPath);
  }

  if (options.transport === "http") {
    await startHttpServer(options);
    return;
  }

  await startStdioServer(options);
}

async function startStdioServer(options: ServerOptions): Promise<void> {
  const server = createReplayCorpusMcpServer();
  const transport = new StdioServerTransport();
  process.stderr.write(`bw-forge MCP stdio server ready\nDB: ${process.env.BW_REPLAY_DB_PATH ?? "(tool args required)"}\n`);
  await server.connect(transport as unknown as Transport);
}

async function startHttpServer(options: ServerOptions): Promise<void> {
  const sessions = new Map<string, HttpSession>();
  const routePath = normalizeRoutePath(options.path);

  const httpServer = createServer(async (req, res) => {
    try {
      if (!req.url) {
        writeJsonRpcError(res, 400, ErrorCode.InvalidRequest, "Missing request URL");
        return;
      }

      const requestUrl = new URL(req.url, `http://${options.host}:${options.port}`);
      if (requestUrl.pathname !== routePath) {
        writeNotFound(res);
        return;
      }

      applyCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        writePreflightResponse(res);
        return;
      }

      if (req.method === "POST") {
        await handleHttpPost(req, res, sessions);
        return;
      }

      if (req.method === "GET") {
        await handleHttpGet(req, res, sessions);
        return;
      }

      if (req.method === "DELETE") {
        await handleHttpDelete(req, res, sessions);
        return;
      }

      writeJsonRpcError(res, 405, ErrorCode.InvalidRequest, "Method not allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, ErrorCode.InternalError, message);
      }
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", rejectPromise);
      resolvePromise();
    });
  });

  console.log(`bw-forge MCP HTTP server listening at http://${options.host}:${options.port}${routePath}`);
  console.log(`DB: ${process.env.BW_REPLAY_DB_PATH ?? "(tool args required)"}`);

  const shutdown = async (): Promise<void> => {
    for (const [sessionId, session] of sessions) {
      try {
        await session.server.close();
      } catch {
        // Ignore shutdown cleanup errors.
      } finally {
        sessions.delete(sessionId);
      }
    }

    await new Promise<void>((resolvePromise) => {
      httpServer.close(() => resolvePromise());
    });
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function handleHttpPost(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, HttpSession>
): Promise<void> {
  const parsedBody = await readJsonBody(req);
  const sessionId = getSessionId(req);

  if (sessionId) {
    const existingSession = sessions.get(sessionId);
    if (!existingSession) {
      writeJsonRpcError(res, 404, ErrorCode.InvalidRequest, `Unknown MCP session: ${sessionId}`);
      return;
    }

    await existingSession.transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (!isInitializeRequest(parsedBody as JSONRPCMessage)) {
    writeJsonRpcError(res, 400, ErrorCode.InvalidRequest, "Missing MCP session ID or initialize request");
    return;
  }

  const server = createReplayCorpusMcpServer();
  let sessionRef: HttpSession | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (initializedSessionId) => {
      if (sessionRef) {
        sessions.set(initializedSessionId, sessionRef);
      }
    },
    onsessionclosed: async (closedSessionId) => {
      const session = sessions.get(closedSessionId);
      sessions.delete(closedSessionId);
      if (session) {
        await session.server.close();
      }
    }
  });
  sessionRef = { server, transport };
  transport.onclose = () => {
    const activeSessionId = transport.sessionId;
    if (activeSessionId) {
      sessions.delete(activeSessionId);
    }
  };

  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function handleHttpGet(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, HttpSession>
): Promise<void> {
  const session = getRequiredSession(req, res, sessions);
  if (!session) {
    return;
  }

  await session.transport.handleRequest(req, res);
}

async function handleHttpDelete(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, HttpSession>
): Promise<void> {
  const session = getRequiredSession(req, res, sessions);
  if (!session) {
    return;
  }

  await session.transport.handleRequest(req, res);
}

function getRequiredSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, HttpSession>
): HttpSession | undefined {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    writeJsonRpcError(res, 400, ErrorCode.InvalidRequest, "Missing MCP session ID");
    return undefined;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    writeJsonRpcError(res, 404, ErrorCode.InvalidRequest, `Unknown MCP session: ${sessionId}`);
    return undefined;
  }

  return session;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing JSON request body");
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new McpError(
      ErrorCode.ParseError,
      `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseArgs(argv: string[]): ServerOptions {
  let dbPath: string | undefined;
  let transport: TransportMode = "stdio";
  let host = "127.0.0.1";
  let port = 8089;
  let routePath = "/mcp";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--db":
        dbPath = argv[index + 1];
        index += 1;
        break;
      case "--transport":
        transport = parseTransport(argv[index + 1]);
        index += 1;
        break;
      case "--host":
        host = requireArgValue("--host", argv[index + 1]);
        index += 1;
        break;
      case "--port":
        port = parsePort(argv[index + 1]);
        index += 1;
        break;
      case "--path":
        routePath = requireArgValue("--path", argv[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ...(dbPath ? { dbPath } : {}),
    transport,
    host,
    port,
    path: normalizeRoutePath(routePath)
  };
}

function parseTransport(value: string | undefined): TransportMode {
  const normalized = requireArgValue("--transport", value).toLowerCase();
  if (normalized === "stdio" || normalized === "http") {
    return normalized;
  }
  throw new Error(`Invalid --transport value: ${value}`);
}

function parsePort(value: string | undefined): number {
  const parsed = Number(requireArgValue("--port", value));
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return parsed;
}

function requireArgValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function normalizeRoutePath(value: string): string {
  if (!value.startsWith("/")) {
    return `/${value}`;
  }
  return value;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = getCorsAllowedOrigin(req);
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
  }
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", getCorsAllowedHeaders(req));
  res.setHeader("access-control-expose-headers", "mcp-session-id");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "Origin, Access-Control-Request-Headers");
}

function getCorsAllowedOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) {
    return undefined;
  }
  return origin;
}

function getCorsAllowedHeaders(req: IncomingMessage): string {
  const requested = req.headers["access-control-request-headers"];
  if (typeof requested === "string" && requested.trim().length > 0) {
    return requested;
  }
  return "content-type, accept, mcp-session-id, last-event-id";
}

function writePreflightResponse(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

function writeNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not found");
}

function writeJsonRpcError(
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string
): void {
  res.statusCode = httpStatus;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code,
        message
      },
      id: null
    })
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
