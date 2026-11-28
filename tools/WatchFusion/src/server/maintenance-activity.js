// Aggregate only: never expose room identities, chat, session data or media URLs.
export function summarizeRoomActivity(values) {
  const counts = { rooms: 0, occupied: 0, retainedEmpty: 0, members: 0, streams: 0, playing: 0 };
  for (const room of values) {
    counts.rooms++;
    const members = room.members.size, streams = room.streams.size;
    counts.members += members; counts.streams += streams;
    if (members || streams) {
      counts.occupied++;
      if (room.playback.paused === false && room.playback.ended === false) counts.playing++;
    } else counts.retainedEmpty++;
  }
  return counts;
}
