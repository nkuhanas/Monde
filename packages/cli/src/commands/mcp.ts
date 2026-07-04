import { readServiceMetadata } from "../service-client.js";

export async function bridgeMcp(options: { run?: string; token?: string } = {}): Promise<void> {
  const runId = options.run ?? process.env.MONDE_RUN_ID;
  const runToken = options.token ?? process.env.MONDE_RUN_TOKEN;
  const mcpAddr = process.env.MONDE_MCP_ADDR ?? readServiceMetadata().mcp_addr;

  if (!runId || !runToken) {
    throw new Error("MCP bridge requires --run/--token or MONDE_RUN_ID/MONDE_RUN_TOKEN.");
  }

  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    buffer = await flushMcpInput(buffer, mcpAddr, runId, runToken);
  }

  await flushMcpInput(buffer, mcpAddr, runId, runToken, true);
}

type BridgeFraming = "line" | "header";

async function flushMcpInput(
  input: Buffer,
  endpoint: string,
  runId: string,
  runToken: string,
  final = false
): Promise<Buffer> {
  let buffer = input;
  while (buffer.length > 0) {
    const parsed = parseNextMessage(buffer, final);
    if (!parsed) {
      return buffer;
    }

    buffer = parsed.rest;
    if (!parsed.message) {
      continue;
    }

    const response = await forwardMcpMessage(endpoint, runId, runToken, parsed.message);
    writeMcpResponse(response, parsed.framing);
  }

  return buffer;
}

function parseNextMessage(
  buffer: Buffer,
  final: boolean
): { message?: Record<string, unknown>; rest: Buffer; framing: BridgeFraming } | undefined {
  const trimmedPreview = buffer.subarray(0, Math.min(buffer.length, 64)).toString("ascii").trimStart().toLowerCase();
  if (trimmedPreview.startsWith("content-length:")) {
    const delimiter = findHeaderDelimiter(buffer);
    if (!delimiter) {
      if (final) {
        throw new Error("Incomplete MCP header frame.");
      }
      return undefined;
    }

    const headerText = buffer.subarray(0, delimiter.index).toString("ascii");
    const match = /^content-length:\s*(\d+)\s*$/im.exec(headerText);
    if (!match) {
      throw new Error("MCP header frame is missing Content-Length.");
    }

    const length = Number.parseInt(match[1] ?? "", 10);
    const bodyStart = delimiter.index + delimiter.length;
    const totalLength = bodyStart + length;
    if (buffer.length < totalLength) {
      if (final) {
        throw new Error("Incomplete MCP body frame.");
      }
      return undefined;
    }

    const body = buffer.subarray(bodyStart, totalLength).toString("utf8").trim();
    return {
      message: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
      rest: buffer.subarray(totalLength),
      framing: "header"
    };
  }

  const newlineIndex = buffer.indexOf(0x0a);
  if (newlineIndex < 0) {
    const trailing = buffer.toString("utf8").trim();
    if (!final || !trailing) {
      return undefined;
    }

    return {
      message: JSON.parse(trailing) as Record<string, unknown>,
      rest: Buffer.alloc(0),
      framing: "line"
    };
  }

  const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
  return {
    message: line ? (JSON.parse(line) as Record<string, unknown>) : undefined,
    rest: buffer.subarray(newlineIndex + 1),
    framing: "line"
  };
}

function findHeaderDelimiter(buffer: Buffer): { index: number; length: number } | undefined {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return { index: crlf, length: 4 };
  }

  const lf = buffer.indexOf("\n\n");
  return lf >= 0 ? { index: lf, length: 2 } : undefined;
}

function writeMcpResponse(response: unknown, framing: BridgeFraming): void {
  if (response === undefined) {
    return;
  }

  const payload = JSON.stringify(response);
  if (framing === "header") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
    return;
  }

  process.stdout.write(`${payload}\n`);
}

async function forwardMcpMessage(
  endpoint: string,
  runId: string,
  runToken: string,
  message: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-monde-run-id": runId,
      "x-monde-run-token": runToken
    },
    body: JSON.stringify(message)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP bridge request failed (${response.status}): ${text}`);
  }

  return text ? (JSON.parse(text) as unknown) : undefined;
}
