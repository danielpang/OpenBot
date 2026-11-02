import {
  assembleContext,
  attachmentRequests,
  ContextOverflowError,
  describeError,
  executeRun,
  extractMemories,
  IMAGE_TOOLS,
  injectToolResult,
  labelFor,
  namedAttachments,
  resumeFromCheckpoint,
  trimContext,
  runToolCall,
  toModelMessages,
  toolCallMessages,
  toolFacts,
  TOOL_GROUPS,
  toolsFor,
  type AssembledContext,
  type CheckpointCall,
  type Embedder,
  type LabelContext,
  type LoginNotice,
  type MemoryStore,
  type PendingWait,
  type Policy,
  type RunCheckpoint,
  type RunCheckpointer,
  type RunOutcome,
  type RunSink,
  type SerializedRunState,
  type ToolContext,
  type ToolGroup,
  type UsageTotals,
} from '@openbots/agent';
import {
  estimateCost,
  ModelDisabledError,
  ProviderNotFoundError,
  type ResolvedModel,
} from '@openbots/models';
import { isForBot } from '@openbots/router';
import {
  missingCapabilities,
  ModelConfigSchema,
  usesComputer,
  wsEvent,
  type JobHandler,
  type MessagePart,
  type ModelConfig,
} from '@openbots/shared';
import { isApproved, widgetKind, type ApprovalOutcome } from '@openbots/widgets';
import type { LanguageModel, ModelMessage } from 'ai';
import { and, asc, desc, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm';
import {
  connectorToolsFor,
  loadBuiltins,
  settleEmailDraft,
  type BuiltinOptions,
} from '../builtins/index.js';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { observeProviderStep } from '../metrics.js';
import { announceApproval, approvalTtlMs, storeApproval } from '../services/approvals.js';
import { artifactServices } from '../services/artifacts.js';
import { setState } from '../services/bot-state.js';
import { ownerActive } from '../membership.js';
import { canUseProvider } from '../services/bots.js';
import {
  chatBots,
  chatHandles,
  threadBotId,
  transcriptMessage,
  type ChatHandles,
} from '../services/chats.js';
import { computerAvailable, computerServices } from '../services/computer.js';
import { attachmentServices, loadContextAttachments } from '../services/files.js';
import {
  loginExpiresAt,
  loginRequests,
  resumeIfAnswered,
  scheduleLoginExpiry,
} from '../services/logins.js';
import {
  contextMemories,
  embedderForBot,
  saveMemory,
  searchMemories,
  toMemoryItem,
} from '../services/memories.js';
import {
  announceMessage,
  appendPart,
  botReactor,
  createStreaming,
  finalize,
  postMessage,
  storeMessage,
} from '../services/messages.js';
import { loadRunPolicy } from '../services/policy.js';
import { routineInstructions } from '../services/routines.js';
import { smallModelFor, providerRegistry } from '../services/providers.js';
import { botMessenger, routeBotReply, type RouterOptions } from '../services/router.js';
import { referencedSkills, skillIndex, skillServices } from '../services/skills.js';
import {
  completeRun,
  publishRunStatus,
  RUN_CONTROL_CHANNEL,
  type RunControl,
  type RunJob,
  type RunRow,
  type RunStepRow,
  toRunStep,
  type RunState,
  runThread,
  ACTIVE_STATUSES,
  scheduleRun,
} from '../services/runs.js';
import { updateChatSummary } from '../services/summaries.js';

// The run worker (plan 5.5 to 5.9). One job runs one run from `queued` to
// `completed`, `waiting`, `failed` or `cancelled`:
//
// 1. Claim the run (queued -> running). A job whose run is no longer queued
//    (cancelled while queued) is dropped; one whose run is still `running`
//    was interrupted by a crash, and is taken over (K4): it continues from
//    the loop's last checkpoint, or starts again if it had none, and fails
//    after MAX_TAKEOVERS.
// 2. Resolve the Bot's model and check it can call tools (5.9); if not, the
//    run fails with a `blocked` event row carrying the fix.
// 3. Assemble the context (5.3; a thread run reads its thread in full, C7),
//    or rehydrate `runs.state` with the owner's
//    answer injected when resuming (5.6). An approved call runs here, once,
//    before its result is injected; replies in the waiting widget's thread
//    follow it as context (C7). A widget action that asks for a tool call
//    (email Send) makes it here, through the policy.
// 4. Stream the loop into a new Bot message (5.5; in the run's thread, if
//    any), with Bot state thinking, working while a tool runs, then done,
//    waiting, idle or blocked.
// 5. Record usage and cost (5.8); route the reply in a group or Bot-to-Bot
//    chat (plan 7); after a completed run, extract memories and roll the
//    chat summary forward (services/summaries.ts).

type BotRow = typeof schema.bots.$inferSelect;
type ChatRow = typeof schema.chats.$inferSelect;

/** Messages in the context window (plan 5.3 item 6); halved once on overflow (5.7). */
export const HISTORY_WINDOW = 40;
/** Messages the post-run extraction reads. */
const EXTRACTION_WINDOW = 12;

export type RunModel = Pick<ResolvedModel, 'model' | 'info' | 'providerOptions'> &
  Partial<Pick<ResolvedModel, 'toolNames' | 'provider'>>;

export interface RunWorkerOptions {
  /** The Bot's model; defaults to the provider registry. Tests pass a recorded double. */
  resolveModel?: (config: ModelConfig, bot: BotRow) => Promise<RunModel>;
  /** The small model for memory extraction; defaults to the provider's (plan 5.9). */
  smallModel?: (config: ModelConfig, bot: BotRow) => Promise<LanguageModel | null>;
  embedder?: Embedder;
  /** Replaces the policy engine (`loadRunPolicy`) for every run. */
  policy?: Policy;
  /** The tool groups offered; defaults to `TOOL_GROUPS`. */
  toolGroups?: ToolGroup[];
  /** Built-in backends' seams: network guard, search, GitHub and IMAP endpoints. */
  builtins?: BuiltinOptions;
  historyWindow?: number;
  /** How long a screen action waits for the owner to hand a taken-over screen back. */
  takeoverWaitMs?: number;
  /** The router's seams (`shouldReply` model) for routing replies and `message_bot`. */
  router?: RouterOptions;
  /** Messages beyond the window that trigger a summary pass (`SUMMARY_BATCH`). */
  summaryBatch?: number;
}

export interface RunUsage extends UsageTotals {
  /** US dollars from `provider_models.pricing`; null when the model has no pricing. */
  costUsd: number | null;
}

/** The `runs` queue handler; `startWorkers` registers one per process. */
export function createRunWorker(deps: AppDeps, options: RunWorkerOptions = {}): JobHandler<RunJob> {
  const running = new Map<string, AbortController>();
  let subscribed: Promise<unknown> | null = null;
  const listen = () =>
    (subscribed ??= deps.infra.bus.subscribe<RunControl>(RUN_CONTROL_CHANNEL, (control) => {
      if (control.type === 'cancel') running.get(control.runId)?.abort();
    }));
  return async (job) => {
    await listen();
    await processRun(deps, options, job.data.runId, running);
  };
}

async function processRun(
  deps: AppDeps,
  options: RunWorkerOptions,
  runId: string,
  running: Map<string, AbortController>,
) {
  const [existing] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!existing) return;
  const [run] =
    existing.status === 'running'
      ? await takeOver(deps, existing)
      : await deps.db
          .update(schema.runs)
          .set({ status: 'running', startedAt: existing.startedAt ?? new Date() })
          .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'queued')))
          .returning();
  if (!run) return;
  await publishRunStatus(deps, run);

  const controller = new AbortController();
  running.set(run.id, controller);
  let messageId: string | null = null;
  // Set when another worker took the run over (K4): this one stops and leaves the run alone.
  let lost = false;
  /** How many leading messages of the loop came from the transcript (`trimContext`). */
  let contextLength: number | undefined;
  try {
    const [bot] = await deps.db.select().from(schema.bots).where(eq(schema.bots.id, run.botId));
    const [chat] = run.chatId
      ? await deps.db.select().from(schema.chats).where(eq(schema.chats.id, run.chatId))
      : [];
    if (!bot || !chat) throw new Error('The run has no Bot or chat');
    // Suspended or removed: the owner's Bots do no work in the organization (plan 21.6).
    if (!(await ownerActive(deps.db, bot))) {
      await blockRun(
        deps,
        run,
        `@${bot.handle}'s owner has no access to this organization now.`,
        'An admin can restore them.',
      );
      return;
    }

    const checked = await resolveRunModel(deps, options, bot);
    if (!checked.ok) {
      await blockRun(deps, run, checked.text, checked.fix);
      return;
    }
    const { config, resolved } = checked;
    await setState(deps, bot.id, 'thinking', { runId: run.id });
    // Unknown counts as able, as for the screenshot tools (L4).
    const vision = resolved.info?.capabilities.vision !== false;

    const embedder = options.embedder ?? (await embedderForBot(deps, bot.id));
    const state = run.state as RunState | null;
    // A run taken over after a crash continues from its checkpoint (K4).
    const continued = state?.checkpoint ?? null;
    const resuming = !continued && state?.pending && state.resume && state.messages ? state : null;
    let window = options.historyWindow ?? HISTORY_WINDOW;
    let context = await buildContext(deps, run, bot, chat, embedder, window, vision);

    // A thread run replies in the thread (C7).
    const thread = runThread(run);
    const message = await createStreaming(deps, {
      chatId: chat.id,
      botId: bot.id,
      runId: run.id,
      threadRootId: thread,
    });
    messageId = message.id;
    const sink = streamSink(deps, message.id);
    const steps = await stepRecorder(deps, run);
    if (continued) await steps.record({ type: 'error', label: RESTART_NOTE });
    const carried = continued?.usage ?? NO_USAGE;
    const checkpoint = runCheckpointer(deps, run, {
      messageId: message.id,
      carried,
      seenSeq: () => seenSeq,
      contextLength: () => contextLength,
      onCancel: () => controller.abort(),
      onLost: () => {
        lost = true;
        controller.abort();
      },
    });
    const memory = memoryStore(deps, run, embedder);
    const loginNotices: LoginNotice[] = [];
    const toolContext: ToolContext = {
      run: { id: run.id, botId: bot.id, chatId: chat.id, trigger: run.trigger },
      memory,
      bots: botMessenger(deps, run, bot, options.router),
      reactions: botReactor(deps, { chatId: chat.id, threadRootId: thread }, bot),
      skills: skillServices(deps, {
        run,
        bot,
        smallModel: () =>
          options.smallModel ? options.smallModel(config, bot) : defaultSmallModel(deps, config),
      }),
      artifacts: artifactServices(deps, { id: run.id, chatId: chat.id }, bot),
      attachments: attachmentServices(deps, chat, vision),
      builtins: await loadBuiltins(deps, bot, options.builtins),
      connectors: await connectorToolsFor(deps, bot.id, controller.signal),
      ...(computerAvailable(deps)
        ? {
            computer: computerServices(deps, {
              bot,
              runId: run.id,
              signal: controller.signal,
              recordStep: steps.record,
              onComputerStarted: (durationMs, updated) =>
                postComputerStarted(deps, run, durationMs, updated),
              ...(options.takeoverWaitMs !== undefined
                ? { takeoverWaitMs: options.takeoverWaitMs, takeoverPollMs: 20 }
                : {}),
            }),
            logins: loginRequests(deps, run, bot),
          }
        : {}),
      needsLogin: (notice) => {
        if (!loginNotices.some((n) => n.connectorId === notice.connectorId)) {
          loginNotices.push(notice);
        }
      },
    };
    const groups = options.toolGroups ?? TOOL_GROUPS;
    const facts = toolFacts(toolContext, groups);
    // A model without vision cannot read screenshots (L4): rather than block
    // the run, it goes without the image tools, and the log says so.
    const blind =
      resolved.info?.capabilities.vision === false &&
      usesComputer(
        bot.toolPolicy,
        IMAGE_TOOLS.some((name) => facts.has(name)),
      );
    const tools = toolsFor(toolContext, groups, blind ? IMAGE_TOOLS : []);
    if (blind && !resuming && !continued) {
      await steps.record({ type: 'error', label: NO_VISION_NOTE });
    }
    const policy = options.policy ?? (await loadRunPolicy(deps, run, bot, facts));
    const toolNames = resolved.toolNames?.(Object.keys(tools));
    const labelsOf = (name: string) => tools[name]?.label;
    const startInput = state?.input;
    /** The send an email draft asked for (W2) settles the draft widget. */
    const forcedCallId = `call_${run.id.replaceAll('-', '')}`;
    const settleDraft = async (
      toolCallId: string,
      toolName: string,
      output: unknown,
      denied = false,
    ) => {
      const widget = startInput?.widgetAction;
      if (
        toolCallId !== forcedCallId ||
        toolName !== 'send_email' ||
        widget?.kind !== 'email_draft'
      ) {
        return;
      }
      const failed = !output || typeof output !== 'object' || 'error' in output;
      await settleEmailDraft(deps, widget, { sent: !denied && !failed, denied });
    };
    // Tool calls of one step run in parallel; their state writes go one after
    // another in the order they were made, so the published events and the
    // stored row agree on which came last.
    let stateWrites: Promise<unknown> = Promise.resolve();
    const setRunState = (
      s: 'thinking' | 'working',
      currentAction: string | null,
      currentTool: string | null = null,
    ) => {
      const write = stateWrites.then(() =>
        setState(deps, bot.id, s, { runId: run.id, currentAction, currentTool }),
      );
      stateWrites = write.catch(() => {});
      return write.then(() => {});
    };
    const target = resolved.provider
      ? {
          providerKind: resolved.provider.kind,
          protocol: resolved.provider.protocol,
          modelId: config.model_id,
        }
      : undefined;
    /**
     * Makes a call outside the loop. `messages` carry it with a placeholder
     * result; they are checkpointed just before the tool runs (K4).
     */
    const callOutside = (
      call: { toolCallId: string; toolName: string; args: unknown },
      gate: boolean,
      messages: ModelMessage[],
    ) =>
      runToolCall({
        run: toolContext.run,
        call,
        tools,
        toolContext,
        policy: gate ? policy : null,
        announce: gate,
        sink,
        setState: async (s, action, tool) => {
          if (s === 'working') {
            await checkpoint.outside(messages, {
              toolCallId: call.toolCallId,
              toolName: toolNames?.toProvider(call.toolName) ?? call.toolName,
              input: call.args,
            });
          }
          await setRunState(s, action, tool);
        },
        recordStep: steps.record,
      });
    /** Pauses again before the model runs (an approval asked for outside the loop). */
    const pauseEarly = async (wait: PendingWait, waitMessages: ModelMessage[]) => {
      await finalize(deps, message.id, {});
      messageId = null;
      const outcome = { status: 'waiting' as const, usage: NO_USAGE, wait, messages: waitMessages };
      const usage = addUsage(run.usage as RunUsage | null, NO_USAGE, resolved.info?.pricing);
      await pauseRun(
        deps,
        run,
        message.id,
        outcome,
        seenSeq,
        contextLength,
        { usage, model: config.model_id },
        steps,
        labelsOf(wait.toolName),
      );
    };

    let messages: ModelMessage[];
    let seenSeq: number;
    // Calls made before the loop, kept across a context-overflow rebuild.
    const madeCalls: ModelMessage[] = [];
    if (continued) {
      seenSeq = continued.seenSeq;
      contextLength = continued.contextLength;
      messages = resumeFromCheckpoint(continued);
    } else if (resuming) {
      const pending = resuming.pending!;
      seenSeq = resuming.seenSeq!;
      contextLength = resuming.contextLength;
      let output = resuming.resume!.output;
      const extra = await resumeContext(deps, bot, chat, pending, output, vision);
      if (pending.reason === 'approval') {
        await steps.record({
          type: 'approval',
          label: `${decisionLabel(output)}: ${labelFor(pending.toolName, pending.args, undefined, labelsOf(pending.toolName))}`,
          payload: { toolCallId: pending.toolCallId, toolName: pending.toolName, decision: output },
        });
        if (!isApproved(output)) {
          await settleDraft(pending.toolCallId, pending.toolName, output, true);
        } else {
          // The gate threw before the tool ran; run it now, exactly once (this
          // run was claimed queued -> running, and is never re-run).
          const call = await callOutside(pending, false, [...resuming.messages!, ...extra]);
          if (call.status === 'waiting') {
            await pauseEarly({ ...call.wait, toolCallId: pending.toolCallId }, resuming.messages!);
            return;
          }
          output = call.output;
          await settleDraft(pending.toolCallId, pending.toolName, output);
        }
      }
      messages = [
        ...injectToolResult(
          resuming.messages!,
          pending.toolCallId,
          output,
          tools[pending.toolName]?.toModelOutput,
        ),
        ...extra,
      ];
    } else {
      seenSeq = context.seenSeq;
      contextLength = context.messages.length;
      const asked = startInput?.toolCall;
      if (asked && tools[asked.toolName]) {
        const call = { toolCallId: forcedCallId, ...asked };
        const providerName = toolNames?.toProvider(call.toolName) ?? call.toolName;
        const placeholder = [...context.messages, ...toolCallMessages(call, providerName)];
        const made = await callOutside(call, true, placeholder);
        if (made.status === 'waiting') {
          await pauseEarly(made.wait, placeholder);
          return;
        }
        await settleDraft(call.toolCallId, call.toolName, made.output);
        madeCalls.push(
          ...toolCallMessages(call, providerName, made.output, tools[call.toolName]?.toModelOutput),
        );
      }
      messages = [...context.messages, ...madeCalls];
    }

    let outcome: RunOutcome;
    for (let attempt = 0; ; attempt++) {
      try {
        outcome = await executeRun({
          run: toolContext.run,
          model: resolved.model,
          providerOptions: resolved.providerOptions,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          maxSteps: config.max_steps,
          instructions: context.instructions,
          messages,
          tools,
          toolContext,
          policy,
          ...(toolNames ? { toolNames } : {}),
          ...(target ? { target } : {}),
          abortSignal: controller.signal,
          sink,
          setState: setRunState,
          recordStep: (step) => {
            if (step.type === 'llm' && step.durationMs != null) {
              observeProviderStep(
                resolved.provider?.slug ?? 'unknown',
                config.model_id,
                step.durationMs,
              );
            }
            return steps.record(step);
          },
          drainSteering: async () => {
            if (await cancelledInDb(deps, run.id)) controller.abort();
            const drained = await drainSteering(deps, bot, chat, thread, seenSeq, vision);
            seenSeq = drained.seenSeq;
            return drained.texts;
          },
          checkpoint,
        });
        break;
      } catch (error) {
        if (!(error instanceof ContextOverflowError) || attempt > 0) throw error;
        if (resuming || continued) {
          // The run's own steps stay; only the transcript before them is cut (plan 5.7).
          const trimmed = contextLength ? trimContext(messages, contextLength) : null;
          if (!trimmed) throw error;
          await steps.record({
            type: 'error',
            label: `Context too long; retrying without the oldest ${contextLength! - trimmed.contextLength} messages`,
          });
          messages = trimmed.messages;
          contextLength = trimmed.contextLength;
          continue;
        }
        window = Math.max(2, Math.floor(window / 2));
        await steps.record({
          type: 'error',
          label: `Context too long; retrying with the last ${window} messages`,
        });
        context = await buildContext(deps, run, bot, chat, embedder, window, vision);
        messages = [...context.messages, ...madeCalls];
        contextLength = context.messages.length;
        seenSeq = context.seenSeq;
      }
    }

    await checkpoint.flushed();
    if (lost) {
      await stopLostRun(deps, run, messageId);
      return;
    }
    const usage = addUsage(
      run.usage as RunUsage | null,
      sumUsage(carried, outcome.usage),
      resolved.info?.pricing,
    );
    const model = config.model_id;
    const tokens = {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    };

    if (outcome.status === 'waiting') {
      await finalize(deps, message.id, { usage: tokens });
      messageId = null;
      // Event rows go in before the status changes, so a reader of a waiting
      // or completed run finds them.
      await postLoginNotices(deps, run, loginNotices);
      await pauseRun(
        deps,
        run,
        message.id,
        outcome,
        seenSeq,
        contextLength,
        { usage, model },
        steps,
        labelsOf(outcome.wait.toolName),
      );
      await routeReply(deps, options, message.id);
      return;
    }
    if (outcome.status === 'cancelled') {
      await finalize(deps, message.id, { usage: tokens });
      messageId = null;
      const [row] = await deps.db
        .update(schema.runs)
        .set({ status: 'cancelled', usage, model, state: null, finishedAt: new Date() })
        .where(eq(schema.runs.id, run.id))
        .returning();
      await publishRunStatus(deps, row!);
      await setState(deps, bot.id, 'idle', { runId: run.id });
      return;
    }
    await finalize(deps, message.id, { usage: tokens });
    messageId = null;
    await postLoginNotices(deps, run, loginNotices);
    const { run: done } = await completeRun(deps, run.id, { usage, model }, seenSeq);
    if (!done) {
      // Cancelled in the last moments; the reply stays, the roster goes idle.
      await setState(deps, bot.id, 'idle', { runId: run.id });
      return;
    }
    if (loginNotices.length) {
      await setState(deps, bot.id, 'blocked', {
        runId: run.id,
        currentAction: `${loginNotices[0]!.connectorName} needs login`,
      });
    } else {
      await setState(deps, bot.id, 'done', { runId: run.id });
    }
    await routeReply(deps, options, message.id);
    await afterRun(deps, options, done, bot, config, embedder);
  } catch (error) {
    if (lost) {
      await stopLostRun(deps, run, messageId, error);
      return;
    }
    await failRun(deps, run, messageId, error);
  } finally {
    running.delete(run.id);
  }
}

// Mid-run recovery (K4)

/** Times a crashed run is taken over before it fails, so a run that crashes its worker stops. */
export const MAX_TAKEOVERS = 2;

/** The activity note on a run a worker took over after a crash. */
export const RESTART_NOTE = 'The server restarted; continued from the last step';

const INTERRUPTED = 'The run was interrupted by a server restart';

/** The run's checkpoint is the given takeover's to write. */
const ownedBy = (takeovers: number) =>
  sql`coalesce((${schema.runs.state} ->> 'takeovers')::int, 0) = ${takeovers}`;

/**
 * Claims a run whose worker died mid-run (its job was delivered again). The
 * claim bumps `takeovers`, so the old worker, if it was only stalled, finds
 * the run is no longer its own and stops. What the old worker streamed stays
 * in its message; the run continues in a new one.
 */
async function takeOver(deps: AppDeps, existing: RunRow): Promise<RunRow[]> {
  const state = (existing.state as RunState | null) ?? {};
  const takeovers = state.takeovers ?? 0;
  if (takeovers >= MAX_TAKEOVERS) {
    await failRun(deps, existing, null, new Error(INTERRUPTED));
    return [];
  }
  const claimed = await deps.db
    .update(schema.runs)
    .set({ state: { ...state, takeovers: takeovers + 1 } })
    .where(
      and(eq(schema.runs.id, existing.id), eq(schema.runs.status, 'running'), ownedBy(takeovers)),
    )
    .returning();
  if (!claimed.length) return [];
  const open = await deps.db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.runId, existing.id), eq(schema.messages.status, 'streaming')));
  for (const m of open) await finalize(deps, m.id, {});
  return claimed;
}

/** A worker whose run another worker took over leaves it alone, closing only its own message. */
async function stopLostRun(deps: AppDeps, run: RunRow, messageId: string | null, error?: unknown) {
  deps.logger.warn({ err: error, runId: run.id }, 'run taken over by another worker; stopping');
  // The takeover may have closed it already.
  if (messageId) await finalize(deps, messageId, {}).catch(() => {});
}

interface CheckpointWriter extends RunCheckpointer {
  /** A call made outside the loop, whose placeholder result is in `messages` already. */
  outside(
    messages: ModelMessage[],
    call: Omit<CheckpointCall, 'output' | 'inMessages'>,
  ): Promise<void>;
  /** Resolves once every write so far is done. */
  flushed(): Promise<void>;
}

/**
 * Writes the loop's checkpoint into `runs.state` (K4), one write at a time
 * in the order they were asked for. A write that finds the run cancelled
 * calls `onCancel`; one that finds it taken over by another worker (or
 * already finished by one) calls `onLost`. Either way nothing more is written.
 */
function runCheckpointer(
  deps: AppDeps,
  run: RunRow,
  options: {
    messageId: string;
    /** Usage from before the takeover. */
    carried: UsageTotals;
    seenSeq: () => number;
    contextLength: () => number | undefined;
    onCancel: () => void;
    onLost: () => void;
  },
): CheckpointWriter {
  const state = (run.state as RunState | null) ?? {};
  const takeovers = state.takeovers ?? 0;
  // Once the loop checkpoints, the waiting state the run resumed from is spent.
  const base: RunState = {
    ...(state.input ? { input: state.input } : {}),
    ...(takeovers ? { takeovers } : {}),
  };
  let current: RunCheckpoint | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  const write = () => {
    const next = chain.then(async () => {
      if (stopped || !current) return;
      const [row] = await deps.db
        .update(schema.runs)
        .set({ state: { ...base, checkpoint: current } })
        .where(
          and(eq(schema.runs.id, run.id), eq(schema.runs.status, 'running'), ownedBy(takeovers)),
        )
        .returning({ id: schema.runs.id });
      if (row) return;
      stopped = true;
      // Cancelling leaves the state as it is; anything else is another worker's doing.
      const [now] = await deps.db
        .select({ status: schema.runs.status, state: schema.runs.state })
        .from(schema.runs)
        .where(eq(schema.runs.id, run.id));
      const owner = (now?.state as RunState | null)?.takeovers ?? 0;
      if (now?.status === 'cancelled' && owner === takeovers) options.onCancel();
      else options.onLost();
    });
    chain = next.catch(() => {});
    return next;
  };
  const begin = (messages: ModelMessage[], calls: CheckpointCall[], usage: UsageTotals) => {
    current = {
      messageId: options.messageId,
      messages,
      calls,
      seenSeq: options.seenSeq(),
      usage: sumUsage(options.carried, usage),
    };
    const contextLength = options.contextLength();
    if (contextLength !== undefined) current.contextLength = contextLength;
    return write();
  };
  return {
    step: (messages, usage) => begin(messages, [], usage),
    started: (call) => {
      current?.calls.push(call);
      return write();
    },
    finished: (toolCallId, output) => {
      const call = current?.calls.find((c) => c.toolCallId === toolCallId);
      if (call) call.output = output;
      return write();
    },
    outside: (messages, call) => begin(messages, [{ ...call, inMessages: true }], NO_USAGE),
    flushed: () => chain,
  };
}

function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    steps: a.steps + b.steps,
  };
}

// Model resolution and the capability check (plan 5.9)

/** The activity note for a run whose model cannot see the screen (L4). */
export const NO_VISION_NOTE =
  "This model can't see images, so the screenshot tools are off for this run";

type ModelCheck =
  { ok: true; config: ModelConfig; resolved: RunModel } | { ok: false; text: string; fix: string };

async function resolveRunModel(
  deps: AppDeps,
  options: RunWorkerOptions,
  bot: BotRow,
): Promise<ModelCheck> {
  const parsed = ModelConfigSchema.safeParse(bot.modelConfig);
  if (!parsed.success) {
    return {
      ok: false,
      text: `@${bot.handle} has no model yet.`,
      fix: "Pick a model in the Bot's settings.",
    };
  }
  const config = parsed.data;
  // Only a provider of the Bot's organization, the organization's or its
  // owner's own (plan 21.4), even if a row says otherwise.
  if (
    !options.resolveModel &&
    !(await canUseProvider(
      deps.db,
      { id: bot.ownerId, workspaceId: bot.workspaceId },
      config.provider_id,
    ))
  ) {
    return {
      ok: false,
      text: `The model provider for @${bot.handle} no longer exists.`,
      fix: "Pick another model in the Bot's settings.",
    };
  }
  let resolved: RunModel;
  try {
    resolved = options.resolveModel
      ? await options.resolveModel(config, bot)
      : await providerRegistry(deps).resolve(config);
  } catch (error) {
    if (error instanceof ProviderNotFoundError) {
      return {
        ok: false,
        text: `The model provider for @${bot.handle} no longer exists.`,
        fix: "Pick another model in the Bot's settings.",
      };
    }
    if (error instanceof ModelDisabledError) {
      return {
        ok: false,
        text: `${config.model_id} is turned off for its provider.`,
        fix: "Turn it back on in Settings > Models, or pick another model in the Bot's settings.",
      };
    }
    throw error;
  }
  if (resolved.info && missingCapabilities(resolved.info.capabilities, ['tools']).length) {
    return {
      ok: false,
      text: `${config.model_id} does not support tool calling, which every Bot needs.`,
      fix: "Pick a model with tool calling in the Bot's settings, or re-test the provider in Settings > Models.",
    };
  }
  return { ok: true, config, resolved };
}

// Context (plan 5.3)

interface RunContext extends AssembledContext {
  /** The last transcript seq included; owner messages after it steer the run. */
  seenSeq: number;
}

async function buildContext(
  deps: AppDeps,
  run: RunRow,
  bot: BotRow,
  chat: ChatRow,
  embedder: Embedder,
  window: number,
  vision: boolean,
): Promise<RunContext> {
  const [owner] = await deps.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, chat.ownerId));
  // A thread run reads the root and every reply in full (C7); otherwise the
  // last `window` top-level messages.
  const thread = runThread(run);
  const rows = thread
    ? await deps.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.chatId, chat.id), inThread(thread)))
        .orderBy(asc(schema.messages.seq))
    : (
        await deps.db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.chatId, chat.id), isNull(schema.messages.threadRootId)))
          .orderBy(desc(schema.messages.seq))
          .limit(window)
      ).reverse();
  // In a group or Bot-to-Bot chat the roster lists every Bot, one line each (plan 5.3).
  const members = chat.type === 'bot_dm' ? [bot] : await chatBots(deps.db, chat);
  const handles = await chatHandles(deps.db, chat, [
    ...members.map((m) => m.id),
    ...rows.map((r) => r.authorId),
  ]);
  const ownerHandle = handles.owner;
  const transcript = rows.map((row) => transcriptMessage(row, bot, handles));
  // The attachments the model can use, newest first within a budget (C1, C9).
  const wanted = attachmentRequests(transcript, { vision });
  const loaded = wanted.length ? await loadContextAttachments(deps, chat, wanted) : new Map();
  const recentText = rows
    .filter((r) => r.authorType === 'user')
    .slice(-3)
    .flatMap((r) => (r.parts as MessagePart[]).filter((p) => p.type === 'text').map((p) => p.text))
    .join('\n');
  const memories = await contextMemories(deps, bot.id, recentText, embedder);
  // A Skill referenced with `/` since the Bot last spoke is loaded in full for this turn
  // (plan 10.1) when this Bot has it enabled and ready (S2).
  const lastOwn = rows.findLastIndex((r) => r.authorType === 'bot' && r.authorId === bot.id);
  const referenced = await referencedSkills(
    deps.db,
    bot.id,
    rows.slice(lastOwn + 1).flatMap((r) => r.parts as MessagePart[]),
  );
  const context = assembleContext({
    bot: { name: bot.name, handle: bot.handle, label: bot.label, description: bot.description },
    roster: [
      ...(chat.type === 'bot_to_bot'
        ? []
        : [{ handle: ownerHandle, name: owner?.name ?? 'Owner', kind: 'owner' as const }]),
      ...members.map((m) => ({
        handle: m.handle,
        name: m.name,
        kind: 'bot' as const,
        label: m.label,
        ...(m.id === bot.id ? { self: true } : {}),
      })),
    ],
    skills: await skillIndex(deps.db, bot.id),
    ...(referenced.length ? { referencedSkills: referenced } : {}),
    memories,
    summary: chat.summary,
    messages: transcript,
    ...(thread ? { thread: true } : {}),
    attachments: { vision, loaded },
  });
  const input = (run.state as RunState | null)?.input;
  if (input?.widgetAction) {
    const { kind, action } = input.widgetAction;
    context.messages.push({
      role: 'user',
      content: `[@${ownerHandle} (owner)] [acted on your ${kind} widget: ${JSON.stringify(action)}]`,
    });
  }
  // A Routine run is told what to do (plan 10.2); the owner is not waiting.
  const routine = input?.routine
    ? await routineInstructions(deps.db, input.routine.routineId)
    : null;
  if (routine) context.messages.push({ role: 'user', content: routine });
  if (!context.messages.length) {
    context.messages.push({ role: 'user', content: `[system] Run started by ${run.trigger}.` });
  }
  return { ...context, seenSeq: rows.at(-1)?.seq ?? chat.chatSeq };
}

/** A thread's root and its replies. */
const inThread = (thread: string) =>
  or(eq(schema.messages.threadRootId, thread), eq(schema.messages.id, thread));

/**
 * Owner messages past `seenSeq` in the run's thread or top level,
 * author-prefixed (plan 5.2). In a group only those for this Bot steer it
 * (`isForBot`, the routing rule; C5); the watermark passes the rest. Their
 * attachments are named, for `read_attachment`.
 */
async function drainSteering(
  deps: AppDeps,
  bot: BotRow,
  chat: ChatRow,
  thread: string | null,
  seenSeq: number,
  vision: boolean,
) {
  const rows = await deps.db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chatId, chat.id),
        eq(schema.messages.authorType, 'user'),
        thread ? eq(schema.messages.threadRootId, thread) : isNull(schema.messages.threadRootId),
        gt(schema.messages.seq, seenSeq),
      ),
    )
    .orderBy(asc(schema.messages.seq));
  if (!rows.length) return { texts: [], seenSeq };
  const threadBot = chat.type === 'group' ? await threadBotId(deps.db, chat, thread) : null;
  const mine = rows.filter((r) => chat.type !== 'group' || isForBot(bot.id, r, threadBot));
  const handles = await chatHandles(deps.db, chat);
  const texts = toModelMessages(
    mine.map((r) => transcriptMessage(r, bot, handles)),
    namedAttachments(vision),
  ).map((m) => (typeof m.content === 'string' ? m.content : ''));
  return { texts: texts.filter(Boolean), seenSeq: rows.at(-1)!.seq };
}

async function cancelledInDb(deps: AppDeps, runId: string) {
  const [row] = await deps.db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  return row?.status === 'cancelled';
}

// Streaming, steps, memory

/** The loop's parts to the 1.4 streaming primitives, tracking part indexes like `appendPart`. */
function streamSink(deps: AppDeps, messageId: string): RunSink {
  let count = 0;
  let open: 'text' | 'reasoning' | null = null;
  const delta = async (type: 'text' | 'reasoning', text: string) => {
    if (open !== type) {
      open = type;
      count += 1;
    }
    await appendPart(deps, messageId, { type: `${type}_delta`, text });
  };
  return {
    text: (t) => delta('text', t),
    reasoning: (t) => delta('reasoning', t),
    part: async (part) => {
      open = null;
      await appendPart(deps, messageId, part);
      return count++;
    },
  };
}

type StepRecorder = Awaited<ReturnType<typeof stepRecorder>>;
type StepInput = {
  type: (typeof schema.runStepType.enumValues)[number];
  label: string;
  payload?: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
};

async function stepRecorder(deps: AppDeps, run: RunRow) {
  const [last] = await deps.db
    .select({ idx: max(schema.runSteps.idx) })
    .from(schema.runSteps)
    .where(eq(schema.runSteps.runId, run.id));
  let idx = (last?.idx ?? -1) + 1;
  // `store` writes a step inside the caller's transaction and `announce`
  // publishes it after the commit; `record` does both.
  const store = async (db: Db, step: StepInput) => {
    const [row] = await db
      .insert(schema.runSteps)
      .values({
        workspaceId: run.workspaceId,
        runId: run.id,
        idx: idx++,
        type: step.type,
        label: step.label,
        payload: step.payload ?? null,
        tokensIn: step.tokensIn ?? null,
        tokensOut: step.tokensOut ?? null,
        durationMs: step.durationMs ?? null,
      })
      .returning();
    return row!;
  };
  const announce = (row: RunStepRow) =>
    publishEvent(
      deps.infra.bus,
      wsEvent(
        'run.step',
        { step: toRunStep(row) },
        {
          bot_id: run.botId,
          ...(run.chatId ? { chat_id: run.chatId } : {}),
        },
      ),
    );
  return {
    store,
    announce,
    record: async (step: StepInput) => announce(await store(deps.db, step)),
  };
}

function memoryStore(deps: AppDeps, run: RunRow, embedder: Embedder): MemoryStore {
  return {
    remember: async ({ kind, content }) =>
      toMemoryItem(
        await saveMemory(
          deps,
          { botId: run.botId, workspaceId: run.workspaceId, kind, content, sourceRunId: run.id },
          embedder,
        ),
      ),
    search: async (query, limit) =>
      (await searchMemories(deps, run.botId, query, limit, embedder)).map(toMemoryItem),
  };
}

function addUsage(
  previous: RunUsage | null,
  usage: UsageTotals,
  pricing: Parameters<typeof estimateCost>[1],
): RunUsage {
  const total = {
    inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    steps: (previous?.steps ?? 0) + usage.steps,
  };
  return { ...total, costUsd: estimateCost(total, pricing) };
}

// Outcomes

/** Waiting (plan 5.6): widget state with the pending run, messages into `runs.state`. */
async function pauseRun(
  deps: AppDeps,
  run: RunRow,
  messageId: string,
  outcome: Extract<RunOutcome, { status: 'waiting' }>,
  seenSeq: number,
  /** How many leading messages came from the transcript (`trimContext`). */
  contextLength: number | undefined,
  patch: { usage: RunUsage; model: string },
  steps: StepRecorder,
  labels?: LabelContext,
) {
  const { wait } = outcome;
  // A sign-in request the main Bot posted lists this run in its own state (K8).
  const { posted } = wait;
  if (posted) messageId = posted.messageId;
  const partIndex = posted?.partIndex ?? wait.partIndex ?? 0;
  // A sign-in request in this Bot's own transcript expires like an approval (plan 9.7).
  const expiresAt = !posted && wait.widget.kind === 'login_request' ? loginExpiresAt(deps) : null;
  const initial = {
    ...(widgetKind(wait.widget.kind)?.initialState?.(wait.widget.props) ?? {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
  if (!posted) {
    await deps.db
      .insert(schema.widgetStates)
      .values({
        workspaceId: run.workspaceId,
        messageId,
        partIndex,
        state: initial as object,
        pendingRunId: run.id,
      })
      .onConflictDoUpdate({
        target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
        set: { pendingRunId: run.id, updatedAt: new Date() },
      });
  }
  // The start input stays, so a resumed run still knows the widget that started it.
  const input = (run.state as RunState | null)?.input;
  const state: SerializedRunState & RunState = {
    version: 1,
    messages: outcome.messages,
    pending: { ...wait, messageId, partIndex },
    seenSeq,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(input ? { input } : {}),
  };
  // The status, the approval step and the approval row commit together, so a
  // reader never sees a waiting run without its approval.
  const paused = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.runs)
      .set({ ...patch, status: 'waiting', state })
      .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, 'running')))
      .returning();
    if (!row) return null;
    if (wait.reason !== 'approval') return { row, step: null, approval: null };
    const step = await steps.store(tx, {
      type: 'approval',
      label: `Asked to approve: ${labelFor(wait.toolName, wait.args, undefined, labels)}`,
      payload: { toolCallId: wait.toolCallId, toolName: wait.toolName, widget: wait.widget.props },
    });
    const approval = await storeApproval(
      tx,
      row,
      { ...wait, messageId, partIndex },
      approvalTtlMs(deps.config),
    );
    return { row, step, approval };
  });
  if (!paused) {
    await setState(deps, run.botId, 'idle', { runId: run.id });
    return;
  }
  const { row, step, approval } = paused;
  if (step) await steps.announce(step);
  if (approval) await announceApproval(deps, approval);
  await publishRunStatus(deps, row);
  await setState(deps, run.botId, 'waiting', { runId: run.id, currentAction: wait.label });
  if (expiresAt) await scheduleLoginExpiry(deps, { messageId, partIndex }, expiresAt);
  if (posted) await resumeIfAnswered(deps, run.id, posted);
}

const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, steps: 0 };

function decisionLabel(output: unknown): string {
  if (isApproved(output)) return 'Approved';
  const error = (output as ApprovalOutcome | null)?.error ?? '';
  return error.includes('expired') ? 'Approval expired' : 'Denied';
}

/**
 * What a resumed run reads besides the answer (C7): the owner's note on an
 * approval and the replies in the waiting widget's thread, in one turn.
 */
async function resumeContext(
  deps: AppDeps,
  bot: BotRow,
  chat: ChatRow,
  pending: PendingWait,
  answer: unknown,
  vision: boolean,
): Promise<ModelMessage[]> {
  const lines: string[] = [];
  const note = (answer as ApprovalOutcome | null)?.note;
  const handles = await chatHandles(deps.db, chat);
  const ownerHandle = handles.owner;
  if (pending.reason === 'approval' && isApproved(answer) && note) {
    lines.push(`[@${ownerHandle} (owner)] [note with the approval] ${note}`);
  }
  if (pending.messageId) {
    const replies = await deps.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadRootId, pending.messageId))
      .orderBy(asc(schema.messages.seq));
    const texts = toModelMessages(
      replies
        .filter((r) => !(r.authorType === 'bot' && r.authorId === bot.id))
        .map((r) => transcriptMessage(r, bot, handles)),
      namedAttachments(vision),
    ).map((m) => (typeof m.content === 'string' ? m.content : ''));
    if (texts.some(Boolean)) {
      lines.push(
        `[system] Replies in the thread on your ${pending.widget.kind} request:`,
        ...texts.filter(Boolean),
      );
    }
  }
  return lines.length ? [{ role: 'user', content: lines.join('\n') }] : [];
}

/** A run that cannot start (plan 5.9): an event row with the fix, and the Bot blocked. */
async function blockRun(deps: AppDeps, run: RunRow, text: string, fix: string) {
  await postBlockedEvent(deps, run, `${text} ${fix}`, { fix });
  const [row] = await deps.db
    .update(schema.runs)
    .set({ status: 'failed', error: text, finishedAt: new Date() })
    .where(eq(schema.runs.id, run.id))
    .returning();
  await publishRunStatus(deps, row!);
  await setState(deps, run.botId, 'blocked', { runId: run.id, currentAction: text });
}

/** Failure (plan 5.7): message failed, a compact event row, run failed, Bot blocked. */
async function failRun(deps: AppDeps, run: RunRow, messageId: string | null, error: unknown) {
  const text = describeError(error);
  deps.logger.error({ err: error, runId: run.id }, 'run failed');
  try {
    if (messageId) await finalize(deps, messageId, { status: 'failed' });
    // A crash can leave this run's earlier messages streaming; close them too.
    const open = await deps.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.runId, run.id), eq(schema.messages.status, 'streaming')));
    for (const m of open) await finalize(deps, m.id, { status: 'failed' });
    // The status, the event row and the error step commit together, so a
    // reader never sees a failed run without them.
    const failed = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.runs)
        .set({ status: 'failed', error: text, finishedAt: new Date() })
        .where(and(eq(schema.runs.id, run.id), sql`${schema.runs.status} <> 'cancelled'`))
        .returning();
      if (!row) return null;
      const event = await storeBlockedEvent(tx, run, `Couldn't finish: ${text}`, { error: text });
      await tx.insert(schema.runSteps).values({
        workspaceId: run.workspaceId,
        runId: run.id,
        idx: sql`(select coalesce(max(idx), -1) + 1 from run_steps where run_id = ${run.id})`,
        type: 'error',
        label: text.slice(0, 200),
      });
      return { row, event };
    });
    if (!failed) return;
    if (failed.event) await announceMessage(deps, failed.event);
    await publishRunStatus(deps, failed.row);
    await setState(deps, run.botId, 'blocked', { runId: run.id, currentAction: 'Run failed' });
  } catch (cleanup) {
    deps.logger.error({ err: cleanup, runId: run.id }, 'run failure cleanup failed');
  }
}

/**
 * A connector that needs its owner to sign in again (401, expired OAuth): one
 * event row per connector, with the fix and a link to the Connectors page.
 */
async function postLoginNotices(deps: AppDeps, run: RunRow, notices: LoginNotice[]) {
  for (const notice of notices) {
    const fix = 'Sign in again on the Connectors page.';
    await postBlockedEvent(deps, run, `${notice.connectorName} connector needs login. ${fix}`, {
      connectorId: notice.connectorId,
      fix,
      link: `/connectors?connector=${notice.connectorId}`,
    });
  }
}

async function postBlockedEvent(deps: AppDeps, run: RunRow, text: string, data: object) {
  const row = await deps.db.transaction((tx) => storeBlockedEvent(tx, run, text, data));
  if (row) await announceMessage(deps, row);
}

/** The run had to boot the computer (W3): a compact event row, e.g. "Computer started 4.2s". */
async function postComputerStarted(
  deps: AppDeps,
  run: RunRow,
  durationMs: number,
  updated: boolean,
) {
  if (!run.chatId) return;
  const seconds = `${(durationMs / 1000).toFixed(1)}s`;
  await postMessage(deps, run.chatId, {
    authorType: 'system',
    runId: run.id,
    parts: [
      {
        type: 'event',
        kind: 'computer_started',
        // A start after an upgrade made the computer again from the new image (plan 16.3).
        text: updated
          ? `Updated your computer and started it ${seconds}`
          : `Computer started ${seconds}`,
        data: { runId: run.id, durationMs, ...(updated ? { updated: true } : {}) },
      },
    ],
  });
}

/** A `blocked` event row in the run's chat, inside the caller's transaction. */
async function storeBlockedEvent(tx: Db, run: RunRow, text: string, data: object) {
  if (!run.chatId) return null;
  return storeMessage(
    tx,
    { id: run.chatId, workspaceId: run.workspaceId },
    {
      authorType: 'system',
      runId: run.id,
      parts: [{ type: 'event', kind: 'blocked', text, data: { runId: run.id, ...data } }],
    },
  );
}

/** Routes a finished reply (plan 7); a routing failure never fails the run. */
async function routeReply(deps: AppDeps, options: RunWorkerOptions, messageId: string) {
  try {
    await routeBotReply(deps, messageId, options.router);
  } catch (error) {
    deps.logger.error({ err: error, messageId }, 'routing a Bot reply failed');
  }
}

/** After a completed run, with the small model: memory extraction, then the rolling chat summary. */
async function afterRun(
  deps: AppDeps,
  options: RunWorkerOptions,
  run: RunRow,
  bot: BotRow,
  config: ModelConfig,
  embedder: Embedder,
) {
  if (!run.chatId) return;
  let model: LanguageModel | null;
  try {
    model = options.smallModel
      ? await options.smallModel(config, bot)
      : await defaultSmallModel(deps, config);
  } catch (error) {
    deps.logger.warn({ err: error, runId: run.id }, 'no small model after the run');
    return;
  }
  if (!model) return;
  await extractAfterRun(deps, run, bot, model, embedder);
  try {
    await updateChatSummary(deps, run.chatId, model, {
      window: options.historyWindow ?? HISTORY_WINDOW,
      ...(options.summaryBatch !== undefined ? { batch: options.summaryBatch } : {}),
    });
  } catch (error) {
    deps.logger.warn({ err: error, runId: run.id }, 'chat summary failed');
  }
}

/** Post-run extraction (M1): at most three memories from the small model. */
async function extractAfterRun(
  deps: AppDeps,
  run: RunRow,
  bot: BotRow,
  model: LanguageModel,
  embedder: Embedder,
) {
  if (!run.chatId) return;
  try {
    const rows = (
      await deps.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.chatId, run.chatId), isNull(schema.messages.threadRootId)))
        .orderBy(desc(schema.messages.seq))
        .limit(EXTRACTION_WINDOW)
    ).reverse();
    const [chat] = await deps.db.select().from(schema.chats).where(eq(schema.chats.id, run.chatId));
    const handles: ChatHandles = {
      ...(await chatHandles(
        deps.db,
        chat!,
        rows.map((r) => r.authorId),
      )),
      owner: 'owner',
    };
    const transcript = toModelMessages(rows.map((r) => transcriptMessage(r, bot, handles))).map(
      (m) =>
        typeof m.content === 'string'
          ? m.content
          : `[@${bot.handle} (you)] ${m.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join(' ')
              .trim()}`,
    );
    const existing = await deps.db
      .select({ content: schema.botMemories.content })
      .from(schema.botMemories)
      .where(eq(schema.botMemories.botId, bot.id));
    const items = await extractMemories({
      model,
      transcript: transcript.filter((t) => t.trim()),
      existing: existing.map((e) => e.content),
    });
    for (const item of items) {
      await saveMemory(
        deps,
        { ...item, botId: bot.id, workspaceId: run.workspaceId, sourceRunId: run.id },
        embedder,
      );
    }
  } catch (error) {
    deps.logger.warn({ err: error, runId: run.id }, 'memory extraction failed');
  }
}

async function defaultSmallModel(deps: AppDeps, config: ModelConfig) {
  const small = await smallModelFor(deps, config.provider_id);
  if (!small) return null;
  const resolved = await providerRegistry(deps).resolve({
    provider_id: config.provider_id,
    model_id: small.modelId,
  });
  return resolved.model;
}

/**
 * Runs left `running` or `queued` when the only process died (in-memory
 * infra, plan 5.7, K4): their jobs died with it, so each is queued again,
 * oldest first. A running one is taken over from its checkpoint; a queued
 * one (a new run, or a resume waiting for the Bot's lock) starts as it would
 * have. With Redis, the queue keeps its jobs and re-delivers stale ones.
 */
export async function recoverInterruptedRuns(deps: AppDeps) {
  const lost = await deps.db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.status, ACTIVE_STATUSES))
    .orderBy(asc(schema.runs.createdAt));
  for (const run of lost) {
    const resume = run.status === 'queued' && (run.state as RunState | null)?.resume;
    await scheduleRun(deps, run, resume ? 'resume' : 'run');
  }
  return lost.length;
}
