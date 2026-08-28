/**
 * AgentPhone MCP Tool Registrations
 *
 * 28 MCP tools with ToolAnnotations, input validation, and actionable errors.
 */
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";
type ToolResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
};
/**
 * Minimal registration surface this module needs. Implemented by an adapter in
 * index.ts that forwards to the mcp-use MCPServer. Keeping the SDK-style
 * (name, description, schema, annotations, handler) signature lets every tool
 * definition below stay unchanged across the transport migration.
 */
export interface ToolRegistrar {
    tool(name: string, description: string, schema: Record<string, z.ZodTypeAny>, annotations: Record<string, unknown>, handler: (args: any) => Promise<ToolResult>): void;
    tool(name: string, description: string, schema: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<ToolResult>): void;
}
export declare function registerTools(server: ToolRegistrar, api: AgentPhoneAPI): void;
export {};
//# sourceMappingURL=tools.d.ts.map