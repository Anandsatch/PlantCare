// WateringLedger — the 7-day droplet row that anchors A-2 plant detail and the
// per-plant block on A-6 weekly review.
//
// Visual contract (DESIGN.md "Watering history pattern" + master plan §
// "Component contracts"): seven columns, oldest -> today, left to right. Each
// column is a small all-caps Inter day-of-week label above a <Droplet> at
// size 20. Today's column gets a 3px dot beneath the label so the day reads
// as "now" without disrupting label rhythm. Filled droplet = watered that day,
// outline-only droplet = no watering recorded that day.
//
// Empty state: when events.length === 0, the row still renders (seven outline
// droplets) plus an italic Inter caption "No watering recorded yet — tap Mark
// watered to start your record" beneath. This is deliberate — the chart shape
// is established from day one so when the first watering arrives no relearning
// is needed.
//
// === The local-tz / UTC-ms boundary (deliberate; see master plan + E4-002) ===
// The WATERING ENGINE math (E4-001) is millisecond-only: dueAtMs = lastMs +
// intervalDays * 86400000. That formula survives DST flips and international
// date-line travel because it never asks "what calendar day is it?"
//
// The LEDGER, by contrast, MUST display in local time — a user who watered on
// Tuesday morning expects to see a filled droplet under the "TUE" column on
// their phone, not under "MON" because the wall-clock-local-tz Tuesday started
// before midnight UTC. So the ledger anchors to the device's start-of-local-day
// (via Date#setHours(0,0,0,0)) and steps backward 86,400,000 ms per column.
//
// Edge cases handled by the ms-stepping (rather than calendar-day diffing):
//   - DST forward (23-hour day): the column for the spring-forward day still
//     covers the right wall-clock window because we anchor each column to its
//     own midnight via setHours, not via subtracting 24h from "today".
//   - DST backward (25-hour day): same — each column's [start, end) is computed
//     from a fresh setHours, not propagated arithmetic.
//   - IDL travel: the `nowMs` test seam lets a future IDL regression test pin
//     a known instant; in practice the device's tz updates with travel and the
//     ledger reflects the new local week.
//
// Performance: the component filters events in render. At hundreds of events
// (multi-year plant lifetime) this is still < 1ms on iPhone hardware; the
// alternative (a memoized index on parent) is premature for V1.
//
// Out of scope (V1 locks): no Pressable columns (no day-detail drilldown), no
// Animated reveal of droplets, no horizontal scroll past 7 days, no <ThemeProvider>.

import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { Droplet } from './primitives/Droplet';

const DAY_MS = 86_400_000;
const COLUMN_COUNT = 7;
const DROPLET_SIZE = 20;
const TODAY_DOT_SIZE = 3;
const EMPTY_CAPTION =
  'No watering recorded yet — tap Mark watered to start your record';

/**
 * A watering event. Defined locally rather than imported from db/types because
 * that schema is in a separate unmerged PR (E4-001/E4-002 stack). Once those
 * land, the field shape (`wateredAtMs`) is the agreed contract.
 */
export type WateringEvent = {
  /** Unix epoch milliseconds when the watering happened. */
  wateredAtMs: number;
};

export type WateringLedgerProps = {
  /** All watering events for the plant. Component filters to the last 7 local-tz days. */
  events: WateringEvent[];
  /**
   * Optional anchor for "today" (unix ms). Default `Date.now()`. Useful for
   * snapshot tests, weekly-review historical playback, and the IDL/DST
   * regression cases — pins the rightmost column without mocking the clock.
   */
  startDate?: number;
  /**
   * Testability seam — alias for `startDate` to keep the prop name aligned with
   * other date-aware components in the codebase that use `nowMs`. If both are
   * passed, `startDate` wins (it's the documented public prop).
   */
  nowMs?: number;
  /** A11y root label. Default '7-day watering history'. */
  accessibilityLabel?: string;
  testID?: string;
};

type DayCell = {
  /** Start of the day in local time (unix ms, inclusive). */
  startMs: number;
  /** Start of the next day in local time (unix ms, exclusive). */
  endMs: number;
  /** Three-letter weekday label, e.g. 'MON'. */
  label: string;
  /** True for the rightmost column. */
  isToday: boolean;
};

// Sun-Sat fallback weekday names, indexed by Date#getDay(). Used when
// toLocaleDateString throws or returns falsy on older Android RN builds with
// limited Intl support (Hermes ships without full Intl on some configurations).
const SHORT_WEEKDAYS_FALLBACK = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const LONG_WEEKDAYS_FALLBACK = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Format a weekday name with a hard fallback when Intl is missing or partial.
 * Both the visible label and the VoiceOver label go through this so the same
 * fallback policy applies everywhere.
 */
function formatWeekday(d: Date, variant: 'short' | 'long'): string {
  try {
    const formatted = d.toLocaleDateString(undefined, { weekday: variant });
    if (formatted && typeof formatted === 'string') {
      return variant === 'short'
        ? formatted.toUpperCase().slice(0, 3)
        : formatted;
    }
  } catch {
    // fall through to fallback
  }
  const idx = d.getDay();
  return variant === 'short'
    ? SHORT_WEEKDAYS_FALLBACK[idx]
    : LONG_WEEKDAYS_FALLBACK[idx];
}

/**
 * Build the seven day buckets, oldest -> today (left to right). Each bucket
 * spans [setHours(0,0,0,0), nextDayStart) in local time, which guarantees DST
 * transitions land on the correct column regardless of whether the day was
 * 23h, 24h, or 25h long.
 */
function buildDayCells(anchorMs: number): DayCell[] {
  const cells: DayCell[] = [];
  for (let offset = COLUMN_COUNT - 1; offset >= 0; offset--) {
    // Step back `offset` days from the anchor. Using setDate(getDate()-offset)
    // is calendar-aware: on a 25-hour fall-back day, plain `anchorMs - offset*DAY_MS`
    // could land an hour off-day, and `setHours(0,0,0,0)` would then snap to
    // the wrong calendar day. setDate handles DST by walking calendar days,
    // not millisecond steps. Then setHours(0,0,0,0) snaps to local midnight.
    const dayStart = new Date(anchorMs);
    dayStart.setDate(dayStart.getDate() - offset);
    dayStart.setHours(0, 0, 0, 0);
    // Compute the exclusive upper bound the same way (next calendar day's
    // midnight). On DST-transition days, dayStart + DAY_MS would be wrong
    // (23h or 25h offset); setDate(+1) walks calendar days correctly.
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);
    cells.push({
      startMs: dayStart.getTime(),
      endMs: nextDay.getTime(),
      label: formatWeekday(dayStart, 'short'),
      isToday: offset === 0,
    });
  }
  return cells;
}

export function WateringLedger({
  events,
  startDate,
  nowMs,
  accessibilityLabel = '7-day watering history',
  testID,
}: WateringLedgerProps): React.ReactElement {
  const theme = useTheme();
  const anchor = startDate ?? nowMs ?? Date.now();

  // Day cells recompute whenever the anchor changes. Cheap (7 iterations); not
  // memoized by design — useMemo overhead is roughly equal to the rebuild cost.
  const cells = buildDayCells(anchor);

  // For each cell decide whether any event lands inside it. A single pass
  // suffices: bucket index = days between event and rightmost-column-end. Any
  // event outside the [oldestStart, todayEnd) window is silently dropped, which
  // also handles the "future event" defensive case (negative bucket).
  const filledByCol: boolean[] = new Array(COLUMN_COUNT).fill(false);
  const oldestStart = cells[0].startMs;
  const newestEnd = cells[COLUMN_COUNT - 1].endMs;
  for (const event of events) {
    const t = event.wateredAtMs;
    if (t < oldestStart || t >= newestEnd) continue;
    // Find the cell whose [startMs, endMs) contains t. Linear scan over 7 is
    // faster than computing a divisor (DST means cell widths aren't uniform).
    for (let i = 0; i < COLUMN_COUNT; i++) {
      if (t >= cells[i].startMs && t < cells[i].endMs) {
        filledByCol[i] = true;
        break;
      }
    }
  }

  const isEmpty = events.length === 0;

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel}
      style={styles.root}
    >
      <View style={styles.row}>
        {cells.map((cell, i) => {
          const filled = filledByCol[i];
          const dayName = formatWeekday(new Date(cell.startMs), 'long');
          const colLabel = filled
            ? `${dayName}, watered`
            : `${dayName}, no watering recorded`;
          return (
            <View
              key={cell.startMs}
              accessible
              accessibilityLabel={colLabel}
              style={styles.col}
            >
              {/*
                Visible label — small all-caps weekday. The parent <View
                accessible> wraps this Text plus the droplet under a single
                composed accessibilityLabel, so VoiceOver reads "Tuesday,
                watered" rather than "TUE" then "watered" as two stops. No
                extra accessibilityElementsHidden needed; `accessible` on the
                parent already collapses children for assistive tech.
              */}
              <Text style={[styles.dayLabel, { color: theme.colors.textMuted }]}>
                {cell.label}
              </Text>
              {cell.isToday ? (
                <View
                  style={[
                    styles.todayDot,
                    { backgroundColor: theme.colors.text },
                  ]}
                />
              ) : (
                // Reserve the same vertical space when no dot — keeps droplets
                // baseline-aligned across columns.
                <View style={styles.todayDotPlaceholder} />
              )}
              <Droplet filled={filled} size={DROPLET_SIZE} />
            </View>
          );
        })}
      </View>
      {isEmpty ? (
        <Text
          style={[styles.emptyCaption, { color: theme.colors.textMuted }]}
        >
          {EMPTY_CAPTION}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  col: {
    flex: 1,
    alignItems: 'center',
  },
  dayLabel: {
    fontSize: 10,
    letterSpacing: 0.5,
    marginBottom: 4,
    // No fontFamily: V1 system font fallback is acceptable until the Inter
    // wiring lands in E2-005. Token color carries the editorial weight.
  },
  todayDot: {
    width: TODAY_DOT_SIZE,
    height: TODAY_DOT_SIZE,
    borderRadius: TODAY_DOT_SIZE / 2,
    marginBottom: 4,
  },
  todayDotPlaceholder: {
    width: TODAY_DOT_SIZE,
    height: TODAY_DOT_SIZE,
    marginBottom: 4,
  },
  emptyCaption: {
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 8,
    textAlign: 'center',
  },
});
