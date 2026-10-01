// Small, device-local UI preferences. These are intentionally not part of
// StorageAdapter: they describe this browser's UI, not the user's data, and
// aren't stored on the server.

export type ThemeName = "light" | "dark";

export interface Prefs {
  lastActivePageId: string | null;
  sidebarCollapsed: boolean;
  theme: ThemeName;
}

const KEY = "meadowlark:prefs";

export function isNarrowScreen(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches;
}

function defaultTheme(): ThemeName {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function defaults(): Prefs {
  return { lastActivePageId: null, sidebarCollapsed: isNarrowScreen(), theme: defaultTheme() };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults(), ...(JSON.parse(raw) as Partial<Prefs>) } : defaults();
  } catch {
    return defaults();
  }
}

export function savePrefs(patch: Partial<Prefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Storage unavailable (private mode etc.). Preferences just won't stick.
  }
}
