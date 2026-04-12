// ---------------------------------------------------------------------------
// Zero-dependency cron expression parser
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
// ---------------------------------------------------------------------------

export interface CronExpression {
  minutes: number[]; // 0-59
  hours: number[]; // 0-23
  daysOfMonth: number[]; // 1-31
  months: number[]; // 1-12
  daysOfWeek: number[]; // 0-6 (0 = Sunday)
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

function rangeArray(min: number, max: number): number[] {
  const result: number[] = [];
  for (let i = min; i <= max; i++) {
    result.push(i);
  }
  return result;
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // Step: */n or start-end/n
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (step <= 0) {
        throw new Error(`Invalid step value: ${step}`);
      }
      const base = stepMatch[1];

      let start: number;
      let end: number;

      if (base === '*') {
        start = min;
        end = max;
      } else {
        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = Number(rangeMatch[1]);
          end = Number(rangeMatch[2]);
        } else {
          start = Number(base);
          end = max;
        }
      }

      validateRange(start, end, min, max);
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === '*') {
      for (const v of rangeArray(min, max)) {
        values.add(v);
      }
      continue;
    }

    // Range: start-end
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      validateRange(start, end, min, max);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const num = Number(trimmed);
    if (Number.isNaN(num) || !Number.isInteger(num)) {
      throw new Error(`Invalid cron field value: "${trimmed}"`);
    }
    if (num < min || num > max) {
      throw new Error(
        `Value ${num} out of range [${min}-${max}]`,
      );
    }
    values.add(num);
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error(`Empty cron field: "${field}"`);
  }
  return sorted;
}

function validateRange(
  start: number,
  end: number,
  min: number,
  max: number,
): void {
  if (start > end) {
    throw new Error(`Invalid range: ${start}-${end}`);
  }
  if (start < min || end > max) {
    throw new Error(
      `Range ${start}-${end} out of bounds [${min}-${max}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a 5-field cron expression into structured form */
export function parseCron(expression: string): CronExpression {
  const trimmed = expression.trim();

  // Check aliases first
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) {
    return parseCron(alias);
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${fields.length} in "${expression}"`,
    );
  }

  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
  };
}

/** Check if a given Date matches a cron expression */
export function cronMatches(cron: CronExpression, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dayOfWeek = date.getDay(); // 0 = Sunday

  return (
    cron.minutes.includes(minute) &&
    cron.hours.includes(hour) &&
    cron.daysOfMonth.includes(dayOfMonth) &&
    cron.months.includes(month) &&
    cron.daysOfWeek.includes(dayOfWeek)
  );
}

/** Get the next occurrence after a given date */
export function nextCronOccurrence(cron: CronExpression, after: Date): Date {
  // Start from the next minute (floor seconds/ms, advance 1 minute)
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 4 years (covers all possible cron patterns including leap years)
  const limit = after.getTime() + 4 * 366 * 24 * 60 * 60_000;

  while (candidate.getTime() <= limit) {
    // Fast-skip: if month doesn't match, jump to next matching month
    const month = candidate.getMonth() + 1;
    if (!cron.months.includes(month)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Fast-skip: if day-of-month doesn't match or day-of-week doesn't match
    const dom = candidate.getDate();
    const dow = candidate.getDay();
    if (!cron.daysOfMonth.includes(dom) || !cron.daysOfWeek.includes(dow)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Fast-skip: if hour doesn't match
    const hour = candidate.getHours();
    if (!cron.hours.includes(hour)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    const minute = candidate.getMinutes();
    if (cron.minutes.includes(minute)) {
      return new Date(candidate.getTime());
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error('Could not find next cron occurrence within 4 years');
}

/** Get the previous occurrence before a given date */
export function prevCronOccurrence(cron: CronExpression, before: Date): Date {
  // Start from the previous minute (floor seconds/ms, go back 1 minute)
  const candidate = new Date(before.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() - 1);

  // Search up to 4 years back
  const limit = before.getTime() - 4 * 366 * 24 * 60 * 60_000;

  while (candidate.getTime() >= limit) {
    const month = candidate.getMonth() + 1;
    if (!cron.months.includes(month)) {
      // Jump to previous month, last day
      candidate.setDate(0); // goes to last day of previous month
      candidate.setHours(23, 59, 0, 0);
      continue;
    }

    const dom = candidate.getDate();
    const dow = candidate.getDay();
    if (!cron.daysOfMonth.includes(dom) || !cron.daysOfWeek.includes(dow)) {
      candidate.setDate(candidate.getDate() - 1);
      candidate.setHours(23, 59, 0, 0);
      continue;
    }

    const hour = candidate.getHours();
    if (!cron.hours.includes(hour)) {
      candidate.setHours(candidate.getHours() - 1, 59, 0, 0);
      continue;
    }

    const minute = candidate.getMinutes();
    if (cron.minutes.includes(minute)) {
      return new Date(candidate.getTime());
    }

    candidate.setMinutes(candidate.getMinutes() - 1);
  }

  throw new Error('Could not find previous cron occurrence within 4 years');
}

/** Format a CronExpression back to a 5-field cron string */
export function formatCron(cron: CronExpression): string {
  return [
    formatField(cron.minutes, 0, 59),
    formatField(cron.hours, 0, 23),
    formatField(cron.daysOfMonth, 1, 31),
    formatField(cron.months, 1, 12),
    formatField(cron.daysOfWeek, 0, 6),
  ].join(' ');
}

function formatField(values: number[], min: number, max: number): string {
  // Full range -> *
  if (values.length === max - min + 1) {
    return '*';
  }

  // Check if values form a step pattern from min
  if (values.length >= 2) {
    const step = values[1] - values[0];
    if (step > 0) {
      let isStep = true;
      for (let i = 1; i < values.length; i++) {
        if (values[i] - values[i - 1] !== step) {
          isStep = false;
          break;
        }
      }
      if (isStep && values[0] === min) {
        return `*/${step}`;
      }
    }
  }

  // Collapse consecutive runs into ranges
  const parts: string[] = [];
  let i = 0;
  while (i < values.length) {
    const start = values[i];
    let end = start;
    while (i + 1 < values.length && values[i + 1] === end + 1) {
      i++;
      end = values[i];
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
    i++;
  }
  return parts.join(',');
}

/** Human-readable description of a cron expression */
export function describeCron(cron: CronExpression): string {
  const parts: string[] = [];

  // Minutes
  if (cron.minutes.length === 60) {
    parts.push('every minute');
  } else if (cron.minutes.length === 1) {
    parts.push(`at minute ${cron.minutes[0]}`);
  } else {
    parts.push(`at minutes ${cron.minutes.join(', ')}`);
  }

  // Hours
  if (cron.hours.length === 24) {
    parts.push('of every hour');
  } else if (cron.hours.length === 1) {
    parts.push(`of ${formatHour(cron.hours[0])}`);
  } else {
    parts.push(`of ${cron.hours.map(formatHour).join(', ')}`);
  }

  // Days of month
  if (cron.daysOfMonth.length < 31) {
    if (cron.daysOfMonth.length === 1) {
      parts.push(`on day ${cron.daysOfMonth[0]}`);
    } else {
      parts.push(`on days ${cron.daysOfMonth.join(', ')}`);
    }
  }

  // Months
  if (cron.months.length < 12) {
    const monthNames = [
      '', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    if (cron.months.length === 1) {
      parts.push(`in ${monthNames[cron.months[0]]}`);
    } else {
      parts.push(`in ${cron.months.map((m) => monthNames[m]).join(', ')}`);
    }
  }

  // Days of week
  if (cron.daysOfWeek.length < 7) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (cron.daysOfWeek.length === 1) {
      parts.push(`on ${dayNames[cron.daysOfWeek[0]]}`);
    } else {
      parts.push(`on ${cron.daysOfWeek.map((d) => dayNames[d]).join(', ')}`);
    }
  }

  return parts.join(' ');
}

function formatHour(h: number): string {
  if (h === 0) return '12:00 AM';
  if (h === 12) return '12:00 PM';
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}
