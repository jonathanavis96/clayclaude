/** The connection banner (spec §12): shown from the first paint until the first state arrives, and again after a drop. */
export type Link = 'connecting' | 'live' | 'down';

const TEXT: Record<Exclude<Link, 'live'>, string> = { connecting: 'Connecting to the daemon…', down: 'Disconnected · retrying' };

export function showLink(el: HTMLElement, link: Link): void {
  el.hidden = link === 'live';
  if (link !== 'live' && el.textContent !== TEXT[link]) el.textContent = TEXT[link];
}
