async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export const api = {
  status: () => request("/api/status"),
  windows: () => request("/api/windows"),
  providers: () => request("/api/providers"),
  parse: (sheet, timingProfile = "expressive") => request("/api/parse", { method: "POST", body: JSON.stringify({ sheet, timing_profile: timingProfile }) }),
  preview: (payload) => request("/api/preview", { method: "POST", body: JSON.stringify(payload) }),
  previewPerformance: (payload) => request("/api/preview-performance", { method: "POST", body: JSON.stringify(payload) }),
  play: (payload) => request("/api/play", { method: "POST", body: JSON.stringify(payload) }),
  playPerformance: (payload) => request("/api/play-performance", { method: "POST", body: JSON.stringify(payload) }),
  pause: () => request("/api/pause", { method: "POST", body: "{}" }),
  stop: () => request("/api/stop", { method: "POST", body: "{}" }),
  seek: (eventIndex) => request("/api/seek", { method: "POST", body: JSON.stringify({ event_index: eventIndex }) }),
  search: (query, providers = []) => {
    const params = new URLSearchParams({ q: query });
    if (providers.length) params.set("providers", providers.join(","));
    return request(`/api/search?${params}`);
  },
  importSheet: (url, provider = "") => request("/api/import", { method: "POST", body: JSON.stringify({ url, provider }) }),
  youtubeDependencies: () => request("/api/youtube/dependencies"),
  youtubeDiagnostics: (url = "") => request(`/api/youtube/diagnostics?url=${encodeURIComponent(url)}`),
  youtubeSession: () => request("/api/youtube/session"),
  saveYoutubeSession: (cookies) => request("/api/youtube/session", { method: "POST", body: JSON.stringify({ cookies }) }),
  clearYoutubeSession: () => request("/api/youtube/session/clear", { method: "POST", body: "{}" }),
  resolveMedia: (url) => request(`/api/media/resolve?url=${encodeURIComponent(url)}`),
  bestReference: (query, artist = "") => request(`/api/reference?q=${encodeURIComponent(query)}&artist=${encodeURIComponent(artist)}`),
  startYoutube: (url, access = "auto", titleHint = "", quality = "rhythm_accurate", pianoLayout = "61", engine = "auto_hifi") => {
    const resolvedAccess = access === "auto" ? "anonymous" : access;
    return request("/api/youtube", {
      method: "POST",
      body: JSON.stringify({ url, access: resolvedAccess, title_hint: titleHint, quality, piano_layout: pianoLayout, engine }),
    });
  },
  alternateSources: (query) => request(`/api/alternate-sources?q=${encodeURIComponent(query)}`),
  youtubeStatus: (job) => request(`/api/youtube/status?job=${encodeURIComponent(job)}`),
  songs: () => request("/api/songs"),
  saveSong: (payload) => request("/api/songs", { method: "POST", body: JSON.stringify(payload) }),
  updateSongIdentifiers: (id, identifiers) => request("/api/songs/identifiers", { method: "POST", body: JSON.stringify({ id, identifiers }) }),
  deleteSong: (id) => request(`/api/songs/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
