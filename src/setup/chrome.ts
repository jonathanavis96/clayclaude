export interface ChromeProfile { dir: string; name: string; email?: string }

/** Profiles from Chrome's `Local State` JSON (`profile.info_cache`). `dir` is the value for `--profile-directory`. */
export function parseChromeProfiles(localState: string): ChromeProfile[] {
  let cache: Record<string, any>;
  try { cache = JSON.parse(localState)?.profile?.info_cache ?? {}; } catch { return []; }
  const rank = (d: string) => (d === 'Default' ? -1 : Number(/^Profile (\d+)$/.exec(d)?.[1] ?? 1e9));
  return Object.entries(cache)
    .filter(([dir, v]) => /^[A-Za-z0-9_ .-]{1,64}$/.test(dir) && v && typeof v === 'object')
    .map(([dir, v]) => ({
      dir,
      name: typeof v.name === 'string' && v.name ? v.name : dir,
      ...(typeof v.user_name === 'string' && v.user_name ? { email: v.user_name } : {}),
    }))
    .sort((a, b) => rank(a.dir) - rank(b.dir) || a.dir.localeCompare(b.dir));
}

export interface ChromeEnv { platform: 'wsl' | 'win32' | 'darwin' | 'linux'; home: string; winUser?: string; localAppData?: string }

/** Where `Local State` and the Chrome binary live, as paths this process can open. */
export function chromePaths(e: ChromeEnv): { localState: string[]; bin: string[] } {
  switch (e.platform) {
    case 'wsl': {
      if (!e.winUser) return { localState: [], bin: ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'] };
      const local = `/mnt/c/Users/${e.winUser}/AppData/Local/Google/Chrome`;
      return { localState: [`${local}/User Data/Local State`], bin: ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${local}/Application/chrome.exe`] };
    }
    case 'win32': {
      const local = e.localAppData ?? `${e.home}\\AppData\\Local`;
      return { localState: [`${local}\\Google\\Chrome\\User Data\\Local State`], bin: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', `${local}\\Google\\Chrome\\Application\\chrome.exe`] };
    }
    case 'darwin':
      return { localState: [`${e.home}/Library/Application Support/Google/Chrome/Local State`], bin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] };
    default:
      return { localState: [`${e.home}/.config/google-chrome/Local State`], bin: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] };
  }
}
