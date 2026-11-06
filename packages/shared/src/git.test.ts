import { describe, expect, it } from 'vitest';
import {
  CODING_ROUTINE_TEMPLATES,
  FoundRepoSchema,
  GITHUB_APP_EVENTS,
  GITHUB_APP_MANIFEST_EVENTS,
  GITHUB_APP_WEBHOOK_PATH,
  GitConnectionViewSchema,
  RemoteRepoSchema,
  RepoCheckoutStateSchema,
  RepoRescueResultSchema,
  RESCUE_BRANCH_PREFIX,
  rescueBranchName,
} from './git.js';
import { EndpointMatchSchema, GithubEventSchema, RoutineTriggerInputSchema } from './index.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('git connections and repositories', () => {
  it('names the rescue branch after the UTC minute, without a colon', () => {
    const branch = rescueBranchName(new Date('2026-11-05T10:30:59.123Z'));
    expect(branch).toBe('openbots/rescue/2026-11-05T10-30');
    expect(branch.startsWith(RESCUE_BRANCH_PREFIX)).toBe(true);
    expect(branch).not.toMatch(/[:~^?*[\\\s]/);
  });

  it('parses a connection view', () => {
    const view = {
      id: ID,
      provider: 'github',
      kind: 'app',
      installationId: '12345',
      accountLogin: 'danielpang',
      accountType: 'user',
      actAs: 'bot',
      status: 'connected',
      lastSyncedAt: '2026-11-05T10:30:00.000Z',
      repoCount: 3,
      error: null,
    };
    expect(GitConnectionViewSchema.parse(view)).toEqual(view);
    expect(() => GitConnectionViewSchema.parse({ ...view, secrets: 'x' })).toThrow();
    expect(() => GitConnectionViewSchema.parse({ ...view, provider: 'gitlab' })).toThrow();
  });

  it('parses the picker, discovery and rescue shapes', () => {
    expect(
      RemoteRepoSchema.parse({
        fullName: 'danielpang/openbots-relay',
        private: true,
        defaultBranch: 'main',
        description: null,
        pushedAt: null,
        remembered: false,
      }).fullName,
    ).toBe('danielpang/openbots-relay');
    expect(
      FoundRepoSchema.parse({
        path: '/home/bot/src/thing',
        remoteUrl: 'git@example.com:me/thing.git',
        fullName: null,
      }).fullName,
    ).toBeNull();
    expect(
      RepoRescueResultSchema.parse({
        repoId: ID,
        fullName: 'danielpang/openbots-relay',
        branch: 'openbots/rescue/2026-11-05T10-30',
        pushed: true,
        note: 'Pushed 2 commits and the uncommitted changes.',
      }).pushed,
    ).toBe(true);
  });

  it('adds updating to the Phase 1 checkout states', () => {
    expect(RepoCheckoutStateSchema.options).toEqual([
      'cloning',
      'updating',
      'ready',
      'behind',
      'dirty',
      'missing',
      'error',
    ]);
  });

  it('subscribes the App to the events Routines and connections need', () => {
    expect(GITHUB_APP_WEBHOOK_PATH).toBe('/api/v1/github/app/webhook');
    expect(GITHUB_APP_EVENTS).toContain('installation_repositories');
    // GitHub delivers installation events unasked; the manifest leaves them out.
    expect(GITHUB_APP_MANIFEST_EVENTS).not.toContain('installation');
    expect(GITHUB_APP_MANIFEST_EVENTS).not.toContain('installation_repositories');
    expect(GITHUB_APP_MANIFEST_EVENTS).toContain('pull_request');
  });

  it('matches App deliveries by installation and repository', () => {
    const match = {
      source: 'github',
      event: 'pr_opened',
      installation_id: '12345',
      repo: 'danielpang/openbots-relay',
    };
    expect(EndpointMatchSchema.parse(match)).toEqual(match);
    expect(() => EndpointMatchSchema.parse({ ...match, installation_id: 'abc' })).toThrow();
  });
});

describe('CODING_ROUTINE_TEMPLATES', () => {
  it('gives each template a valid trigger and a code_task prompt', () => {
    expect(CODING_ROUTINE_TEMPLATES.map((t) => t.id)).toEqual([
      'fix-labeled-issues',
      'review-pull-requests',
      'weekly-dependency-update',
    ]);
    for (const template of CODING_ROUTINE_TEMPLATES) {
      expect(template.prompt).toContain('code_task');
      expect(template.prompt).toContain('{{repo}}');
      const { trigger } = template;
      if (trigger.type === 'event') {
        expect(GithubEventSchema.options).toContain(trigger.event);
        const match = { source: 'github', event: trigger.event, label: trigger.label };
        expect(() =>
          RoutineTriggerInputSchema.parse({ type: 'event', source: 'github', match }),
        ).not.toThrow();
        expect(() => EndpointMatchSchema.parse(match)).not.toThrow();
        if (template.prompt.includes('{{label}}')) expect(trigger.label).toBeTruthy();
      } else {
        const { type, preset, ...rest } = trigger;
        expect(() =>
          RoutineTriggerInputSchema.parse({ type, preset: { kind: preset, ...rest } }),
        ).not.toThrow();
      }
    }
  });

  it('uses no dashes in its copy', () => {
    for (const { name, description, prompt } of CODING_ROUTINE_TEMPLATES) {
      expect(`${name} ${description} ${prompt}`).not.toMatch(new RegExp('[\\u2013\\u2014]| - '));
    }
  });
});
