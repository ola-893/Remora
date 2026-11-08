// Zero duration denotes an open-ended stream. Funding and explicit closure determine access.
export function sessionExpiry(stream) {
  return stream.duration_seconds === 0 ? null : Number(stream.started_at) + stream.duration_seconds;
}

export function streamAccessReason(stream, now = Math.floor(Date.now() / 1000)) {
  if (!stream || stream.closed_at != null) return 'STREAM_CLOSED';
  const expiry = sessionExpiry(stream);
  if (expiry !== null && now >= expiry) return 'LEASE_EXPIRED';
  if (stream.duration_seconds === 0 &&
      BigInt(stream.rate) * BigInt(Math.max(0, now - Number(stream.started_at))) >= BigInt(stream.deposit)) return 'STREAM_FUNDS_EXHAUSTED';
  return null;
}
