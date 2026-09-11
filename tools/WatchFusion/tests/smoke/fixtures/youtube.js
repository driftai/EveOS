/**
 * Deterministic YouTube URL fixtures and sample payloads
 * Used across Node, Playwright, and integration smoke tests.
 */

export const YOUTUBE_FIXTURES = {
  valid: [
    {
      type: 'watch',
      input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'watch-with-params',
      input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=shared',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'short-url',
      input: 'https://youtu.be/dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'short-url-with-param',
      input: 'https://youtu.be/dQw4w9WgXcQ?t=15',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'shorts',
      input: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'embed',
      input: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'live',
      input: 'https://www.youtube.com/live/dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'raw-id',
      input: 'dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    },
    {
      type: 'no-protocol',
      input: 'youtube.com/watch?v=dQw4w9WgXcQ',
      expectedId: 'dQw4w9WgXcQ'
    }
  ],
  invalid: [
    '',
    '   ',
    'not-a-url',
    'https://example.com/video',
    'https://youtube.com/watch?x=123',
    'https://vimeo.com/123456789',
    '12345', // too short
    'dQw4w9WgXcQextra' // too long
  ]
};

export const MOCK_ROOM_CONFIG = {
  defaultRoomNumber: '888',
  defaultHostName: 'HostAlice',
  defaultViewerName: 'ViewerBob',
  testVideoId: 'dQw4w9WgXcQ'
};
