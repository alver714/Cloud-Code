import { describe, expect, it } from 'vitest';
import { buildTopicTitle, modelTitle, topicTitleBase, TOPIC_TITLE_MAX } from '../src/bot/topic-title.js';

describe('dynamic topic titles', () => {
  it('uses a normalized first prompt and the selected model', () => {
    const base = topicTitleBase('  Fix the\n login   form  ');
    expect(buildTopicTitle(base, 'fable')).toBe('Fix the logi · fable');
  });

  it('uses the engine when the model is the CLI default', () => {
    expect(modelTitle({ engine: 'claude' })).toBe('claude');
  });

  it('preserves the model suffix within the compact 20 character limit', () => {
    const title = buildTopicTitle('x'.repeat(200), 'fable');
    expect(title.length).toBe(TOPIC_TITLE_MAX);
    expect(title.endsWith(' · fable')).toBe(true);
  });
});
