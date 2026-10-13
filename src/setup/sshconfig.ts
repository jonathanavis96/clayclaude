/**
 * Concrete host aliases from one ssh config file's text (no wildcards, no negations). `Include`d files are not
 * followed: the list only suggests aliases, and setup accepts any alias typed in.
 */
export function sshAliases(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    // ssh_config allows `Host alias`, `Host=alias` and `Host = alias`.
    const m = /^\s*Host(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line.replace(/#.*$/, ''));
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h)) out.add(h);
  }
  return [...out];
}
