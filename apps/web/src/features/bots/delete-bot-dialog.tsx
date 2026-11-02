import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@openbots/ui';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useBotActions, type Bot } from './queries.js';

// Delete removes the profile, the conversation and the Routines (B7); the
// dialog recommends hiding instead, which keeps everything.

export function DeleteBotDialog({ bot, onClose }: { bot: Bot | null; onClose(): void }) {
  const { toggle, remove } = useBotActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const leaveIfOpen = (id: string) => {
    if (params.botId === id) void navigate({ to: '/' });
  };

  return (
    <Dialog open={bot !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {bot?.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes its profile, conversation and Routines.
          </DialogDescription>
        </DialogHeader>
        {remove.error && <p className="text-sm text-destructive">{remove.error.message}</p>}
        <DialogFooter>
          {bot && !bot.hidden && (
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() =>
                toggle.mutate({ id: bot.id, action: 'hide' }, { onSuccess: () => onClose() })
              }
            >
              Hide instead
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              bot &&
              remove.mutate(bot.id, {
                onSuccess: () => {
                  leaveIfOpen(bot.id);
                  onClose();
                },
              })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
