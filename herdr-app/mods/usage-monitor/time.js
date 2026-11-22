// Times and durations, formatted for the breakdown and the burndown charts.

const PAST = { Resets: "Reset", Expires: "Expired" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Formatted by hand: Herdr's script runtime ignores toLocaleString's options.
// "3:56 PM" today, "Nov 25, 8:58 AM" on another day.
export function localTime(value) {
  const date = new Date(value);
  const hours = date.getHours();
  const clock = `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
  if (date.toDateString() === new Date().toDateString()) return clock;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clock}`;
}

export function duration(ms) {
  const minutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours >= 48 ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function timed(label, iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return `${PAST[label] ?? label} ${localTime(iso)}`;
  return `${label} in ${duration(ms)} · ${localTime(iso)}`;
}

