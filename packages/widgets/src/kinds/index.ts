import { approvalWidget } from './approval.js';
import { artifactWidget } from './artifact.js';
import { chartWidget } from './chart.js';
import { emailDraftWidget } from './email_draft.js';
import { eventWidget } from './event.js';
import { fileWidget } from './file.js';
import { formWidget } from './form.js';
import { loginRequestWidget } from './login_request.js';
import { questionWidget } from './question.js';
import { routineCreatedWidget } from './routine_created.js';
import { routineProposalWidget } from './routine_proposal.js';
import { routineRunWidget } from './routine_run.js';
import { skillDraftWidget } from './skill_draft.js';
import { statusSummaryWidget } from './status_summary.js';
import { tableWidget } from './table.js';
import type { WidgetKind } from './types.js';

// The widget registry (plan 12.2): one file per kind in this directory, one
// entry per kind here. Kinds still `null` are registration points that later
// leaves fill by adding `kinds/<kind>.ts` and replacing `null` with its export;
// the map's keys and shape stay as they are.

export const WIDGET_KIND_NAMES = [
  'approval',
  'question',
  'email_draft',
  'form',
  'table',
  'chart',
  'status_summary',
  'event',
  'routine_proposal',
  'routine_created',
  'routine_run',
  'skill_draft',
  'artifact',
  'file',
  'login_request',
] as const;

export type WidgetKindName = (typeof WIDGET_KIND_NAMES)[number];

export const WIDGET_KINDS: Record<WidgetKindName, WidgetKind | null> = {
  approval: approvalWidget as WidgetKind,
  question: questionWidget as WidgetKind,
  email_draft: emailDraftWidget as WidgetKind,
  form: formWidget as WidgetKind,
  table: tableWidget as WidgetKind,
  chart: chartWidget as WidgetKind,
  status_summary: statusSummaryWidget as WidgetKind,
  event: eventWidget as WidgetKind,
  routine_proposal: routineProposalWidget as WidgetKind,
  routine_created: routineCreatedWidget as WidgetKind,
  routine_run: routineRunWidget as WidgetKind,
  skill_draft: skillDraftWidget as WidgetKind,
  artifact: artifactWidget as WidgetKind,
  file: fileWidget as WidgetKind,
  login_request: loginRequestWidget as WidgetKind,
};

export type { WidgetKind } from './types.js';
export { defineWidget, invalidAction } from './types.js';
export * from './approval.js';
export * from './artifact.js';
export * from './chart.js';
export * from './email_draft.js';
export * from './event.js';
export * from './file.js';
export * from './form.js';
export * from './login_request.js';
export * from './question.js';
export * from './routine_created.js';
export * from './routine_proposal.js';
export * from './routine_run.js';
export * from './skill_draft.js';
export * from './status_summary.js';
export * from './table.js';
