/**
 * Thin client for the public NHL web API (https://api-web.nhle.com/v1).
 * No auth required. Throws NhlError on transport/API problems so callers
 * can decide whether to retry, skip a game, or abort a poll cycle.
 */

export class NhlError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'NhlError';
    this.status = status;
  }
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nhl-goal-bot/2.0',
      },
    });
  } catch (err) {
    throw new NhlError(`Network error fetching ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new NhlError(`NHL API error ${res.status} for ${url}`, { status: res.status });
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new NhlError(`Unexpected content-type "${contentType}" for ${url}`);
  }
  return res.json();
}

export class NhlClient {
  constructor(baseUrl = 'https://api-web.nhle.com/v1') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Weekly schedule view; /schedule/now redirects to the current week. */
  async getSchedule() {
    return fetchJson(`${this.baseUrl}/schedule/now`);
  }

  /** Ids of games currently in progress. */
  liveGameIds(schedule) {
    const weeks = schedule?.gameWeek ?? [];
    return weeks.flatMap((week) =>
      (week.games ?? [])
        .filter((game) => game.gameState === 'LIVE')
        .map((game) => game.id),
    );
  }

  /** Full play-by-play for one game, validated to have a plays array. */
  async getPlayByPlay(gameId) {
    const data = await fetchJson(`${this.baseUrl}/gamecenter/${gameId}/play-by-play`);
    if (!data?.plays || !Array.isArray(data.plays)) {
      throw new NhlError(`Invalid play-by-play structure for game ${gameId}`);
    }
    return data;
  }
}
