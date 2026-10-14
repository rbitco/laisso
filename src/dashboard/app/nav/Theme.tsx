import { useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

export type Theme = "system" | "light" | "dark";

/** Where this browser keeps the chosen theme; index.html reads it too, so the page draws in it from the start. */
export const THEME_KEY = "lasso.theme";

const MODES: Record<Theme, { label: string; icon: LucideIcon; next: Theme }> = {
  system: { label: "System", icon: Monitor, next: "light" },
  light: { label: "Light", icon: Sun, next: "dark" },
  dark: { label: "Dark", icon: Moon, next: "system" },
};

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Sets the page's theme and keeps it in this browser; System follows the operating system's setting. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the theme still holds until the page is reloaded.
  }
}

/** The nav's theme button: each click moves System → Light → Dark → System. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  const { label, icon: Icon, next } = MODES[theme];
  const step = () => {
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button type="button" className="theme" data-role="theme" title={`Theme: ${label} (click for ${MODES[next].label})`} onClick={step}>
      <Icon aria-hidden="true" />
      <span className="sr">{`Theme: ${label}`}</span>
    </button>
  );
}
