import type { ReactNode } from 'react';

// The contract every widget renderer implements (plan 12.2, W2). A renderer
// draws a kind's props and current state; interactive kinds post actions
// through `onAction`, which the app wires to
// `POST /api/v1/messages/{id}/widgets/{part}/action`.

export interface WidgetRendererProps<Props = unknown, State = unknown> {
  props: Props;
  /** The stored state, kept current by the transcript from `widget.updated`. */
  state?: State;
  /**
   * Posts an action and resolves with the widget's next state; rejects with
   * an Error whose message is shown. Absent where the widget is read only.
   */
  onAction?: (action: unknown) => Promise<unknown>;
  /** Where a file id is served; defaults to `/api/v1/files/{id}`. */
  fileUrl?: (fileId: string) => string;
  /** Opens the thread under the widget's message; absent where there are no threads. */
  onReply?: () => void;
  /** Opens an Artifact in the viewer (the `artifact` kind); absent where there is no viewer. */
  onOpenArtifact?: (artifactId: string, version?: number) => void;
  /** Opens a run's activity log (the `routine_run` kind); absent where there is none. */
  onOpenActivity?: (runId: string) => void;
  /** Goes to an in-app path (`/bots/<id>/routines`) without a page load. */
  onNavigate?: (href: string) => void;
  /**
   * Opens Takeover on a Bot's screen (the `login_request` kind), its browser
   * on `url` first when given; absent where there is no computer view.
   */
  onTakeover?: (botId: string, url?: string) => void;
}

export type WidgetRenderer<Props = unknown, State = unknown> = (
  props: WidgetRendererProps<Props, State>,
) => ReactNode;

export const defaultFileUrl = (fileId: string) => `/api/v1/files/${encodeURIComponent(fileId)}`;
