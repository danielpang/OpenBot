// React entry: `@openbots/widgets/react`. Kept apart from the main entry so
// the server can import the kind schemas without React.

export {
  ApprovalWidget,
  decisionText,
  traceInWords,
  type ApprovalWidgetState,
} from './renderers/approval.js';
export {
  ARTIFACT_KIND_LABELS,
  ArtifactCard,
  ArtifactKindIcon,
  ArtifactWidget,
  defaultArtifactDownloadUrl,
  type ArtifactCardState,
} from './renderers/artifact.js';
export { chartTable, ChartWidget, niceTicks } from './renderers/chart.js';
export { addressList, EmailDraftWidget } from './renderers/email_draft.js';
export { EventRow, EventWidget, type EventRowProps } from './renderers/event.js';
export { FileCard, FileWidget, formatBytes } from './renderers/file.js';
export { formValues, FormWidget } from './renderers/form.js';
export { LoginRequestWidget } from './renderers/login_request.js';
export { QuestionWidget } from './renderers/question.js';
export { RoutineCreatedWidget } from './renderers/routine_created.js';
export { browserTimezone, RoutineProposalWidget } from './renderers/routine_proposal.js';
export { runDuration, RoutineRunWidget } from './renderers/routine_run.js';
export { SkillDraftWidget } from './renderers/skill_draft.js';
export { STATUS_WORDS, StatusSummaryWidget } from './renderers/status_summary.js';
export { csvHref, csvName, DataTable, sortRows, TableWidget, toCsv } from './renderers/table.js';
export { Widget, WIDGET_RENDERERS, widgetRenderer } from './renderers/registry.js';
export {
  defaultFileUrl,
  type WidgetRenderer,
  type WidgetRendererProps,
} from './renderers/types.js';
export { UnknownWidget } from './renderers/unknown.js';
