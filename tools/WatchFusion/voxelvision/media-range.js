import fs from 'node:fs';

export function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start < size && start <= end ? { start, end } : null;
}

/** Cancel only the disconnected request's file stream. */
export function streamMedia(req, res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  const cancel = () => stream.destroy();
  req.once('aborted', cancel);
  res.once('close', cancel);
  stream.once('error', error => { if (!res.destroyed) res.destroy(error); });
  stream.once('close', () => {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
  });
  stream.pipe(res);
}
