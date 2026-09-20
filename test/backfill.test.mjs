import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalPost, seedStoreFromFeed, fetchRecentPosts } from '../src/backfill.mjs';
import { formatGoalMessage, isSameGoal } from '../src/goals.mjs';

const POST_WITH_ASSISTS = `GOAL! 🚨
TOR vs. MTL
Juraj Slafkovský (#20) (MTL) is the scorer!
Assists: Ivan Demidov (#93)
Time: 04:27 - 1
Score: 0 - 1`;

const POST_NO_NUMBER = `GOAL! 🚨
EDM vs. CGY
Connor McDavid (EDM) is the scorer!
Time: 12:00 - OT
Score: 3 - 4`;

describe('parseGoalPost', () => {
  it('parses a goal post with assists', () => {
    assert.deepEqual(parseGoalPost(POST_WITH_ASSISTS), {
      away: 'TOR',
      home: 'MTL',
      scorer: 'Juraj Slafkovský (#20)',
      time: '04:27',
      period: 1,
      awayScore: 0,
      homeScore: 1,
    });
  });

  it('parses a post without a sweater number and an OT period', () => {
    assert.deepEqual(parseGoalPost(POST_NO_NUMBER), {
      away: 'EDM',
      home: 'CGY',
      scorer: 'Connor McDavid',
      time: '12:00',
      period: 'OT',
      awayScore: 3,
      homeScore: 4,
    });
  });

  it('round-trips formatGoalMessage output back to the same goal', () => {
    const goal = {
      eventId: 101,
      scorer: 'Arttu Hyry (#25)',
      assists: 'Miro Heiskanen (#4)',
      time: '00:16',
      period: 1,
      team: 'DAL',
      score: '1 - 0',
      awayScore: 1,
      homeScore: 0,
    };
    const parsed = parseGoalPost(formatGoalMessage(goal, { away: 'DAL', home: 'STL' }));
    assert.ok(parsed, 'expected the formatted message to parse');
    assert.ok(isSameGoal(goal, parsed), 'parsed post should fuzzy-match the original goal');
  });

  it('returns null for correction posts and other text', () => {
    assert.equal(parseGoalPost('CORRECTION: Goal now credited to X (previously Y)\nTOR vs. MTL'), null);
    assert.equal(parseGoalPost('just a regular post'), null);
    assert.equal(parseGoalPost(''), null);
  });
});

describe('fetchRecentPosts', () => {
  it('returns top-level post texts, skipping replies', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        feed: [
          { post: { record: { text: 'goal post' } } },
          { post: { record: { text: 'a reply', reply: { parent: {} } } } },
        ],
      }),
    });
    assert.deepEqual(await fetchRecentPosts('someone.bsky.social', fetchFn), ['goal post']);
  });

  it('throws on HTTP errors', async () => {
    const fetchFn = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => fetchRecentPosts('someone.bsky.social', fetchFn), /HTTP 500/);
  });
});

describe('seedStoreFromFeed', () => {
  const makeStore = () => {
    const map = new Map();
    return {
      has: (k) => map.has(k),
      set: (k, v) => map.set(k, v),
      get: (k) => map.get(k),
    };
  };

  const goal = (eventId, scorer, time) => ({
    eventId,
    scorer,
    assists: '',
    time,
    period: 1,
    team: 'DAL',
    score: '1 - 0',
    awayScore: 1,
    homeScore: 0,
  });

  const feedWith = (texts) => async () => ({
    ok: true,
    json: async () => ({ feed: texts.map((text) => ({ post: { record: { text } } })) }),
  });

  it('marks posted goals from live games, ignoring unposted ones', async () => {
    const store = makeStore();
    const getGames = async () => [
      {
        gameId: 2026020011,
        teams: { away: 'DAL', home: 'STL' },
        goals: [goal(101, 'Arttu Hyry (#25)', '00:16'), goal(102, 'Roope Hintz (#24)', '05:00')],
      },
    ];
    const posted = `GOAL! 🚨\nDAL vs. STL\nArttu Hyry (#25) (DAL) is the scorer!\nTime: 00:16 - 1\nScore: 1 - 0`;
    const seeded = await seedStoreFromFeed({
      store,
      actor: 'nhl-goal-bot.bsky.social',
      getGames,
      fetchFn: feedWith([posted]),
    });
    assert.equal(seeded, 1);
    const record = store.get('2026020011:101');
    assert.ok(record, 'expected the posted goal to be seeded');
    assert.equal(record.posted, true);
    assert.equal(record.updateCount, 0);
    assert.equal(store.get('2026020011:102'), undefined);
  });

  it('seeds nothing when the feed has no goal posts', async () => {
    const store = makeStore();
    const seeded = await seedStoreFromFeed({
      store,
      actor: 'nhl-goal-bot.bsky.social',
      getGames: async () => [],
      fetchFn: feedWith(['hello world']),
    });
    assert.equal(seeded, 0);
  });

  it('does not overwrite goals already in the store', async () => {
    const store = makeStore();
    store.set('2026020011:101', { posted: false, sentinel: true });
    const getGames = async () => [
      {
        gameId: 2026020011,
        teams: { away: 'DAL', home: 'STL' },
        goals: [goal(101, 'Arttu Hyry (#25)', '00:16')],
      },
    ];
    const posted = `GOAL! 🚨\nDAL vs. STL\nArttu Hyry (#25) (DAL) is the scorer!\nTime: 00:16 - 1\nScore: 1 - 0`;
    const seeded = await seedStoreFromFeed({
      store,
      actor: 'nhl-goal-bot.bsky.social',
      getGames,
      fetchFn: feedWith([posted]),
    });
    assert.equal(seeded, 0);
    assert.equal(store.get('2026020011:101').sentinel, true);
  });
});
