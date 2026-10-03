import { Monitor, Moon, Sun } from 'lucide-react';

import { footerIcon } from '@/components/Regions';
import { nextTheme, setTheme, useTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';

const ICONS: Record<Theme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Cycles system → light → dark. One button, three states, no menu. */
export function ThemeToggle() {
  const theme = useTheme();
  const Icon = ICONS[theme];
  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme(theme))}
      className={footerIcon}
      title={`Theme: ${LABELS[theme]} — click to switch`}
      aria-label={`Theme: ${LABELS[theme]}. Activate to switch.`}
    >
      <Icon />
    </button>
  );
}
