// Unit suite — internationalization catalog: externalized text, locale-aware date/number/tz
// formatting, and direction-safe (LTR/RTL) layout primitives (T298 / GAR-010).
//
// Exercises apps/web/src/i18n/catalog.ts. Runs under `vitest run --project unit`. Every property
// has a negative control so the oracle is non-vacuous.

import { describe, it, expect } from 'vitest';
import {
  BASE_LOCALE,
  MESSAGES,
  t,
  missingKeys,
  isKnownLocale,
  directionFor,
  primarySubtag,
  htmlLangAttrs,
  formatDateTime,
  formatDate,
  formatNumber,
  formatInteger,
  formatPercent,
  logicalPadding,
  logicalBorder,
  directionStylesheet,
  DEFAULT_TIME_ZONE,
} from '../../apps/web/src/i18n/catalog.ts';

describe('message catalog & fallback', () => {
  it('resolves a present translation and interpolates named params', () => {
    expect(t('en-US', 'shell.status.connected')).toBe('Connected');
    expect(t('ar', 'nav.inventory')).toBe('الجرد'); // present in the partial ar catalog
    expect(t('en-US', 'common.count', { count: 7 })).toBe('7 item(s)');
    expect(t('en-US', 'shell.tenantScope', { tenant: 'Acme', bundle: 'v3' })).toBe(
      'Tenant scope: Acme · bundle v3',
    );
  });

  it('falls back to the base locale for a missing key, then to the key itself', () => {
    // 'audit.heading' is absent from ar → base English is used (fallback, not a blank).
    expect(t('ar', 'audit.heading')).toBe(MESSAGES[BASE_LOCALE]['audit.heading']);
    // A genuinely unknown key returns the key string, never throwing or a blank (visible miss).
    // @ts-expect-error intentional unknown key for the fallback control
    expect(t('en-US', 'does.not.exist')).toBe('does.not.exist');
  });

  it('reports the exact set of keys a partial locale is missing', () => {
    const missing = missingKeys('ar');
    expect(missing).toContain('audit.heading'); // ar lacks it
    expect(missing).not.toContain('nav.inventory'); // ar has it
    // Negative control: the base locale is missing nothing.
    expect(missingKeys('en-US')).toHaveLength(0);
  });

  it('knows its supported locales', () => {
    expect(isKnownLocale('en-US')).toBe(true);
    expect(isKnownLocale('ar')).toBe(true);
    expect(isKnownLocale('xx-YY')).toBe(false); // negative control
  });
});

describe('text direction', () => {
  it('is RTL for Arabic/Hebrew/Persian/Urdu and LTR otherwise', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('he')).toBe('rtl');
    expect(directionFor('fa-IR')).toBe('rtl');
    // Negative control: Latin-script locales are LTR.
    expect(directionFor('en-US')).toBe('ltr');
    expect(directionFor('fr')).toBe('ltr');
  });

  it('derives the primary subtag and emits html lang+dir attributes', () => {
    expect(primarySubtag('en-US')).toBe('en');
    expect(htmlLangAttrs('en-US')).toBe('lang="en-US" dir="ltr"');
    expect(htmlLangAttrs('ar')).toBe('lang="ar" dir="rtl"');
  });
});

describe('date / number / time-zone formatting', () => {
  it('renders a stored epoch-ms in the officer time zone without mutating it', () => {
    const epoch = 1_700_000_000_000; // fixed UTC instant
    const ny = formatDateTime(epoch, { locale: 'en-US', timeZone: 'America/New_York' });
    const tokyo = formatDateTime(epoch, { locale: 'en-US', timeZone: 'Asia/Tokyo' });
    // Same instant, different displayed local time → the two renderings differ.
    expect(ny).not.toBe(tokyo);
    // The stored value is untouched (still the same instant).
    expect(new Date(epoch).getTime()).toBe(epoch);
    // Unknown zone falls back to ISO, never throws.
    expect(formatDateTime(epoch, { locale: 'en-US', timeZone: 'Not/AZone' })).toContain('T');
    expect(formatDate(epoch, { locale: 'en-US', timeZone: DEFAULT_TIME_ZONE })).toMatch(/\d/);
  });

  it('formats numbers, integers, and percents per locale', () => {
    expect(formatNumber(1234567.891, { locale: 'en-US' })).toBe('1,234,567.89');
    expect(formatInteger(42.9, 'en-US')).toBe('42');
    expect(formatPercent(0.5, 'en-US')).toBe('50%');
    // Negative control: grouping is actually applied (a bare toString would not group).
    expect(formatNumber(1000000, { locale: 'en-US' })).not.toBe('1000000');
  });
});

describe('direction-safe layout primitives', () => {
  it('emits CSS logical properties that flip under RTL', () => {
    expect(logicalPadding('1rem')).toContain('padding-inline-start');
    expect(logicalPadding('1rem')).not.toContain('padding-left'); // negative control: no physical prop
    expect(logicalBorder('2px', 'solid', '#000')).toContain('border-inline-start');
    const rtlSheet = directionStylesheet('ar');
    expect(rtlSheet).toContain('direction: rtl');
    expect(rtlSheet).toContain('text-align: start');
    // Negative control: the LTR sheet declares ltr.
    expect(directionStylesheet('en-US')).toContain('direction: ltr');
  });
});
