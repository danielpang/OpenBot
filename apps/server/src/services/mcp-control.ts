// The bus channel that stops MCP sessions in every process (plan 8, T3): a
// worker may run the session a block, an edit or a delete in the API process
// ends, and its stdio server would otherwise live until the idle sweep. Its
// own module so the computer service can say a computer stopped without
// importing the connectors service, which imports it.

export const MCP_CONTROL_CHANNEL = 'openbots:mcp-control';

export type McpControl =
  | { type: 'stop'; connectorIds: string[] }
  /** A computer is stopping: its owner's stdio servers there end with it. */
  | { type: 'computer'; ownerId: string; workspaceId: string };
