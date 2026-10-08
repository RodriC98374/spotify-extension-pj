import type { SpotifyClient } from './client';
import type { Track } from './types';

/** Máximo que admite GET /search para apps en Development Mode. */
const SEARCH_LIMIT = 10;

export async function searchTracks(client: SpotifyClient, query: string): Promise<Track[]> {
  const result = await client.get<{ tracks?: { items: (Track | null)[] } }>('/search', {
    q: query,
    type: 'track',
    limit: SEARCH_LIMIT,
  });
  return result?.tracks?.items.filter((track): track is Track => track !== null) ?? [];
}
