/**
 * sse.js
 * Frameiq — Server-Sent Events manager
 *
 * Holds a Map of episodeId → Set of active SSE response objects.
 * The job runner calls emit() to push progress to all connected clients.
 */

// Map<episodeId: string, Set<res: express.Response>>
const clients = new Map();

/**
 * Register an SSE client for an episode.
 */
function subscribe(episodeId, res) {
  if (!clients.has(episodeId)) clients.set(episodeId, new Set());
  clients.get(episodeId).add(res);
}

/**
 * Remove an SSE client (on disconnect).
 */
function unsubscribe(episodeId, res) {
  const set = clients.get(episodeId);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(episodeId);
  }
}

/**
 * Emit a progress event to all clients watching an episode.
 *
 * @param {string} episodeId
 * @param {{ step, status, progress, detail, error }} payload
 */
function emit(episodeId, payload) {
  const set = clients.get(episodeId);
  if (!set || set.size === 0) return;

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch (_) {
      // Client disconnected mid-write — remove it
      set.delete(res);
    }
  }
}

/**
 * Emit a terminal event (complete / failed) and close all connections.
 */
function close(episodeId, payload) {
  emit(episodeId, { ...payload, terminal: true });
  const set = clients.get(episodeId);
  if (set) {
    for (const res of set) {
      try { res.end(); } catch (_) {}
    }
    clients.delete(episodeId);
  }
}

module.exports = { subscribe, unsubscribe, emit, close };
