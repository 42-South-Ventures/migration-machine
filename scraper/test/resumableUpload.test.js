const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadToResumableSession } = require('../lib/resumableUpload');

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function withFile(contents, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resumable-upload-'));
  const filePath = path.join(directory, 'large.eml');
  fs.writeFileSync(filePath, contents);
  return Promise.resolve(fn(filePath)).finally(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

test('streams a file to a GCS resumable session with an exact byte range', () =>
  withFile('abcdef', async (filePath) => {
    const fetchImpl = async (_url, init) => {
      assert.equal(init.headers['Content-Length'], '6');
      assert.equal(init.headers['Content-Range'], 'bytes 0-5/6');
      assert.equal(await streamText(init.body), 'abcdef');
      return new Response('', { status: 200 });
    };

    await uploadToResumableSession({
      uploadUrl: 'https://storage.example/session',
      filePath,
      mimeType: 'message/rfc822',
      totalSize: 6,
      fetchImpl,
    });
  }));

test('queries a failed session and resumes from the accepted byte offset', () =>
  withFile('abcdef', async (filePath) => {
    let call = 0;
    const fetchImpl = async (_url, init) => {
      call++;
      if (call === 1) throw new Error('connection interrupted');
      if (call === 2) {
        assert.equal(init.headers['Content-Range'], 'bytes */6');
        return new Response('', {
          status: 308,
          headers: { Range: 'bytes=0-2' },
        });
      }
      assert.equal(init.headers['Content-Length'], '3');
      assert.equal(init.headers['Content-Range'], 'bytes 3-5/6');
      assert.equal(await streamText(init.body), 'def');
      return new Response('', { status: 200 });
    };

    await uploadToResumableSession({
      uploadUrl: 'https://storage.example/session',
      filePath,
      mimeType: 'message/rfc822',
      totalSize: 6,
      fetchImpl,
    });
    assert.equal(call, 3);
  }));
