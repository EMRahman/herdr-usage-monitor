// Times, durations, and compact counts formatted by hand for Herdr's script runtime
// (which ignores toLocaleString's formatting options).

const PAST = { Resets: "Reset", Expires: "Expired" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

/** Integer with comma thousands separators ("1,420,500"). */
export function formatInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return sign + out;
}

/** Compact K/M/B/T token formatting ("1.42B", "486M", "12.4K"). */
export function formatCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [divisor, suffix] of units) {
    if (abs >= divisor * 0.9995) {
      const scaled = abs / divisor;
      const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      let text = scaled.toFixed(decimals);
      const dot = text.indexOf(".");
      if (dot >= 0) {
        let end = text.length;
        while (end > dot + 1 && text.charCodeAt(end - 1) === 48) end -= 1;
        if (end === dot + 1) end = dot;
        text = text.slice(0, end);
      }
      return `${sign}${text}${suffix}`;
    }
  }
  return sign + formatInt(abs);
}
