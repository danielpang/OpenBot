import type { ProviderConfig, ResolvedModel } from '@openbots/models';
import {
  SUBSCRIPTION_AUTH_ERROR,
  SUBSCRIPTION_PROVIDERS,
  type CoderAgent,
  type ModelCapabilities,
  type ModelConfig,
  type ProviderKind,
} from '@openbots/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { agentFor, startComputer } from './computer.js';
import { providerRegistry } from './providers.js';
import { subscriptionModel } from './subscription-model.js';

type Owner = { id: string; workspaceId: string };
type Account = { agent: string; authKind: string; accountLabel: string | null };

/** A delayed failure from an old request must not poison a newly connected login. */
export async function recordSubscriptionAuthState(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  account: { agent: string; signedInAt: Date | null },
  failed: boolean,
): Promise<void> {
  await deps.db
    .update(schema.coderAccounts)
    .set({ lastError: failed ? SUBSCRIPTION_AUTH_ERROR : null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.coderAccounts.ownerId, owner.id),
        eq(schema.coderAccounts.workspaceId, owner.workspaceId),
        eq(schema.coderAccounts.agent, account.agent),
        eq(schema.coderAccounts.authKind, 'subscription'),
        account.signedInAt
          ? eq(schema.coderAccounts.signedInAt, account.signedInAt)
          : isNull(schema.coderAccounts.signedInAt),
        failed ? undefined : eq(schema.coderAccounts.lastError, SUBSCRIPTION_AUTH_ERROR),
      ),
    );
}

/** A subscription stays selected even when lapsed: never silently bill an API key. */
export function subscriptionFor(
  kind: ProviderKind,
  accounts: readonly Account[],
): { agent: CoderAgent; provider: string } | null {
  const identity = SUBSCRIPTION_PROVIDERS[kind as keyof typeof SUBSCRIPTION_PROVIDERS];
  if (!identity) return null;
  const { provider, plan } = identity;
  const native = identity.agent === 'pi' ? null : identity.agent;
  if (native && accounts.some((a) => a.agent === native && a.authKind === 'subscription'))
    return { agent: native, provider };
  if (
    accounts.some(
      (a) =>
        a.agent === 'pi' &&
        a.authKind === 'subscription' &&
        a.accountLabel?.split(', ').includes(plan),
    )
  )
    return { agent: 'pi', provider };
  return null;
}

/** Resolve on every call, so connecting/disconnecting applies without a cached credential. */
export async function resolveConnectedModel(
  deps: AppDeps,
  config: ModelConfig,
  owner: Owner,
): Promise<ResolvedModel> {
  const resolved = await providerRegistry(deps).resolve(config);
  const model = await subscriptionModelFor(
    deps,
    resolved.provider,
    config,
    owner,
    resolved.info?.capabilities,
  );
  if (!model) return resolved;
  // Vendor list prices are not a subscription cost estimate.
  return { ...resolved, model, info: resolved.info ? { ...resolved.info, pricing: null } : null };
}

/** Also used by Test, which may exercise a model the owner has disabled. */
export async function subscriptionModelFor(
  deps: AppDeps,
  provider: ProviderConfig,
  config: ModelConfig,
  owner: Owner,
  capabilities?: ModelCapabilities,
): Promise<ReturnType<typeof subscriptionModel> | null> {
  // Credentials from a vendor's subscription must never be sent to a custom host.
  if (provider.protocol !== 'native' || provider.baseUrl || Object.keys(provider.headers).length)
    return null;
  const accounts = await deps.db
    .select()
    .from(schema.coderAccounts)
    .where(
      and(
        eq(schema.coderAccounts.ownerId, owner.id),
        eq(schema.coderAccounts.workspaceId, owner.workspaceId),
      ),
    );
  const connection = subscriptionFor(provider.kind, accounts);
  if (!connection) return null;
  const account = accounts.find((a) => a.agent === connection.agent)!;
  return subscriptionModel(
    async () => {
      const { computer } = await startComputer(deps, owner);
      return agentFor(deps, computer);
    },
    connection,
    config.model_id,
    config.reasoning,
    capabilities,
    (failed) => recordSubscriptionAuthState(deps, owner, account, failed),
  );
}
