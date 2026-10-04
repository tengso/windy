import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSegmenter } from '../public/transcriber.js';

test('segmenter timestamps continue from startAt', () => {
  const sampleRate = 16000;
  const segments = [];
  const seg = createSegmenter({ sampleRate, startAt: 13, onSpeaking: () => {}, onSegment: s => segments.push(s) });
  const batch = n => Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(i / 5));
  seg.push(new Float32Array(1600));
  for (let i = 0; i < 5; i++) seg.push(batch(1600));
  for (let i = 0; i < 8; i++) seg.push(new Float32Array(1600));
  assert.equal(segments.length, 1);
  assert.ok(segments[0].start >= 13 && segments[0].start < 13.2, `start ${segments[0].start}`);
});
