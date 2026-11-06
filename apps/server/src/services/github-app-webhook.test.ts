import { CODING_ROUTINE_TEMPLATES, RoutineTriggerInputSchema } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { parseTriggerRule } from '../hooks/match.js';
import { installationNote, installationStatus } from './github-app-webhook.js';
import { codingTemplate, routineFromTemplate } from './routines.js';

// The pure parts of the App webhook and the coding templates (I19, CA11).
// The delivery pipeline end to end is routes/github-app-webhook.test.ts.

describe('installation actions', () => {
  it('maps removal, suspension and its end to a connection status', () => {
    expect(installationStatus('deleted')).toBe('revoked');
    expect(installationStatus('suspend')).toBe('needs_reinstall');
    expect(installationStatus('unsuspend')).toBe('connected');
    expect(installationStatus('created')).toBeNull();
    expect(installationStatus('new_permissions_accepted')).toBeNull();
    expect(installationStatus(undefined)).toBeNull();
    expect(installationNote('deleted')).toBe('The installation was removed on GitHub');
    expect(installationNote('suspend')).toBe('GitHub suspended the installation');
    expect(installationNote('unsuspend')).toBeNull();
  });
});

describe('routineFromTemplate', () => {
  it('fills the repository, the label and the installation into an event trigger', () => {
    const made = routineFromTemplate(
      codingTemplate('fix-labeled-issues'),
      { repo: 'acme/api' },
      '42',
    );
    expect(made.trigger).toEqual({
      type: 'event',
      source: 'github',
      match: { event: 'label_added', repo: 'acme/api', label: 'bot', installation_id: '42' },
    });
    expect(made.name).toBe('Fix issues labeled bot (acme/api)');
    expect(made.prompt).toContain('An issue in acme/api was labeled bot.');
    expect(made.prompt).not.toMatch(/\{\{/);
  });

  it('takes the owner label and leaves the installation out without a connection', () => {
    const made = routineFromTemplate(codingTemplate('fix-labeled-issues'), {
      repo: 'acme/web',
      label: 'needs-fix',
    });
    expect(made.trigger).toEqual({
      type: 'event',
      source: 'github',
      match: { event: 'label_added', repo: 'acme/web', label: 'needs-fix' },
    });
    expect(made.name).toBe('Fix issues labeled needs-fix (acme/web)');
    expect(made.prompt).toContain('labeled needs-fix');
  });

  it('turns the weekly template into a schedule preset', () => {
    const made = routineFromTemplate(
      codingTemplate('weekly-dependency-update'),
      { repo: 'acme/api', label: 'ignored' },
      '42',
    );
    expect(made.trigger).toEqual({
      type: 'schedule',
      preset: { kind: 'weekly', day: 1, time: '09:00' },
    });
    expect(made.prompt).toContain('code_task in pr mode on acme/api');
  });

  it('makes a valid trigger from every template', () => {
    for (const template of CODING_ROUTINE_TEMPLATES) {
      const { trigger } = routineFromTemplate(template, { repo: 'acme/api' }, '7');
      const parsed = RoutineTriggerInputSchema.parse(trigger);
      if (parsed.type === 'event') expect(parseTriggerRule(parsed).success).toBe(true);
    }
  });

  it('refuses an unknown template', () => {
    expect(() => codingTemplate('nope')).toThrow(/No Routine template/);
  });
});
