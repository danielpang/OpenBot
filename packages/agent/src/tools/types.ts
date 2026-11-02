import type { Tool, ToolResultPart } from 'ai';
import type { z } from 'zod';
import type { LabelContext } from '../activity/labels.js';
import type { PolicyRun, ToolAnnotations, ToolFacts } from '../policy/index.js';
import type { ArtifactServices } from './artifacts.js';
import type { AttachmentServices } from './attachments.js';
import type { BuiltinServices } from './builtin.js';
import type { ComputerServices } from './computer.js';
import type { ConnectorTools } from './connector.js';

// Tool groups (plan 5.4). Each group is a module under `tools/` exporting a
// `ToolGroup`; `tools/index.ts` lists them. Tools are plain objects so the
// run loop can wrap every `execute` with `gated()` and the server can test a
// tool without a model.

export type MemoryKind = 'preference' | 'fact' | 'summary';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt?: string;
}

/** A Bot's memory (M1), backed by `bot_memories`. */
export interface MemoryStore {
  remember(input: { kind: MemoryKind; content: string }): Promise<MemoryItem>;
  search(query: string, limit: number): Promise<MemoryItem[]>;
}

/** Bot to Bot messages (C6): the server writes into the pair's `bot_to_bot` chat and wakes the receiver. */
export interface BotMessenger {
  /**
   * Throws when the handle names no other Bot of the same owner. `woke` is false
   * when a loop guard kept the receiver asleep.
   */
  send(input: {
    handle: string;
    text: string;
  }): Promise<{ chatId: string; messageId: string; woke: boolean }>;
}

/** Reactions (C8) as the run's Bot: the server stores them and publishes `reaction.added`. */
export interface Reactor {
  /**
   * Reacts to `messageId`, or by default to the latest message in the run's
   * chat (its thread, for a thread run) not written by this Bot. Throws when
   * the message is not in the run's chat.
   */
  react(input: {
    emoji: string;
    messageId?: string;
  }): Promise<{ messageId: string; created: boolean }>;
}

/** A Skill as a Bot loads it (S1): its markdown content. */
export interface LoadedSkill {
  skill_id: string;
  name: string;
  content: string;
  /** `owner/repo` for an imported Skill, whose text someone else wrote (P2). */
  imported_from?: string;
}

/** A Skill `save_skill` drafted and stored in the library (S3). */
export interface DraftedSkill {
  skill_id: string;
  name: string;
  content: string;
}

/** The owner's Skills library as the run's Bot sees it (S2, plan 10.1). */
export interface SkillServices {
  /** An enabled Skill by name or slug; throws when the Bot has none by that name. */
  load(name: string): Promise<LoadedSkill>;
  /** Drafts a Skill from the finished work in this chat with the small model and stores it. */
  draft(input: { name?: string; notes?: string }): Promise<DraftedSkill>;
}

/** A connector whose login is missing or expired (401, expired OAuth): the Bot is blocked after the run. */
export interface LoginNotice {
  connectorId: string;
  connectorName: string;
  message: string;
}

/** What `request_login` asks the server for (K1, K8). */
export interface LoginRequestInput {
  site: string;
  url?: string;
  reason: string;
}

/**
 * Where the sign-in request goes. Without `posted` the run posts the widget
 * in its own transcript; with it, the server already posted it (or joined a
 * pending one for the site) in the main Bot's transcript.
 */
export interface LoginRequestPlan {
  /** The site as a host name. */
  site: string;
  widget: { kind: 'login_request'; props: unknown };
  posted?: { messageId: string; partIndex: number };
}

/** Sign-in requests to the owner (K8): routed to the main Bot when there is one. */
export interface LoginRequests {
  request(input: LoginRequestInput): Promise<LoginRequestPlan>;
}

export interface ToolContext {
  run: PolicyRun;
  memory: MemoryStore;
  /** The run's Artifacts; without them the artifacts group offers no Artifact tools. */
  artifacts?: ArtifactServices;
  /** The chat's attachments; without them `read_attachment` and `attachment_to_computer` are not offered. */
  attachments?: AttachmentServices;
  /** The built-ins' backends; without them the builtin group offers no tools. */
  builtins?: BuiltinServices;
  /** The Bot's permitted MCP tools (`listToolsForBot`) and how to call them. */
  connectors?: ConnectorTools;
  /** The account's computer and the Bot's screen; without it the computer group offers no tools. */
  computer?: ComputerServices;
  /** Messages to the owner's other Bots; without it `message_bot` is not offered. */
  bots?: BotMessenger;
  /** Reactions on the chat's messages; without it `react` is not offered. */
  reactions?: Reactor;
  /** The owner's Skills; without them `use_skill` and `save_skill` are not offered. */
  skills?: SkillServices;
  /** Sign-in requests on the computer; without them `request_login` is not offered. */
  logins?: LoginRequests;
  /** Told when a connector needs its owner to sign in again. */
  needsLogin?(notice: LoginNotice): void;
}

export interface AgentTool<Args = unknown> {
  description: string;
  inputSchema: z.ZodType<Args>;
  /** Read-only and destructive hints for the policy (plan 8), as MCP tools carry them. */
  annotations?: ToolAnnotations;
  /** Connector name and tool title for activity labels ("GitHub: Create issue"). */
  label?: LabelContext;
  /** The connector the tool comes from, for its `approval_override` (plan 8). */
  connector?: ToolFacts['connector'];
  /** Offered only after `search_tools` finds it when the run has many tools (plan 5.4). */
  deferred?: boolean;
  /**
   * What the model gets for a result (screenshots as image parts); absent, or
   * undefined for a result, frames it as data like any other (P2).
   */
  toModelOutput?(output: unknown): ToolResultOutput | undefined;
  /** What the transcript and the activity log keep of a result (a screenshot without its bytes). */
  transcript?(output: unknown): unknown;
  /** The provider's own tool for this one, when the run's model has one (Anthropic computer use). */
  native?(target: ModelTarget): NativeTool | undefined;
  execute(args: Args, ctx: ToolContext): Promise<unknown>;
}

/** A tool result as the model gets it (the AI SDK's `ToolResultOutput`). */
export type ToolResultOutput = ToolResultPart['output'];

/** The run's model, for picking a provider's native tool. */
export interface ModelTarget {
  providerKind: string;
  protocol: string;
  modelId: string;
}

/** A provider-defined tool standing in for an OpenBots tool. */
export interface NativeTool {
  /** Builds the provider's tool around the loop's `execute` and `toModelOutput`. */
  create(options: {
    execute(input: never, options: { toolCallId: string }): Promise<unknown>;
    toModelOutput?(options: { output: unknown }): ToolResultOutput;
  }): Tool;
  /** The OpenBots arguments for a native call; the policy, labels and `execute` see these. */
  toArgs(input: unknown): unknown;
}

export interface ToolGroup {
  name: string;
  tools(ctx: ToolContext): Record<string, AnyAgentTool>;
}

export function defineTool<Args>(tool: AgentTool<Args>): AgentTool<Args> {
  return tool;
}

/** Any tool, whatever its arguments; what groups return and the loop wraps. */
export interface AnyAgentTool {
  description: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  label?: LabelContext;
  connector?: ToolFacts['connector'];
  deferred?: boolean;
  toModelOutput?(output: unknown): ToolResultOutput | undefined;
  transcript?(output: unknown): unknown;
  native?(target: ModelTarget): NativeTool | undefined;
  execute(args: never, ctx: ToolContext): Promise<unknown>;
}

/** A result as the transcript keeps it. */
export function transcriptResult(tool: AnyAgentTool | undefined, output: unknown): unknown {
  return tool?.transcript ? tool.transcript(output) : output;
}
