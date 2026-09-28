// Must match the indexed expression in migrations/0002_reading_time_indexes.sql, or queries fall back to full scans.
export const READING_TIME_SQL = "datetime(COALESCE(sampled_at, received_at))";

export function groupExpr(group: "hour" | "day" | "week" | "month"): string {
  switch (group) {
    case "hour":
      return `strftime('%Y-%m-%dT%H:00:00Z', COALESCE(sampled_at, received_at))`;
    case "day":
      return `strftime('%Y-%m-%d', COALESCE(sampled_at, received_at))`;
    case "week":
      return `strftime('%Y-W%W', COALESCE(sampled_at, received_at))`;
    case "month":
      return `strftime('%Y-%m', COALESCE(sampled_at, received_at))`;
  }
}
