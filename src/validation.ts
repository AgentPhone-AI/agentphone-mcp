import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * Replace the MCP SDK's default input-validation error — a raw, multi-line JSON
 * dump of Zod issues (`Invalid arguments for tool X: [ { "expected": "string",
 * "code": "invalid_type", ... } ]`) — with one concise, human-readable
 * INVALID_PARAMS message. The SDK derives both the advertised tools/list schema
 * and its validation from the same `tool.inputSchema`, so overriding the
 * validation method leaves every advertised schema (types, enums, required,
 * descriptions) untouched and only changes the error text a client sees on bad
 * arguments.
 *
 * We patch the McpServer *prototype* (reached from a live instance) rather than
 * the instance itself: mcp-use runs a fresh McpServer per HTTP session, so an
 * instance-level patch on the startup server would never be hit. mcp-use also
 * loads its own nested copy of the SDK, so we take the prototype off the actual
 * instance mcp-use handed us instead of importing the class. Guarded so it runs
 * once per class.
 */
/**
 * Turn a single Zod issue into one plain-English sentence, e.g.
 * "number_id is required." or "url must be a valid URL." — instead of Zod's
 * technical phrasing ("Invalid input: expected string, received undefined").
 * `args` is the original arguments, used to tell a missing field from a
 * wrong-typed one.
 */
export function describeValidationIssue(
  issue: {
    code?: string;
    path?: Array<string | number>;
    message?: string;
    [k: string]: any;
  },
  args: unknown,
): string {
  const path = issue.path ?? [];
  const field = path.join(".") || "input";
  const valueAt = (): unknown => {
    let v: any = args;
    for (const k of path) {
      if (v == null) return undefined;
      v = v[k as any];
    }
    return v;
  };
  const typeWord = (t: string): string =>
    ({
      string: "a string (text)",
      number: "a number",
      integer: "a whole number",
      boolean: "true or false",
      array: "a list",
      object: "an object",
    })[t] ?? `a ${t}`;

  switch (issue.code) {
    case "invalid_type":
      return valueAt() === undefined
        ? `${field} is required`
        : `${field} must be ${typeWord(String(issue.expected))}`;
    case "too_small": {
      const unit =
        issue.origin === "string"
          ? " characters"
          : issue.origin === "array"
            ? " items"
            : "";
      // Zod flags exact:true for .length(n) — report the single required value.
      if (issue.exact)
        return `${field} must be exactly ${issue.minimum}${unit}`;
      return `${field} must be ${issue.inclusive === false ? "greater than" : "at least"} ${issue.minimum}${unit}`;
    }
    case "too_big": {
      const unit =
        issue.origin === "string"
          ? " characters"
          : issue.origin === "array"
            ? " items"
            : "";
      if (issue.exact)
        return `${field} must be exactly ${issue.maximum}${unit}`;
      return `${field} must be ${issue.inclusive === false ? "less than" : "at most"} ${issue.maximum}${unit}`;
    }
    case "invalid_format":
      if (issue.format === "url" || issue.format === "uri")
        return `${field} must be a valid URL`;
      if (issue.format === "email")
        return `${field} must be a valid email address`;
      return `${field} has an invalid format`;
    case "invalid_value":
    case "invalid_enum_value": {
      const values = (issue.values ?? issue.options) as unknown[] | undefined;
      return values?.length
        ? `${field} must be one of: ${values.join(", ")}`
        : `${field} has an invalid value`;
    }
    case "unrecognized_keys":
      return `unexpected field(s): ${(issue.keys ?? []).join(", ")}`;
    default:
      // Fall back to Zod's message, but strip its "Invalid input: " prefix.
      return `${field}: ${(issue.message ?? "invalid value").replace(/^Invalid input:\s*/i, "")}`;
  }
}

export function installConciseValidation(nativeServer: unknown): boolean {
  if (!nativeServer) return false;
  const proto = Object.getPrototypeOf(nativeServer) as {
    validateToolInput?: (
      tool: any,
      args: unknown,
      toolName: string,
    ) => Promise<unknown>;
    __agentphoneConciseValidation?: boolean;
  } | null;
  if (!proto) return false;
  if (proto.__agentphoneConciseValidation) return true;
  if (typeof proto.validateToolInput !== "function") {
    console.error(
      "[agentphone] WARNING: the MCP SDK no longer exposes validateToolInput; " +
        "concise validation errors are disabled and clients will see raw Zod errors.",
    );
    return false;
  }
  proto.__agentphoneConciseValidation = true;
  // Keep the SDK's own validateToolInput so its element-count guard
  // (maxToolInputElements) still runs BEFORE schema parsing — the input side of
  // the memory-exhaustion advisory. We only reword the schema-validation message.
  const original = proto.validateToolInput;
  proto.validateToolInput = async function (
    tool: any,
    args: unknown,
    toolName: string,
  ) {
    // Let the SDK run first: it enforces the element cap and parses the schema.
    // A success returns the parsed data unchanged; only a *schema* failure is
    // rephrased below. The element-cap error is left as-is (already concise).
    try {
      return await (original as any).call(this, tool, args, toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The element-cap error mentions the maximum element count; pass it through.
      if (/maximum of \d+ elements/.test(message)) throw err;
      if (!tool?.inputSchema) throw err;
      // Re-derive a concise, per-field message for the schema failure.
      const schemaToParse =
        normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
      const validationArgs = args ?? {};
      const result = (await safeParseAsync(schemaToParse, validationArgs)) as {
        success: boolean;
        error?: {
          issues?: Array<{ path?: Array<string | number>; message?: string }>;
        };
      };
      if (result.success) throw err; // not a schema problem — keep the original
      const issues = result.error?.issues ?? [];
      const summary =
        issues.map((i) => describeValidationIssue(i, validationArgs)).join("; ") ||
        "one or more arguments are invalid";
      // Throw a plain Error, not the SDK's McpError: HTTP sessions run mcp-use's
      // nested SDK copy, whose `instanceof McpError` wouldn't recognize a class
      // imported from the top-level copy. Both copies funnel any thrown Error
      // through the same createToolError path, so a plain Error yields the
      // concise message as an isError result on every transport.
      throw new Error(`Invalid arguments for ${toolName}: ${summary}`);
    }
  };
  return true;
}
