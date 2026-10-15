import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class QueueFullError extends Error {}

/**
 * Upcoming tracks, in order. Pure in-memory state; emits 'change' after every mutation.
 *
 * Track lifecycle: pending -> downloading -> ready -> (taken by the station and played).
 * Failed downloads are removed from the queue.
 */
export class Queue extends EventEmitter {
  /** @type {Array<Track>} */
  #tracks = [];

  constructor({ maxLength }) {
    super();
    this.maxLength = maxLength;
  }

  get tracks() {
    return [...this.#tracks];
  }

  /**
   * @param {{url: string, title: string, duration: number, thumbnail?: string|null, uploader?: string|null, addedBy?: string|null}} info
   * @returns {Track}
   */
  add(info) {
    if (this.#tracks.length >= this.maxLength) {
      throw new QueueFullError(`The queue is full (${this.maxLength} tracks).`);
    }
    const track = {
      id: randomUUID(),
      url: info.url,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail ?? null,
      uploader: info.uploader ?? null,
      addedBy: info.addedBy ?? null,
      status: 'pending',
      file: null,
    };
    this.#tracks.push(track);
    this.emit('change');
    return track;
  }

  get(id) {
    return this.#tracks.find((t) => t.id === id);
  }

  /** @returns {Track|undefined} the removed track */
  remove(id) {
    const index = this.#tracks.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const [track] = this.#tracks.splice(index, 1);
    this.emit('change');
    return track;
  }

  /** First track that still needs downloading. */
  nextPending() {
    return this.#tracks.find((t) => t.status === 'pending');
  }

  hasReady() {
    return this.#tracks.some((t) => t.status === 'ready');
  }

  setStatus(id, status, file = null) {
    const track = this.get(id);
    if (!track) return undefined;
    track.status = status;
    if (file) track.file = file;
    this.emit('change');
    return track;
  }

  /**
   * Removes and returns the first downloaded track. A still-downloading track at the head
   * is skipped over so one slow download never stalls the station.
   */
  takeNextReady() {
    const index = this.#tracks.findIndex((t) => t.status === 'ready');
    if (index === -1) return undefined;
    const [track] = this.#tracks.splice(index, 1);
    this.emit('change');
    return track;
  }
}

/**
 * @typedef {object} Track
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {number} duration seconds
 * @property {string|null} thumbnail
 * @property {string|null} uploader
 * @property {string|null} addedBy
 * @property {'pending'|'downloading'|'ready'} status
 * @property {string|null} file local audio file once downloaded
 */
