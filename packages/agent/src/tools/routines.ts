import { checkPreset } from '@openbots/routines';
import { SchedulePresetSchema } from '@openbots/shared';
import { validateWidgetProps } from '@openbots/widgets';
import { z } from 'zod';
import { WaitFor } from '../gated.js';
import { defineTool, type ToolGroup } from './types.js';

// Proposing a Routine from conversation (plan 10.2, R5): the Bot posts a
// "Create Routine?" widget and waits. Confirm creates the Routine on the
// server and the run resumes with `{created: true, routine_id}`; Decline
// resumes with `{created: false}`. The Bot never creates a Routine itself.

export const proposeRoutine = defineTool({
  description:
    'Offer to do something on a schedule ("want me to do this every weekday at 8?"). The owner ' +
    'sees a Create Routine card with Confirm and Decline and the run waits for the answer. Use ' +
    'it when the owner asks for recurring work or would clearly benefit from it. The prompt is ' +
    'what you will be told at each run, so make it complete on its own. Schedules: daily, ' +
    'weekdays or weekly (day 0 = Sunday) at HH:MM, monthly on a date (1 to 31 or "last"), every ' +
    'N minutes (1 to 1440), or a five-field custom cron. Leave timezone out unless the owner named one.',
  inputSchema: z.object({
    name: z.string().trim().min(1).max(120).describe('A short name, e.g. "Morning briefing"'),
    prompt: z.string().trim().min(1).max(8_000).describe('What to do at each run'),
    schedule: SchedulePresetSchema,
    timezone: z.string().min(1).max(64).optional().describe('IANA name, e.g. Europe/London'),
    reason: z.string().max(500).optional().describe('Why, in one sentence'),
  }),
  async execute({ name, prompt, schedule, timezone, reason }) {
    checkPreset(schedule);
    const props = {
      name,
      prompt,
      trigger: { type: 'schedule' as const, preset: schedule },
      ...(timezone ? { timezone } : {}),
      ...(reason ? { reason } : {}),
    };
    const checked = validateWidgetProps('routine_proposal', props);
    if (!checked.ok) throw new Error(checked.error);
    throw new WaitFor({
      reason: 'widget',
      widget: { kind: 'routine_proposal', props: checked.value },
      label: 'Waiting for you to confirm a Routine',
    });
  },
});

export const routineTools: ToolGroup = {
  name: 'conversation',
  tools: () => ({ propose_routine: proposeRoutine }),
};
