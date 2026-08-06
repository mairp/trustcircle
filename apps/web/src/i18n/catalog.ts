// TrustCircleAI — INTERNATIONALIZATION CATALOG: externalized user-facing text, locale-aware date /
// number / time-zone formatting, and direction-safe (LTR/RTL) layout primitives (T298 / GAR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Phase 10 (Polish and Continuous Improvement) prepares the finished officer surface for future
// localization WITHOUT changing today's behaviour. The web shell (apps/web/src/app/layout.tsx)
// and the feature views (apps/web/src/features/**) currently render English text inline. This
// module is the single place that:
//
//   1. EXTERNALIZES user-facing text into a keyed MESSAGE CATALOG (`MESSAGES`), so every string an
//      officer reads has a stable key and an English default, and a future locale is added as a
//      new catalog map — no code change in the views. `t(locale, key, params)` resolves a key with
//      {named} interpolation and falls back to the base locale (then to the key itself) so a
//      missing translation is VISIBLE (never a blank), never a crash.
//
//   2. FORMATS DATES, NUMBERS, and TIME ZONES via the platform `Intl` APIs, parameterized by the
//      active locale and the officer's time zone. Canonical governance timestamps are BIGINT epoch
//      millis (matching the DB), so `formatDateTime` takes epoch-ms + a time zone and renders it in
//      the officer's zone — a UTC-stored audit time is DISPLAYED in local time without ever mutating
//      the stored value. `formatNumber` / `formatInteger` / `formatPercent` route through
//      `Intl.NumberFormat` so grouping/decimal separators follow the locale.
//
//   3. Provides DIRECTION-SAFE LAYOUT primitives. `directionFor(locale)` returns `rtl` for RTL
//      scripts (Arabic, Hebrew, Persian, Urdu) and `ltr` otherwise; `htmlLangAttrs(locale)` yields
//      the `lang` + `dir` attributes the shell's `<html>` element needs; `logicalPadding` /
//      `logicalBorder` emit CSS LOGICAL properties (padding-inline-start, border-inline-start) that
//      flip automatically under RTL, so a future RTL locale needs no physical-left/right rewrite.
//
// The module is DEPENDENCY-FREE (only the standard-library `Intl`), pure, and deterministic given
// (locale, time zone), so it runs under `node --experimental-strip-types` and is unit-testable with
// no browser. It ships one fully-populated base locale (en-US) plus a partial second locale (ar) so
// the direction-safe / fallback machinery is exercised, not merely declared.

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LOCALES & DIRECTION
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The locales the surface currently knows about. `en-US` is the fully-populated base. */
export type LocaleId = 'en-US' | 'ar';

/** The base (fully-populated) locale every other locale falls back to. */
export const BASE_LOCALE: LocaleId = 'en-US';

/** Text direction. Logical CSS properties flip between these automatically. */
export type Direction = 'ltr' | 'rtl';

/** The BCP-47 primary subtags whose scripts are written right-to-left. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar',
  'he',
  'fa',
  'ur',
  'ps',
  'sd',
  'yi',
  'dv',
]);

/** The primary language subtag of a locale id (e.g. `en-US` → `en`). */
export function primarySubtag(locale: string): string {
  return locale.toLowerCase().split('-')[0] ?? locale.toLowerCase();
}

/** Resolve the text direction for a locale. RTL for Arabic/Hebrew/Persian/Urdu scripts; else LTR. */
export function directionFor(locale: string): Direction {
  return RTL_LANGUAGES.has(primarySubtag(locale)) ? 'rtl' : 'ltr';
}

/** The `lang` + `dir` attribute string for the shell's `<html>` element, e.g. `lang="ar" dir="rtl"`. */
export function htmlLangAttrs(locale: LocaleId): string {
  return `lang="${locale}" dir="${directionFor(locale)}"`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// MESSAGE CATALOG
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Every user-facing message key on the officer surface. Adding a UI string means adding a key. */
export type MessageKey =
  | 'shell.title'
  | 'shell.tenantScope'
  | 'shell.status.connected'
  | 'shell.status.degraded'
  | 'shell.status.offline'
  | 'nav.inventory'
  | 'nav.coverageGaps'
  | 'nav.decisions'
  | 'nav.audit'
  | 'nav.evidence'
  | 'inventory.heading'
  | 'inventory.col.item'
  | 'inventory.col.type'
  | 'inventory.col.owner'
  | 'inventory.col.health'
  | 'inventory.col.lastObserved'
  | 'inventory.health.unknown'
  | 'coverageGaps.heading'
  | 'coverageGaps.empty'
  | 'coverageGaps.requiredAction'
  | 'decisions.heading'
  | 'decisions.status.accepted'
  | 'decisions.status.rejected'
  | 'audit.heading'
  | 'common.staleMarker'
  | 'common.count';

/** A per-locale catalog. A locale may be partial; missing keys fall back to {@link BASE_LOCALE}. */
export type Catalog = Partial<Record<MessageKey, string>>;

/** The fully-populated base (en-US) catalog. `{name}` placeholders are interpolated by `t`. */
const EN_US: Record<MessageKey, string> = {
  'shell.title': 'TrustCircle — {tenant} governance shell',
  'shell.tenantScope': 'Tenant scope: {tenant} · bundle {bundle}',
  'shell.status.connected': 'Connected',
  'shell.status.degraded': 'Degraded — some signals are stale',
  'shell.status.offline': 'Offline — showing last-known state',
  'nav.inventory': 'Inventory',
  'nav.coverageGaps': 'Coverage gaps',
  'nav.decisions': 'Decisions',
  'nav.audit': 'Audit ledger',
  'nav.evidence': 'Evidence',
  'inventory.heading': 'Reconciled inventory — healthy items',
  'inventory.col.item': 'Item',
  'inventory.col.type': 'Type',
  'inventory.col.owner': 'Owner',
  'inventory.col.health': 'Health',
  'inventory.col.lastObserved': 'Last observation time',
  'inventory.health.unknown': 'Unknown (evidence stale)',
  'coverageGaps.heading': 'Coverage gaps',
  'coverageGaps.empty': 'No coverage gaps in scope.',
  'coverageGaps.requiredAction': 'Required owner action',
  'decisions.heading': 'Decision ledger',
  'decisions.status.accepted': 'Accepted',
  'decisions.status.rejected': 'Rejected',
  'audit.heading': 'Audit ledger',
  'common.staleMarker': 'stale',
  'common.count': '{count} item(s)',
};

/** A partial second locale (Arabic, RTL) — enough to exercise fallback + direction, not a full set. */
const AR: Catalog = {
  'shell.status.connected': 'متصل',
  'shell.status.degraded': 'متدهور — بعض الإشارات قديمة',
  'shell.status.offline': 'غير متصل — عرض آخر حالة معروفة',
  'nav.inventory': 'الجرد',
  'nav.coverageGaps': 'فجوات التغطية',
  'nav.decisions': 'القرارات',
  'coverageGaps.empty': 'لا توجد فجوات تغطية في النطاق.',
  'common.staleMarker': 'قديم',
};

/** The registry of catalogs by locale. `en-US` is complete; `ar` is intentionally partial. */
export const MESSAGES: Readonly<Record<LocaleId, Catalog>> = Object.freeze({
  'en-US': EN_US,
  ar: AR,
});

/** True when the locale id is one this surface knows about. */
export function isKnownLocale(locale: string): locale is LocaleId {
  return locale === 'en-US' || locale === 'ar';
}

/** Substitute `{name}` placeholders in a template from a params object. Unmatched tokens are left. */
function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * Resolve a message key for a locale, interpolating `{named}` params. Resolution order:
 *   1. the requested locale's catalog,
 *   2. the base locale's catalog,
 *   3. the key itself (so a missing string is VISIBLE, never blank, and never throws).
 */
export function t(
  locale: LocaleId,
  key: MessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const requested = MESSAGES[locale]?.[key];
  const template = requested ?? MESSAGES[BASE_LOCALE][key] ?? key;
  return interpolate(template, params);
}

/** The set of keys missing from a locale (present in base, absent here). Drives translation QA. */
export function missingKeys(locale: LocaleId): MessageKey[] {
  const base = MESSAGES[BASE_LOCALE];
  const cat = MESSAGES[locale] ?? {};
  return (Object.keys(base) as MessageKey[]).filter((k) => !(k in cat));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// DATE / NUMBER / TIME-ZONE FORMATTING (Intl-backed, locale + time-zone parameterized)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A canonical governance timestamp is BIGINT epoch millis (matching the DB). */
export type EpochMillis = number;

/**
 * Render an epoch-ms timestamp in the officer's time zone and locale. The STORED value is never
 * mutated — a UTC audit time is merely DISPLAYED in `timeZone`. Falls back gracefully if `Intl`
 * rejects an unknown zone.
 */
export function formatDateTime(
  epochMs: EpochMillis,
  opts: {
    readonly locale: LocaleId;
    readonly timeZone: string;
    readonly dateStyle?: 'short' | 'medium' | 'long';
    readonly timeStyle?: 'short' | 'medium' | 'long';
  },
): string {
  const { locale, timeZone } = opts;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: opts.dateStyle ?? 'medium',
      timeStyle: opts.timeStyle ?? 'short',
    }).format(new Date(epochMs));
  } catch {
    // Unknown time zone / environment without full ICU — fall back to a stable ISO rendering.
    return new Date(epochMs).toISOString();
  }
}

/** Render a date only (no time) in the officer's zone and locale. */
export function formatDate(
  epochMs: EpochMillis,
  opts: { readonly locale: LocaleId; readonly timeZone: string },
): string {
  try {
    return new Intl.DateTimeFormat(opts.locale, {
      timeZone: opts.timeZone,
      dateStyle: 'medium',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** Locale-aware number formatting (grouping + decimal separators follow the locale). */
export function formatNumber(
  value: number,
  opts: { readonly locale: LocaleId; readonly maximumFractionDigits?: number },
): string {
  return new Intl.NumberFormat(opts.locale, {
    maximumFractionDigits: opts.maximumFractionDigits ?? 2,
  }).format(value);
}

/** Locale-aware integer formatting (no fraction digits). */
export function formatInteger(value: number, locale: LocaleId): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.trunc(value));
}

/** Locale-aware percent formatting. `ratio` is a 0..1 fraction. */
export function formatPercent(ratio: number, locale: LocaleId, fractionDigits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: fractionDigits,
  }).format(ratio);
}

/** The IANA time zone used when an officer has none configured. */
export const DEFAULT_TIME_ZONE = 'UTC';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// DIRECTION-SAFE LAYOUT PRIMITIVES (CSS logical properties that flip under RTL)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** `padding-inline: <start> <end>` — flips automatically between LTR and RTL. */
export function logicalPadding(start: string, end: string = start): string {
  return `padding-inline-start: ${start}; padding-inline-end: ${end};`;
}

/** `margin-inline: <start> <end>` — direction-safe margins. */
export function logicalMargin(start: string, end: string = start): string {
  return `margin-inline-start: ${start}; margin-inline-end: ${end};`;
}

/** A leading (start-side) border that flips sides under RTL. */
export function logicalBorder(width: string, style: string, color: string): string {
  return `border-inline-start: ${width} ${style} ${color};`;
}

/** `text-align: start` is direction-safe (renders left in LTR, right in RTL). */
export const TEXT_ALIGN_START = 'text-align: start;';

/**
 * The base stylesheet fragment for the active locale: sets logical text alignment and inline
 * flow so a single stylesheet is correct in both LTR and RTL without physical-left/right rules.
 */
export function directionStylesheet(locale: LocaleId): string {
  const dir = directionFor(locale);
  return [
    `/* direction-safe base for ${locale} (${dir}) */`,
    `body { direction: ${dir}; ${TEXT_ALIGN_START} }`,
    `th, td, caption { ${TEXT_ALIGN_START} }`,
    `nav ul { ${logicalPadding('0')} }`,
  ].join('\n');
}
