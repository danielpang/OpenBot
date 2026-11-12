import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, Switch, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { unwrap } from '@openbots/api-client';
import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { botsQueryOptions } from '../api/bots';
import { useApi } from '../api/provider';
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Icon,
  Label,
  Page,
  Section,
  row,
} from '../components/ui';
import { useTheme } from '../theme';
import {
  SKILLS_KEY,
  initialPicks,
  parseSkillFile,
  plural,
  skillsQuery,
  availabilityText,
  type Picked,
  type Skill,
  type SkillImportPreview,
  type SkillOrigin,
} from './data';
import { SkillBots } from './skill-bots';

// The Skills library on iOS (S1, S3): list the account's Skills, write a new
// one or fill it from a markdown file in Files, edit or delete one, and
// import Skills from a GitHub link. Every Skill is on for all of the owner's
// Bots; the Skill's own screen turns it off for a Bot.

export const SKILLS_HELP =
  'Instructions your Bots can follow. Every Skill is on for all your Bots; open one to turn it off for a Bot. Type / in a chat to use one.';
export const IMPORT_HELP =
  'Link a GitHub repository, folder or SKILL.md file. For a private repository, add the GitHub connector on your computer first.';

/** The largest file read from Files; the server caps content at 100,000 characters. */
const FILE_MAX_BYTES = 512 * 1024;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SkillsScreen() {
  const api = useApi();
  const query = useQuery(skillsQuery(api));
  const bots = useQuery(botsQueryOptions(api)).data?.items;
  const skills = query.data?.items ?? [];
  return (
    <Page>
      <Stack.Screen options={{ title: 'Skills' }} />
      <Label muted size={14}>
        {SKILLS_HELP}
      </Label>
      <View style={{ gap: 10 }}>
        <Button title="New Skill" icon="add" onPress={() => router.push('/skills/new')} />
        <Button
          title="Import from GitHub"
          icon="logo-github"
          variant="secondary"
          onPress={() => router.push('/skills/import')}
        />
      </View>
      <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      {query.isPending ? <ActivityIndicator /> : null}
      {query.data && !skills.length ? (
        <Empty
          icon="sparkles-outline"
          title="No Skills yet"
          detail="Write one, fill one from a markdown file, or import Skills from GitHub."
        />
      ) : null}
      {skills.length ? (
        <Section title={plural(skills.length, 'Skill', 'Skills')}>
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} bots={bots} />
          ))}
        </Section>
      ) : null}
    </Page>
  );
}

function SkillRow({
  skill,
  bots,
}: {
  skill: Skill;
  /** The owner's Bots, once loaded, to say which ones the Skill is on for. */
  bots?: readonly { id: string; name: string }[];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${skill.name}`}
      onPress={() => router.push(`/skills/${skill.id}`)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Card style={{ gap: 6 }}>
        <View style={row.base}>
          <Icon name="sparkles-outline" size={19} />
          <Label weight="600" style={{ flex: 1 }}>
            {skill.name}
          </Label>
          <Icon name="chevron-forward" size={17} />
        </View>
        {skill.summary ? (
          <Label muted size={14}>
            {skill.summary}
          </Label>
        ) : null}
        <Label muted size={12}>
          {[
            bots && availabilityText(skill.blockedBotIds, bots),
            skill.origin && `Imported from ${skill.origin.repo}`,
          ]
            .filter(Boolean)
            .join('. ')}
        </Label>
      </Card>
    </Pressable>
  );
}

/** `/skills/new` and `/skills/[id]`: name, content, save, delete. */
export function SkillEditorScreen({ isNew = false }: { isNew?: boolean }) {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const api = useApi();
  const query = useQuery({ ...skillsQuery(api), enabled: !isNew });
  if (isNew) return <SkillEditor />;
  const skill = query.data?.items.find((s) => s.id === id);
  if (skill) return <SkillEditor key={skill.id} skill={skill} />;
  return (
    <Page>
      <Stack.Screen options={{ title: 'Skill' }} />
      {query.isPending ? <ActivityIndicator /> : null}
      <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
      {query.data ? (
        <Empty
          icon="sparkles-outline"
          title="Skill not found"
          detail="It may have been deleted on another device."
        />
      ) : null}
    </Page>
  );
}

export function SkillEditor({ skill }: { skill?: Skill }) {
  const api = useApi();
  const bots = useQuery({ ...botsQueryOptions(api), enabled: !!skill }).data?.items;
  const cache = useQueryClient();
  const [name, setName] = useState(skill?.name ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [fileNote, setFileNote] = useState<string | null>(null);
  const dirty = name !== (skill?.name ?? '') || content !== (skill?.content ?? '');

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), content };
      return skill
        ? unwrap(api.PATCH('/api/v1/skills/{id}', { params: { path: { id: skill.id } }, body }))
        : unwrap(api.POST('/api/v1/skills', { body }));
    },
    onSuccess: async (saved) => {
      await cache.invalidateQueries({ queryKey: SKILLS_KEY });
      if (skill) router.back();
      else router.replace(`/skills/${saved.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/v1/skills/{id}', { params: { path: { id: skill!.id } } })),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: SKILLS_KEY });
      router.back();
    },
  });
  const pickFile = useMutation({
    mutationFn: async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/markdown', 'text/plain', 'text/x-markdown', 'public.plain-text'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets[0]) return null;
      const asset = result.assets[0];
      const file = new File(asset.uri);
      if (file.size > FILE_MAX_BYTES)
        throw new Error(`Choose a file smaller than ${FILE_MAX_BYTES / 1024} KB.`);
      const parsed = parseSkillFile(await file.text(), asset.name);
      if (parsed.content.length > SKILL_CONTENT_MAX)
        throw new Error(
          `${asset.name} is longer than ${SKILL_CONTENT_MAX.toLocaleString('en-US')} characters.`,
        );
      return { ...parsed, fileName: asset.name };
    },
    onSuccess: (parsed) => {
      if (!parsed) return;
      if (parsed.name) setName(parsed.name);
      setContent(parsed.content);
      setFileNote(`Filled from ${parsed.fileName}. Review it, then tap Create.`);
    },
  });

  function confirmDelete() {
    Alert.alert(`Delete ${skill!.name}?`, 'This removes it from your library and from every Bot.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete for every Bot', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  }

  const busy = save.isPending || remove.isPending;
  return (
    <Page>
      <Stack.Screen options={{ title: skill ? skill.name : 'New Skill' }} />
      {skill ? (
        bots ? (
          <Label muted size={13}>
            {availabilityText(skill.blockedBotIds, bots)}
          </Label>
        ) : null
      ) : (
        <View style={{ gap: 8 }}>
          <Button
            title="Fill from a file"
            icon="document-text-outline"
            variant="secondary"
            loading={pickFile.isPending}
            onPress={() => pickFile.mutate()}
          />
          <Label muted size={13}>
            {fileNote ?? 'Pick a SKILL.md or other markdown file from Files, or write one below.'}
          </Label>
          <ErrorNote error={pickFile.error} />
        </View>
      )}
      {skill?.origin ? <SkillOriginNote origin={skill.origin} /> : null}
      <Section title="Name">
        <Field
          value={name}
          onChangeText={setName}
          maxLength={SKILL_NAME_MAX}
          placeholder="Weekly report"
          accessibilityLabel="Name"
          autoCapitalize="sentences"
          returnKeyType="next"
        />
      </Section>
      <Section title="Content">
        <Field
          value={content}
          onChangeText={setContent}
          maxLength={SKILL_CONTENT_MAX}
          placeholder={'Markdown instructions, for example:\n\nWhen asked for the weekly report, …'}
          accessibilityLabel="Content"
          multiline
          scrollEnabled={false}
          autoCapitalize="sentences"
          style={{
            minHeight: 280,
            textAlignVertical: 'top',
            fontFamily: 'Menlo',
            fontSize: 14,
            lineHeight: 20,
          }}
        />
        <Label muted size={12}>
          {`${content.length.toLocaleString('en-US')} / ${SKILL_CONTENT_MAX.toLocaleString('en-US')} characters`}
        </Label>
      </Section>
      <ErrorNote error={save.error} />
      <Button
        title={skill ? 'Save' : 'Create'}
        icon="checkmark"
        disabled={!name.trim() || !dirty || remove.isPending}
        loading={save.isPending}
        onPress={() => save.mutate()}
      />
      {skill ? (
        <>
          <SkillBots skill={skill} />
          <ErrorNote error={remove.error} />
          <Button
            title="Delete"
            icon="trash-outline"
            variant="danger"
            disabled={busy}
            loading={remove.isPending}
            onPress={confirmDelete}
          />
        </>
      ) : null}
    </Page>
  );
}

/** Where an imported Skill came from (S3). */
export function SkillOriginNote({ origin }: { origin: SkillOrigin }) {
  return (
    <Card style={{ gap: 6, padding: 14 }}>
      <Label muted size={13}>
        Imported from {origin.repo}/{origin.path} at {origin.ref} ({origin.sha.slice(0, 7)}).
        {origin.license ? ` License: ${origin.license}.` : ''} It is on for every Bot: read it, and
        turn it off below for any Bot that should not use it.
      </Label>
      <Button
        title="View on GitHub"
        icon="open-outline"
        variant="ghost"
        onPress={() =>
          void Linking.openURL(origin.permalink).catch((error) =>
            Alert.alert('Could not open link', message(error)),
          )
        }
      />
    </Card>
  );
}

/** `/skills/import`: a GitHub link, then the Skills found there. */
export function SkillImportScreen() {
  const api = useApi();
  const cache = useQueryClient();
  const c = useTheme();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [picked, setPicked] = useState<Picked>({});

  const find = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/skills/import/preview', { body: { url: url.trim() } })),
    onSuccess: (found) => {
      setPreview(found);
      setPicked(initialPicks(found));
    },
  });
  const run = useMutation({
    mutationFn: (found: SkillImportPreview) =>
      unwrap(
        api.POST('/api/v1/skills/import', {
          body: {
            url: found.source.url,
            ref: found.source.ref,
            sha: found.source.sha,
            skills: found.skills
              .filter((s) => picked[s.path]?.on)
              .map((s) => ({ path: s.path, name: picked[s.path]!.name.trim() })),
          },
        }),
      ),
    onSuccess: async ({ items }) => {
      await cache.invalidateQueries({ queryKey: SKILLS_KEY });
      if (items.length === 1) router.replace(`/skills/${items[0]!.skill.id}`);
      else router.back();
    },
  });

  if (!preview) {
    return (
      <Page>
        <Stack.Screen options={{ title: 'Import from GitHub' }} />
        <Label muted size={14}>
          {IMPORT_HELP}
        </Label>
        <Section title="GitHub link">
          <Field
            value={url}
            onChangeText={setUrl}
            placeholder="https://github.com/owner/repo/tree/main/skills"
            accessibilityLabel="GitHub link"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="search"
            onSubmitEditing={() => url.trim() && find.mutate()}
            autoFocus
          />
        </Section>
        <ErrorNote error={find.error} />
        <Button
          title={find.isPending ? 'Looking…' : 'Find Skills'}
          icon="search"
          disabled={!url.trim()}
          loading={find.isPending}
          onPress={() => find.mutate()}
        />
      </Page>
    );
  }

  const { source } = preview;
  const where = `${source.repo}${source.path ? `/${source.path}` : ''}`;
  const chosen = preview.skills.filter((s) => picked[s.path]?.on);
  const over = chosen.length > preview.room;
  const unnamed = chosen.some((s) => !picked[s.path]!.name.trim());
  const set = (path: string, change: Partial<Picked[string]>) =>
    setPicked((current) => ({ ...current, [path]: { ...current[path]!, ...change } }));

  return (
    <Page>
      <Stack.Screen options={{ title: 'Import from GitHub' }} />
      <Label muted size={14}>
        {preview.skills.length
          ? `Found ${plural(preview.skills.length, 'Skill', 'Skills')} in ${where} at ${source.ref}. Pick the ones to import.`
          : `No SKILL.md files found in ${where}. Link a folder that has one, or a markdown file.`}
      </Label>
      {preview.skills.map((s) => {
        const pick = picked[s.path]!;
        const blocked = s.error !== null;
        return (
          <Card key={s.path} style={{ gap: 8, opacity: blocked ? 0.7 : 1 }}>
            <View style={row.between}>
              <Label weight="600" style={{ flex: 1 }} selectable>
                {s.name}
              </Label>
              <Switch
                accessibilityLabel={`Import ${s.path}`}
                value={pick.on}
                disabled={blocked || run.isPending}
                onValueChange={(on) => set(s.path, { on })}
              />
            </View>
            {pick.on ? (
              <Field
                value={pick.name}
                onChangeText={(name) => set(s.path, { name })}
                maxLength={SKILL_NAME_MAX}
                accessibilityLabel={`Name for ${s.path}`}
                editable={!run.isPending}
              />
            ) : null}
            {s.suggestedName !== s.name ? (
              <Label muted size={12}>
                Your library already has a Skill named {s.name}.
              </Label>
            ) : null}
            {s.description ? (
              <Label muted size={14} style={{ maxHeight: 60 }}>
                {s.description}
              </Label>
            ) : null}
            <Label muted size={12}>
              {s.path}
            </Label>
            {s.error ? (
              <Label size={12} style={{ color: c.danger }}>
                {s.error}
              </Label>
            ) : null}
          </Card>
        );
      })}
      {preview.more ? (
        <Label muted size={13}>
          Only the first {preview.skills.length} are listed. Link a folder to see the rest.
        </Label>
      ) : null}
      <Label muted={!over} size={13} style={over ? { color: c.danger } : undefined}>
        {preview.room > 0
          ? `Your library has room for ${plural(preview.room, 'more Skill', 'more Skills')} (limit ${preview.limit}).`
          : `Your library is at its limit of ${preview.limit} Skills. Delete Skills you no longer need first.`}
        {over ? ' Pick fewer to import.' : ''}
      </Label>
      <ErrorNote error={run.error} />
      <View style={{ gap: 10 }}>
        <Button
          title={
            run.isPending
              ? 'Importing…'
              : `Import ${chosen.length ? plural(chosen.length, 'Skill', 'Skills') : 'Skills'}`
          }
          icon="download-outline"
          disabled={!chosen.length || over || unnamed}
          loading={run.isPending}
          onPress={() => run.mutate(preview)}
        />
        <Button
          title="Back"
          variant="secondary"
          disabled={run.isPending}
          onPress={() => {
            setPreview(null);
            run.reset();
          }}
        />
      </View>
    </Page>
  );
}
