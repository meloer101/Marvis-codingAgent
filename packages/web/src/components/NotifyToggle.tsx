import { useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

import { notificationsOn, setNotificationsOn } from '@/lib/attention';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';

/**
 * The bell: asks for notification permission (browsers only allow that from a
 * click), then turns notifications on and off. Hidden where the browser has
 * no notifications at all.
 */
export function NotifyToggle() {
  const [permission, setPermission] = useState(() => platform.notifyPermission());
  const [on, setOn] = useState(notificationsOn);
  if (permission === 'unsupported') return null;

  const blocked = permission === 'denied';
  const label = blocked
    ? 'Notifications are blocked in this browser’s site settings'
    : on
      ? 'Notifications on — when a session needs you or finishes while you’re away. Click to turn off.'
      : 'Notify me when a session needs me or finishes';

  const toggle = async (): Promise<void> => {
    if (permission === 'default') {
      const granted = (await platform.requestNotifyPermission()) === 'granted';
      setPermission(platform.notifyPermission());
      if (granted) setNotificationsOn(true);
      setOn(notificationsOn());
      return;
    }
    setNotificationsOn(!on);
    setOn(!on);
  };

  const Icon = on ? Bell : BellOff;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={blocked}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={cn(
        'rounded-md p-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50',
        on ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
