import type { Session } from '../sessions/types.js';

/** Keep dynamic topic names compact even though Telegram allows more. */
export const TOPIC_TITLE_MAX = 20;

export function topicTitleBase(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine || 'New session';
}

export function modelTitle(s: Pick<Session, 'engine' | 'model'>): string {
  return s.model ?? s.engine;
}

export function buildTopicTitle(base: string, model: string): string {
  const suffix = ` · ${model}`;
  if (suffix.length >= TOPIC_TITLE_MAX) return model.slice(0, TOPIC_TITLE_MAX);
  return `${base.slice(0, TOPIC_TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
}
