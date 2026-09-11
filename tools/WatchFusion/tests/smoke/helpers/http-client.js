import http from 'node:http';

export function request(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const headers = { ...(options.headers || {}) };
    let body = options.body;

    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['content-type']) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
    }

    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, res => {
      let resBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { resBody += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(resBody);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: resBody,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function createRoom(baseUrl, roomId, payload = {}) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/create`, {
    method: 'POST',
    body: payload
  });
}

export async function joinRoom(baseUrl, roomId, payload = {}) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: payload
  });
}

export async function getRoom(baseUrl, roomId) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}`);
}

export async function sendCommand(baseUrl, roomId, memberId, command) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/command`, {
    method: 'POST',
    headers: { 'x-member-id': memberId },
    body: command
  });
}

export async function pingMember(baseUrl, roomId, memberId) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/ping`, {
    method: 'POST',
    headers: { 'x-member-id': memberId }
  });
}

export async function leaveRoom(baseUrl, roomId, memberId) {
  return request(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    headers: { 'x-member-id': memberId }
  });
}

export function openSseStream(baseUrl, roomId, memberId, onMessage) {
  const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/events?memberId=${encodeURIComponent(memberId)}`, baseUrl);
  const req = http.get(url, res => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';
      for (const block of lines) {
        if (block.startsWith('data: ')) {
          try {
            const data = JSON.parse(block.slice(6));
            onMessage(data);
          } catch {}
        }
      }
    });
  });

  return {
    close() {
      req.destroy();
    }
  };
}
