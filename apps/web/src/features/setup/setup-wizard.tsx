import {
  Button,
  CheckIcon,
  Input,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@openbots/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard, AuthForm, Field } from '../auth/auth-form.js';
import { authErrorMessage } from '../auth/messages.js';
import { NewBotForm } from '../bots/new-bot-form.js';
import {
  createProvider,
  presetsQuery,
  providersQuery,
  testProvider,
  updateProvider,
  type Provider,
  type ProviderPreset,
} from '../models/api.js';
import { BUILT_IN_KINDS } from '../models/format.js';
import {
  createAdmin,
  keyPlaceholder,
  keyStatusText,
  SANDBOX_LABELS,
  sandboxImageQuery,
  startSandboxPull,
  usableProvider,
} from './api.js';

// The first-run wizard (D1, plan 16.3): the owner's account, at least one
// working provider key (L1), the sandbox image pull in the background, and a
// first Bot. Each step after the first uses the ordinary APIs as the new
// owner (an admin internally); reloading part way lands in the app, where
// Settings does the rest. With `skipAccount` (the Mac app's local mode, which
// signed the owner in already) it starts at the provider step.

type Step = 'account' | 'provider' | 'bot';

const STEP_TITLES: Record<Step, string> = {
  account: 'Create your account',
  provider: 'Add a model provider',
  bot: 'Create your first Bot',
};

export function SetupWizard({ skipAccount = false }: { skipAccount?: boolean }) {
  const [step, setStep] = useState<Step>(skipAccount ? 'provider' : 'account');
  return (
    <AuthCard title={STEP_TITLES[step]}>
      {step === 'account' && <AccountStep onDone={() => setStep('provider')} />}
      {step === 'provider' && <ProviderStep onDone={() => setStep('bot')} />}
      {step === 'bot' && <BotStep />}
      {step !== 'account' && <SandboxStatus />}
      {skipAccount && <StartSandboxPull />}
    </AuthCard>
  );
}

/** Starts the image pull the account step would have, once. Renders nothing. */
function StartSandboxPull() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void startSandboxPull().then(
      (state) => queryClient.setQueryData(sandboxImageQuery.queryKey, state),
      () => undefined,
    );
  }, [queryClient]);
  return null;
}

function AccountStep({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createAdmin,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['me'] });
      // Warms the Docker cache while the rest of the wizard runs; status only.
      void startSandboxPull().then(
        (state) => queryClient.setQueryData(sandboxImageQuery.queryKey, state),
        () => undefined,
      );
      onDone();
    },
  });
  return (
    <>
      <p className="text-sm text-muted-foreground">
        This is a new OpenBots server. Your account will be its owner.
      </p>
      <AuthForm
        submitLabel="Create account"
        pending={create.isPending}
        error={create.error ? authErrorMessage(create.error) : null}
        onSubmit={(form) =>
          create.mutate({
            name: String(form.get('name')),
            email: String(form.get('email')),
            password: String(form.get('password')),
          })
        }
      >
        <Field label="Name" name="name" autoComplete="name" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </AuthForm>
    </>
  );
}

function ProviderStep({ onDone }: { onDone: () => void }) {
  const providers = useQuery(providersQuery);
  const presets = useQuery(presetsQuery);
  const error = providers.error ?? presets.error;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!providers.data || !presets.data) return null;

  const presetById = new Map(presets.data.items.map((p) => [p.id, p]));
  const ready = providers.data.items.some(usableProvider);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Paste a key for at least one provider. It is tested first.
      </p>
      {BUILT_IN_KINDS.map((kind) => {
        const preset = presetById.get(kind);
        if (!preset) return null;
        const provider = providers.data.items.find((p) => p.kind === kind);
        return <ProviderKey key={kind} preset={preset} provider={provider} />;
      })}
      <Button disabled={!ready} onClick={onDone}>
        Continue
      </Button>
    </div>
  );
}

/**
 * One built-in provider: save the key (creating the provider on first save),
 * then Test it. Once the test passes, a check mark takes the button's place
 * until the key is edited again.
 */
export function ProviderKey({ preset, provider }: { preset: ProviderPreset; provider?: Provider }) {
  const queryClient = useQueryClient();
  const [edited, setEdited] = useState(false);
  const save = useMutation({
    mutationFn: async (apiKey: string | null) => {
      const saved = apiKey
        ? provider
          ? await updateProvider(provider.id, { apiKey })
          : await createProvider({ presetId: preset.id, apiKey })
        : provider!;
      return testProvider(saved.id);
    },
    onSuccess: () => setEdited(false),
    onSettled: () => queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const apiKey = String(new FormData(event.currentTarget).get('apiKey')).trim();
    if (apiKey || provider?.hasKey) save.mutate(apiKey || null);
  }

  const shown = save.data ?? provider;
  const works = !edited && !save.isPending && !save.error && !!shown && usableProvider(shown);
  const status = shown && keyStatusText(shown);
  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-label={preset.name}
      onSubmit={submit}
    >
      <span className="text-sm font-medium">{preset.name}</span>
      <div className="flex items-center gap-2">
        <Input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={keyPlaceholder(shown)}
          aria-label={`${preset.name} API key`}
          onChange={() => setEdited(true)}
        />
        {works ? (
          <KeyWorks />
        ) : (
          <Button type="submit" variant="outline" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? 'Testing…' : 'Save and test'}
          </Button>
        )}
      </div>
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      ) : (
        !works && status && <p className="text-sm text-muted-foreground">{status}</p>
      )}
    </form>
  );
}

/** Where "Save and test" was: the key passed its test. */
function KeyWorks() {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label="Key works"
            tabIndex={0}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-success outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <CheckIcon className="size-5" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent>Key works. Edit it to save a new one.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The first Bot: a name and an icon, like New (B2). It opens on its chat. */
export function BotStep() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <NewBotForm
      defaultName="Assistant"
      submitLabel="Create Bot"
      onCreated={(bot) => {
        queryClient.removeQueries({ queryKey: ['setup'] });
        void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
      }}
    />
  );
}

function SandboxStatus() {
  const { data } = useQuery(sandboxImageQuery);
  if (!data) return null;
  return (
    <p className="text-center text-xs text-muted-foreground">
      {data.status === 'error' && data.error
        ? `${SANDBOX_LABELS.error} (${data.error})`
        : SANDBOX_LABELS[data.status]}
    </p>
  );
}
