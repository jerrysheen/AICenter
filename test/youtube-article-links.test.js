import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockToSeconds,
  headingTimeHref,
  parseHeadingTimestamp,
  youtubeVideoId,
  youtubeWatchUrl,
} from '../apps/web/public/youtube-article-links.js';

test('youtube video ids come from watch, share and embed urls', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=abc_DEF-12&t=10'), 'abc_DEF-12');
  assert.equal(youtubeVideoId('https://youtu.be/abc_DEF-12?t=3'), 'abc_DEF-12');
  assert.equal(youtubeVideoId('https://m.youtube.com/embed/abc_DEF-12'), 'abc_DEF-12');
  assert.equal(youtubeVideoId('https://example.com/watch?v=abc_DEF-12'), '');
  assert.equal(youtubeVideoId(''), '');
});

test('heading clocks open the original video at that second', () => {
  assert.equal(clockToSeconds('00:12:03'), 723);
  assert.equal(clockToSeconds('1:02:03'), 3723);
  assert.equal(clockToSeconds('12:03'), 723);
  assert.equal(clockToSeconds('00:60:00'), null);
  const parsed = parseHeadingTimestamp('利率路径（00:12:03）');
  assert.equal(parsed.topic, '利率路径');
  assert.equal(parsed.seconds, 723);
  assert.equal(parsed.before, '利率路径（');
  assert.equal(parsed.after, '）');
  assert.equal(parseHeadingTimestamp('利率路径'), null);
  assert.equal(parseHeadingTimestamp('主题 (01:02:03)').seconds, 3723);
  assert.equal(
    headingTimeHref('abc_DEF-12', '利率路径（00:12:03）'),
    'https://www.youtube.com/watch?v=abc_DEF-12&t=723',
  );
  assert.equal(youtubeWatchUrl('abc_DEF-12'), 'https://www.youtube.com/watch?v=abc_DEF-12');
  assert.equal(youtubeWatchUrl('abc_DEF-12', 0), 'https://www.youtube.com/watch?v=abc_DEF-12&t=0');
  assert.equal(headingTimeHref('abc_DEF-12', '没有时间'), '');
});
