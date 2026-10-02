import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavHeader, WAV_HEADER_BYTES } from '../lib/wav.js';

test('wavHeader encodes a 16-bit PCM header', () => {
  const h = wavHeader({ sampleRate: 16000, channels: 2, dataBytes: 6400 });
  assert.equal(h.length, WAV_HEADER_BYTES);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), 36 + 6400);
  assert.equal(h.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(h.readUInt16LE(20), 1);
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt32LE(24), 16000);
  assert.equal(h.readUInt32LE(28), 64000);
  assert.equal(h.readUInt16LE(32), 4);
  assert.equal(h.readUInt16LE(34), 16);
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readUInt32LE(40), 6400);
});
