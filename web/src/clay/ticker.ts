import { FrameGate } from './timeline.js';

type Fn = (now: number) => void;

/**
 * The one requestAnimationFrame loop every character shares. It runs only while something is
 * subscribed and the page is visible, and lets ticks through at the frame-rate cap.
 */
export class Ticker {
  private subs = new Set<Fn>();
  private raf = 0;
  private gate: FrameGate;
  private onVis = () => this.wake();

  constructor(cap: number, private doc: Document = document) {
    this.gate = new FrameGate(cap);
    doc.addEventListener('visibilitychange', this.onVis);
  }

  setCap(cap: number): void { this.gate.setCap(cap); }

  add(fn: Fn): () => void {
    this.subs.add(fn);
    this.wake();
    return () => { this.subs.delete(fn); if (!this.subs.size) this.sleep(); };
  }

  get running(): boolean { return this.raf !== 0; }

  private wake(): void {
    if (this.doc.hidden) { this.sleep(); return; }
    if (this.raf || !this.subs.size) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private sleep(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.doc.hidden || !this.subs.size) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.gate.pass(now)) return;
    for (const fn of this.subs) {
      try { fn(now); } catch (e) { console.error('clay tick failed', e); }
    }
  };

  dispose(): void {
    this.sleep();
    this.subs.clear();
    this.doc.removeEventListener('visibilitychange', this.onVis);
  }
}
