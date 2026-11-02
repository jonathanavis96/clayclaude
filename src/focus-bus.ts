import { EventEmitter } from 'node:events';

/**
 * Asks every connected board to open one session's focus view (the voice layer: a voice assistant opens the session a
 * spoken command was about). The action service raises it after checking the session is listed; the server pushes it to
 * each board as `{ type: 'focus', sessionId }`. Nothing is stored: a board that connects later never sees an old request.
 */
export class FocusBus extends EventEmitter {
  request(sessionId: string): void { this.emit('focus', sessionId); }
}
