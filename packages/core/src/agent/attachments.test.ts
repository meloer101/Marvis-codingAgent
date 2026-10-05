import { describe, expect, it } from 'vitest';

import { joinMessages, shiftImageMarkers } from './attachments.js';

describe('image markers across joined messages', () => {
  it('numbers a later message’s markers after the images before it, leaving code alone', () => {
    expect(shiftImageMarkers('see [Image #1]\n\n```\n[Image #1]\n```\n\n[Image #2]', 2)).toBe(
      'see [Image #3]\n\n```\n[Image #1]\n```\n\n[Image #4]',
    );
    expect(shiftImageMarkers('[Image #1]', 0)).toBe('[Image #1]');
  });

  it('joins messages a blank line apart, each pointing at its own images', () => {
    expect(
      joinMessages([
        { text: 'first [Image #1]', images: [{}] },
        { text: 'no images' },
        { text: 'second [Image #1] and [Image #2]', images: [{}, {}] },
      ]),
    ).toBe('first [Image #1]\n\nno images\n\nsecond [Image #2] and [Image #3]');
  });
});
