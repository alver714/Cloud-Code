import { describe, expect, it } from 'vitest';
import { hasGoalAchieved } from '../src/sessions/manager.js';
import { parseRunList } from '../src/system/ci.js';

describe('parseRunList', () => {
  it('parses the newest run from gh json output', () => {
    const json = JSON.stringify([
      {
        databaseId: 123,
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/o/r/actions/runs/123',
        displayTitle: 'Fix CI',
        headBranch: 'main',
      },
    ]);
    expect(parseRunList(json)).toEqual({
      id: 123,
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/o/r/actions/runs/123',
      title: 'Fix CI',
      branch: 'main',
    });
  });

  it('returns undefined for empty list, malformed json and null conclusion is preserved', () => {
    expect(parseRunList('[]')).toBeUndefined();
    expect(parseRunList('not json')).toBeUndefined();
    expect(
      parseRunList(JSON.stringify([{ databaseId: 5, status: 'in_progress', conclusion: '' }]))
        ?.conclusion,
    ).toBeNull();
  });
});

describe('hasGoalAchieved (markdown-tolerant)', () => {
  it('accepts plain and decorated markers', () => {
    expect(hasGoalAchieved('GOAL_ACHIEVED\nall done')).toBe(true);
    expect(hasGoalAchieved('**GOAL_ACHIEVED**\nsummary')).toBe(true);
    expect(hasGoalAchieved('# GOAL_ACHIEVED')).toBe(true);
    expect(hasGoalAchieved('✅ GOAL_ACHIEVED — goal closed')).toBe(true);
    expect(hasGoalAchieved('intro\n- GOAL_ACHIEVED')).toBe(true);
  });

  it('rejects mentions that are not the marker line', () => {
    expect(hasGoalAchieved('I have not written GOAL_ACHIEVED yet, still working')).toBe(false);
    expect(hasGoalAchieved(undefined)).toBe(false);
    expect(hasGoalAchieved('')).toBe(false);
  });
});
