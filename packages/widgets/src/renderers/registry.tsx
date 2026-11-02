import type { WidgetKindName } from '../kinds/index.js';
import { validateWidgetProps } from '../registry.js';
import { ApprovalWidget } from './approval.js';
import { ArtifactWidget } from './artifact.js';
import { ChartWidget } from './chart.js';
import { EmailDraftWidget } from './email_draft.js';
import { EventWidget } from './event.js';
import { FileWidget } from './file.js';
import { FormWidget } from './form.js';
import { LoginRequestWidget } from './login_request.js';
import { QuestionWidget } from './question.js';
import { RoutineCreatedWidget } from './routine_created.js';
import { RoutineProposalWidget } from './routine_proposal.js';
import { RoutineRunWidget } from './routine_run.js';
import { SkillDraftWidget } from './skill_draft.js';
import { StatusSummaryWidget } from './status_summary.js';
import { TableWidget } from './table.js';
import type { WidgetRenderer, WidgetRendererProps } from './types.js';
import { UnknownWidget } from './unknown.js';

// Renderers keyed by kind (plan 12.2, the W4 extension point later). Like
// `WIDGET_KINDS`, kinds still `null` are registration points: a later leaf
// adds `renderers/<kind>.tsx` and replaces its `null`; everything else here
// stays as it is. A kind without a renderer shows the "unknown widget" line.

export const WIDGET_RENDERERS: Record<WidgetKindName, WidgetRenderer | null> = {
  approval: ApprovalWidget as WidgetRenderer,
  question: QuestionWidget as WidgetRenderer,
  email_draft: EmailDraftWidget as WidgetRenderer,
  form: FormWidget as WidgetRenderer,
  table: TableWidget as WidgetRenderer,
  chart: ChartWidget as WidgetRenderer,
  status_summary: StatusSummaryWidget as WidgetRenderer,
  event: EventWidget as WidgetRenderer,
  routine_proposal: RoutineProposalWidget as WidgetRenderer,
  routine_created: RoutineCreatedWidget as WidgetRenderer,
  routine_run: RoutineRunWidget as WidgetRenderer,
  skill_draft: SkillDraftWidget as WidgetRenderer,
  artifact: ArtifactWidget as WidgetRenderer,
  file: FileWidget as WidgetRenderer,
  login_request: LoginRequestWidget as WidgetRenderer,
};

export function widgetRenderer(kind: string): WidgetRenderer | null {
  return Object.hasOwn(WIDGET_RENDERERS, kind)
    ? (WIDGET_RENDERERS[kind as WidgetKindName] ?? null)
    : null;
}

/** Renders a widget part by kind, falling back for unknown kinds and invalid props. */
export function Widget({ kind, props, ...rest }: WidgetRendererProps & { kind: string }) {
  const Renderer = widgetRenderer(kind);
  const checked = Renderer ? validateWidgetProps(kind, props) : null;
  if (!Renderer || !checked?.ok) return <UnknownWidget kind={kind} />;
  return <Renderer props={checked.value} {...rest} />;
}
