/**
 * Unit tests for the TVTMS versification source.
 *
 * These exercise `mapRef` DIRECTLY (no @metaxia/scriptures-core registry needed
 * at runtime) on the key value TVTMS adds over core's built-in: MT<->LXX OT
 * offsets that the built-in currently returns as identity. Each expected target
 * below was content-verified against the sibling ground-truth packages
 * (openscriptures-OHB for MT, swete-lxx for LXX).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sourceInfo } from '../src/source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = join(__dirname, '..', 'data', 'stepbible-versification', 'mapping.json');

describe('sourceInfo shape', () => {
  it('exposes the three core schemes', () => {
    expect(sourceInfo.systems).toEqual(['MT', 'LXX', 'English']);
  });
  it('registers above the built-in', () => {
    expect(sourceInfo.priority).toBe(10);
  });
  it('has the expected id', () => {
    expect(sourceInfo.id).toBe('stepbible-versification');
  });
});

describe('mapping.json data file', () => {
  it('exists', () => {
    expect(existsSync(MAPPING_PATH)).toBe(true);
  });
  it('is non-empty and covers all six scheme pairs', () => {
    const m = JSON.parse(readFileSync(MAPPING_PATH, 'utf-8')) as Record<string, unknown>;
    for (const pair of [
      'MT->LXX',
      'LXX->MT',
      'MT->English',
      'English->MT',
      'LXX->English',
      'English->LXX',
    ]) {
      expect(m[pair]).toBeDefined();
      expect(Object.keys(m[pair] as object).length).toBeGreaterThan(0);
    }
  });
});

describe('mapRef MT<->LXX offsets (the value TVTMS adds over the built-in)', () => {
  it('Genesis 32:1 MT -> LXX = 31:55 (LXX Gen 31:55 = MT 32:1, Laban blesses his sons)', () => {
    expect(sourceInfo.mapRef('Genesis', 32, 1, 'MT', 'LXX')).toEqual({ chapter: 31, verse: 55 });
  });

  it('Genesis 32:2 MT -> LXX = 32:1 (whole chapter shifts -1 after the 31:55 split)', () => {
    expect(sourceInfo.mapRef('Genesis', 32, 2, 'MT', 'LXX')).toEqual({ chapter: 32, verse: 1 });
  });

  it('Numbers 17:1 MT -> LXX = 16:36 (LXX numbers ch.16 longer)', () => {
    expect(sourceInfo.mapRef('Numbers', 17, 1, 'MT', 'LXX')).toEqual({ chapter: 16, verse: 36 });
  });

  it('Psalms 51:1 MT -> LXX = 50:1 (Psalter -1 offset; superscription verse)', () => {
    expect(sourceInfo.mapRef('Psalms', 51, 1, 'MT', 'LXX')).toEqual({ chapter: 50, verse: 1 });
  });

  it('Psalms 11:1 MT -> LXX = 10:1 (Psalter -1 offset block)', () => {
    expect(sourceInfo.mapRef('Psalms', 11, 1, 'MT', 'LXX')).toEqual({ chapter: 10, verse: 1 });
  });

  it('round-trips: LXX 31:55 -> MT 32:1', () => {
    expect(sourceInfo.mapRef('Genesis', 31, 55, 'LXX', 'MT')).toEqual({ chapter: 32, verse: 1 });
  });
});

describe('mapRef edge behavior', () => {
  it('identity passthrough for a non-divergent verse (Genesis 1:1)', () => {
    expect(sourceInfo.mapRef('Genesis', 1, 1, 'MT', 'LXX')).toEqual({ chapter: 1, verse: 1 });
  });

  it('same-scheme is identity', () => {
    expect(sourceInfo.mapRef('Isaiah', 40, 3, 'MT', 'MT')).toEqual({ chapter: 40, verse: 3 });
  });

  it('returns null when a verse has no equivalent in the target scheme', () => {
    // MT Psalm 3:1 is the Hebrew superscription, which the English KJV does not
    // number (English Psalm 3 starts at the first content verse) -> no equivalent.
    expect(sourceInfo.mapRef('Psalms', 3, 1, 'MT', 'English')).toBeNull();
  });

  it('MT->English shifts Joel: MT 3:1 -> English 2:28', () => {
    expect(sourceInfo.mapRef('Joel', 3, 1, 'MT', 'English')).toEqual({ chapter: 2, verse: 28 });
  });
});

describe('reorder-book coverage (v2 action-aware parse)', () => {
  // TVTMS $Jer.25:15-38 row: `OneToOne  Jer.25:15-38 (English) ... Jer.32:1-24 (Greek*)`
  // -> positional zip: Eng 25:15 = LXX 32:1 ... Eng 25:38 = LXX 32:24.
  it('Jeremiah reorder: English 25:15 -> LXX 32:1 (whole-block reorder zip)', () => {
    expect(sourceInfo.mapRef('Jeremiah', 25, 15, 'English', 'LXX')).toEqual({ chapter: 32, verse: 1 });
  });
  it('Jeremiah reorder: English 25:38 -> LXX 32:24 (last verse of the zipped range)', () => {
    expect(sourceInfo.mapRef('Jeremiah', 25, 38, 'English', 'LXX')).toEqual({ chapter: 32, verse: 24 });
  });
  it('Jeremiah: English 25:14 -> null (Greek column Absent on that row)', () => {
    // `OneToOne  Jer.25:14 (English) ... Absent (Greek*)` -> no LXX equivalent.
    expect(sourceInfo.mapRef('Jeremiah', 25, 14, 'English', 'LXX')).toBeNull();
  });

  // TVTMS $Exo.28:22-28:43 row: `SubdividedVerse  Exo.28:29 (Hebrew) ... Exo.28:23-25 (Greek)`.
  // One MT verse = three LXX verses. Source maps to the FIRST target; the extra
  // targets map back to the single source.
  it('SubdividedVerse: MT Exo 28:29 -> LXX 28:23 (first of the split)', () => {
    expect(sourceInfo.mapRef('Exodus', 28, 29, 'MT', 'LXX')).toEqual({ chapter: 28, verse: 23 });
  });
  it('SubdividedVerse reverse: LXX Exo 28:24 -> MT 28:29 (extra split verse maps back)', () => {
    expect(sourceInfo.mapRef('Exodus', 28, 24, 'LXX', 'MT')).toEqual({ chapter: 28, verse: 29 });
  });
  it('SubdividedVerse reverse: LXX Exo 28:25 -> MT 28:29', () => {
    expect(sourceInfo.mapRef('Exodus', 28, 25, 'LXX', 'MT')).toEqual({ chapter: 28, verse: 29 });
  });

  // TVTMS $Exo section: `MergedPrevVerse  Exo.37:5 (Hebrew) ... Absent [=Exo.38:4] (Greek)`
  // -> the verse is merged/absent in the LXX -> explicit null (not identity).
  it('MergedPrevVerse/Absent: MT Exo 37:5 -> null (merged, no distinct LXX verse)', () => {
    expect(sourceInfo.mapRef('Exodus', 37, 5, 'MT', 'LXX')).toBeNull();
  });
});

describe('honesty guard (isReliable + divergent-book identity refusal)', () => {
  it('isReliable is false for Jeremiah MT<->LXX (whole-book reorder)', () => {
    expect(sourceInfo.isReliable!('Jeremiah', 'MT', 'LXX')).toBe(false);
    expect(sourceInfo.isReliable!('Jeremiah', 'LXX', 'MT')).toBe(false);
  });
  it('isReliable is false for the other reorder books MT<->LXX', () => {
    for (const b of ['Exodus', '1 Kings', 'Joshua', 'Proverbs', 'Daniel', 'Esther']) {
      expect(sourceInfo.isReliable!(b, 'MT', 'LXX')).toBe(false);
    }
  });
  it('isReliable is true for Genesis MT<->LXX (clean chapter offsets, not a reorder book)', () => {
    expect(sourceInfo.isReliable!('Genesis', 'MT', 'LXX')).toBe(true);
  });
  it('isReliable is true for any book on the same scheme', () => {
    expect(sourceInfo.isReliable!('Jeremiah', 'MT', 'MT')).toBe(true);
  });

  it('divergent book + MT<->LXX + table-miss -> null (refuse a known-wrong identity)', () => {
    // Jeremiah 1:1 is not in the MT->LXX table; for a reorder book we must NOT
    // fall through to an identity {1,1} — return null instead.
    expect(sourceInfo.mapRef('Jeremiah', 1, 1, 'MT', 'LXX')).toBeNull();
  });
  it('non-divergent book table-miss still returns identity (Genesis 1:1 MT->LXX)', () => {
    expect(sourceInfo.mapRef('Genesis', 1, 1, 'MT', 'LXX')).toEqual({ chapter: 1, verse: 1 });
  });
});
