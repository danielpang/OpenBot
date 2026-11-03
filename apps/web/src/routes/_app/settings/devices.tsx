import { createFileRoute } from '@tanstack/react-router';
import { DevicesSettings } from '../../../features/settings/devices.js';

// Paired phones, on every deployment (docs/MOBILE_AND_VM_PLAN.md 4.3). The
// Mac app's "Pair your phone…" opens this tab on the active connection.

export const Route = createFileRoute('/_app/settings/devices')({
  component: DevicesSettings,
});
