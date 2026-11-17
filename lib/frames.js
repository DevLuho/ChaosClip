function frameTime(info, index) {
  if (!info.frameTimes) return index / info.fps;
  if (index < info.frameTimes.length) return info.frameTimes[Math.max(0, index)];
  const last = info.frameTimes.at(-1);
  return Math.max(info.duration, last + 1 / info.fps);
}

function frameAt(info, time) {
  if (!info.frameTimes) return Math.floor(time * info.fps + 1e-4);
  let start = 0;
  let end = info.frameTimes.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (frameTime(info, mid) <= time + 1e-5) start = mid + 1;
    else end = mid;
  }
  return Math.max(0, start - 1);
}

function seekTime(info, index) {
  if (!info.frameTimes) return Math.max(0, (index - 0.25) / info.fps);
  const time = frameTime(info, index);
  return Math.max(0, time - (time - frameTime(info, index - 1)) / 4);
}

module.exports = { frameTime, frameAt, seekTime };
