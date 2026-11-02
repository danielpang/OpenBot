import { AvatarEditor } from '@openbots/avatars/react';
import { Button, Input } from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSavedCheckbox } from '../../app/saved-checkbox.js';
import { BotSkills } from '../skills/bot-skills.js';
import { BotTools } from '../tools/bot-tools.js';
import { BotInbox } from '../webhooks/endpoints.js';
import { BotModelFields } from './bot-model.js';
import { BotUsageSection } from './bot-usage.js';
import { useBot } from './bot-view.js';
import { DeleteBotDialog } from './delete-bot-dialog.js';
import { botsQuery, takenAvatars, updateBot, useBotActions, type Bot } from './queries.js';

// The Bot's Settings tab (B3): profile, model, the main Bot toggle (K8),
// tools and permissions (T1, T5), enabled Skills (S2), the webhook inbox
// (H1), usage (plan 5.8), Duplicate (B5) and Delete (B7).

export const DESCRIPTION_HELP = 'Rules that always apply. Give one-off tasks in the chat.';

export const MAIN_BOT_HELP = 'Handles sign-in requests from your other Bots.';

export function BotSettings({ botId }: { botId: string }) {
  const { bot } = useBot(botId);
  if (!bot) return null;
  // Keyed so the form starts from the saved profile when another Bot opens.
  return <BotSettingsForm key={bot.id} bot={bot} />;
}

function BotSettingsForm({ bot }: { bot: Bot }) {
  const { data } = useQuery(botsQuery);
  const { update, duplicate } = useBotActions();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState({
    name: bot.name,
    label: bot.label ?? '',
    description: bot.description,
    avatar: bot.avatar,
    modelConfig: bot.modelConfig,
  });
  const changed =
    draft.name !== bot.name ||
    draft.label !== (bot.label ?? '') ||
    draft.description !== bot.description ||
    JSON.stringify(draft.avatar) !== JSON.stringify(bot.avatar) ||
    JSON.stringify(draft.modelConfig) !== JSON.stringify(bot.modelConfig);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate({
      id: bot.id,
      body: { ...draft, name: draft.name.trim(), label: draft.label.trim() || null },
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={64}
            required
          />
        </Field>
        <Field label="Label" help="Shown under the name.">
          <Input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            maxLength={64}
          />
        </Field>
        <Field label="Description" help={DESCRIPTION_HELP}>
          <textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            rows={6}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Avatar" group>
          <AvatarEditor
            value={draft.avatar}
            onChange={(avatar) => setDraft({ ...draft, avatar })}
            taken={takenAvatars(data?.items ?? [], bot.id)}
          />
        </Field>
        <Field label="Model" group>
          <BotModelFields
            bot={bot}
            value={draft.modelConfig}
            onChange={(modelConfig) => setDraft({ ...draft, modelConfig })}
          />
        </Field>
        {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
        <div>
          <Button type="submit" disabled={!changed || !draft.name.trim() || update.isPending}>
            Save
          </Button>
        </div>
      </form>

      <MainBotToggle bot={bot} others={data?.items ?? []} />

      <Section title="Tools and permissions">
        <BotTools bot={bot} />
      </Section>
      <Section title="Skills">
        <BotSkills botId={bot.id} />
      </Section>
      <Section title="Webhook inbox">
        <BotInbox botId={bot.id} />
      </Section>
      <Section title="Usage">
        <BotUsageSection botId={bot.id} />
      </Section>

      <Section title="Duplicate">
        <p>Copies the profile and settings, not the conversation.</p>
        <Button
          variant="outline"
          className="self-start"
          disabled={duplicate.isPending}
          onClick={() =>
            duplicate.mutate(bot.id, {
              onSuccess: (copy) =>
                void navigate({ to: '/bots/$botId/settings', params: { botId: copy.id } }),
            })
          }
        >
          Duplicate
        </Button>
      </Section>

      <Section title="Delete">
        <p>Removes the profile, conversation and Routines.</p>
        <Button variant="destructive" className="self-start" onClick={() => setDeleting(true)}>
          Delete…
        </Button>
      </Section>
      <DeleteBotDialog bot={deleting ? bot : null} onClose={() => setDeleting(false)} />
    </div>
  );
}

/** At most one main Bot (K8); turning it on here turns it off on the current one. */
export function MainBotToggle({ bot, others }: { bot: Bot; others: readonly Bot[] }) {
  const queryClient = useQueryClient();
  const { error, ...box } = useSavedCheckbox(
    bot.isMain,
    (isMain) => updateBot(bot.id, { isMain }),
    () => queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  );
  const current = others.find((b) => b.isMain && b.id !== bot.id);
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" {...box} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">Main Bot</span>
        <span className="text-muted-foreground">{MAIN_BOT_HELP}</span>
        {current && !bot.isMain && (
          <span className="text-xs text-muted-foreground">
            {`Replaces @${current.handle} as your main Bot.`}
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error.message}</span>}
      </span>
    </label>
  );
}

function Field({
  label,
  help,
  group,
  children,
}: {
  label: string;
  help?: string;
  /** For composite controls, which a `<label>` would hijack clicks for. */
  group?: boolean;
  children: ReactNode;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag
      className="flex flex-col gap-1.5 text-sm"
      role={group ? 'group' : undefined}
      aria-label={group ? label : undefined}
    >
      <span className="font-medium">{label}</span>
      {children}
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </Tag>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 text-sm text-muted-foreground">
      <h2 className="font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}
