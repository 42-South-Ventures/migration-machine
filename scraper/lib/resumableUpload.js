const fs = require('fs');

function uploadedByteCount(response) {
  const range = response.headers.get('range');
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : 0;
}

async function queryResumableUpload(uploadUrl, totalSize, fetchImpl = fetch) {
  const response = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalSize}`,
    },
    redirect: 'manual',
  });
  if (response.ok) return totalSize;
  if (response.status === 308) return uploadedByteCount(response);
  const body = await response.text().catch(() => '');
  throw new Error(
    `GCS upload status failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
  );
}

async function uploadToResumableSession({
  uploadUrl,
  filePath,
  mimeType,
  totalSize,
  fetchImpl = fetch,
  createReadStream = fs.createReadStream,
}) {
  if (totalSize <= 0) throw new Error('Direct upload requires a non-empty file');

  let offset = 0;
  for (let attempt = 1; attempt <= 5 && offset < totalSize; attempt++) {
    const stream = createReadStream(filePath, { start: offset });
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(totalSize - offset),
          'Content-Range': `bytes ${offset}-${totalSize - 1}/${totalSize}`,
        },
        body: stream,
        duplex: 'half',
        redirect: 'manual',
      });
      if (response.ok) return;
      if (response.status === 308) {
        offset = uploadedByteCount(response);
        continue;
      }
      const body = await response.text().catch(() => '');
      throw new Error(
        `GCS direct upload failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
      );
    } catch (error) {
      stream.destroy();
      if (attempt === 5) throw error;
      offset = await queryResumableUpload(uploadUrl, totalSize, fetchImpl);
      if (offset === totalSize) return;
    }
  }
}

module.exports = {
  uploadedByteCount,
  queryResumableUpload,
  uploadToResumableSession,
};
