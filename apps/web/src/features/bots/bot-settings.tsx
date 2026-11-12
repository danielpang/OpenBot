import { AvatarEditor } from '@openbots/avatars/react';
import {
  CopyIcon,
  IconButton,
  Input,
  SaveButton,
  Switch,
  Textarea,
  TrashIcon,
  useSaveState,
} from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSavedCheckbox } from '../../app/saved-checkbox.js';
import { SettingsPanel, SettingsRow, SettingsSection } from '../../app/settings-layout.js';
import { BotTools } from '../tools/bot-tools.js';
import { BotInbox } from '../webhooks/endpoints.js';
import { BotModelFields } from './bot-model.js';
import { BotUsageSection } from './bot-usage.js';
import { useBot } from './bot-view.js';
import { DeleteBotDialog } from './delete-bot-dialog.js';
import { botsQuery, takenAvatars, updateBot, useBotActions, type Bot } from './queries.js';

// The Bot's Settings tab (B3): profile, model, the main Bot toggle (K8),
// tools and permissions (T1, T5), the webhook inbox (H1), usage (plan 5.8),
// Duplicate (B5) and Delete (B7). Which Skills a Bot may use is set on each
// Skill's page (S2), not here.

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
  const saved = useSaveState(update);
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
    <div className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
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
          <Textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            rows={6}
            className="w-full"
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
          <SaveButton type="submit" state={saved.state} disabled={!changed || !draft.name.trim()}>
            Save
          </SaveButton>
        </div>
      </form>

      <SettingsSection title="Role">
        <SettingsPanel>
          <div className="px-4 py-3">
            <MainBotToggle bot={bot} others={data?.items ?? []} />
          </div>
        </SettingsPanel>
      </SettingsSection>

      <SettingsSection
        title="Tools and permissions"
        description="Choose whether each tool runs, asks you first, or is refused."
      >
        <BotTools bot={bot} />
      </SettingsSection>

      <SettingsSection title="Webhook inbox">
        <BotInbox botId={bot.id} />
      </SettingsSection>

      <SettingsSection title="Usage">
        <BotUsageSection botId={bot.id} />
      </SettingsSection>

      <SettingsSection title="Manage">
        <SettingsPanel>
          <SettingsRow
            title="Duplicate"
            description="Copies the profile and settings, not the conversation."
            control={
              <IconButton
                label="Duplicate"
                variant="outline"
                busy={duplicate.isPending}
                onClick={() =>
                  duplicate.mutate(bot.id, {
                    onSuccess: (copy) =>
                      void navigate({ to: '/bots/$botId/settings', params: { botId: copy.id } }),
                  })
                }
              >
                <CopyIcon />
              </IconButton>
            }
          />
          <SettingsRow
            title="Delete"
            description="Removes the profile, conversation and Routines."
            control={
              <IconButton
                label="Delete…"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleting(true)}
              >
                <TrashIcon />
              </IconButton>
            }
          />
        </SettingsPanel>
      </SettingsSection>
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
    <label className="flex items-start gap-4 text-sm">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">Main Bot</span>
        <span className="text-muted-foreground">{MAIN_BOT_HELP}</span>
        {current && !bot.isMain && (
          <span className="text-xs text-muted-foreground">
            {`Replaces @${current.handle} as your main Bot.`}
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error.message}</span>}
      </span>
      <Switch {...box} className="mt-0.5" />
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
