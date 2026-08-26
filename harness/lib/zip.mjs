// Minimal zip central-directory reader (enough to validate a .pptx without a dependency).
export function zipEntries(buf) {
  if (buf.length < 22) throw new Error('not a zip: too small');
  let i = buf.length - 22;
  const stop = Math.max(0, buf.length - 65557);
  for (; i >= stop; i--) if (buf.readUInt32LE(i) === 0x06054b50) break;
  if (i < stop) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip: bad central directory entry');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
