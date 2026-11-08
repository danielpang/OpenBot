/** Provider-specific subscription identities shared by Models and model resolution. */
export const SUBSCRIPTION_PROVIDERS = {
  anthropic: {
    agent: 'claude',
    provider: 'anthropic',
    plan: 'Anthropic (Claude Pro/Max)',
    label: 'Claude',
  },
  openai: {
    agent: 'codex',
    provider: 'openai-codex',
    plan: 'OpenAI (ChatGPT Plus/Pro)',
    label: 'ChatGPT',
  },
  xai: { agent: 'pi', provider: 'xai', plan: 'xAI', label: 'xAI' },
} as const;
export const SUBSCRIPTION_BRIDGE = '/app/apps/computer-agent/dist/subscription-model.js';
export const SUBSCRIPTION_SIGN_OUT = '/app/apps/computer-agent/dist/subscription-sign-out.js';
/** OAuth refresh has a 15s deadline. Allow its commit to finish after cancellation. */
export const SUBSCRIPTION_CANCEL_GRACE_MS = 20_000;
export const SUBSCRIPTION_AUTH_ERROR =
  'Subscription is not signed in. Reconnect in Settings > Models.';
