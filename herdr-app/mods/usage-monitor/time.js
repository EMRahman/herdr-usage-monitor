// Times, durations, and compact counts formatted by hand for Herdr's script runtime
// (which ignores toLocaleString's formatting options).

const PAST = { Resets: "Reset", Expires: "Expired" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Only include providers whose allowances appear in this report.
function allowanceSamples(report) {
  const ids = ["claude", "codex", "antigravity"].filter((id) => report?.[id]);
  for (const provider of report?.others ?? []) {
    if (!provider.problem) ids.push(provider.id);
  }
  return ids.map((id) => {
    const time = report.read_at?.[id];
    return { id, at: Number.isFinite(time) && time > 0 ? time : 0 };
  });
}

export function hasFreshAllowance(report) {
  return allowanceSamples(report).some(({ at }) => at > 0 && at >= report.timestamp);
}

function sampleAge(at, now) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (!minutes) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""} ago`;
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""} ago`;
}

const SAMPLE_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity",
  cursor: "Cursor", copilot: "GitHub Copilot", grok: "Grok", opencode: "OpenCode" };
const STALE_MS = 5 * 60_000;

export function sampleStatus(report, now = Date.now()) {
  const samples = allowanceSamples(report);
  if (!samples.length) return { label: "No samples yet" };
  if (!report.read_at && Number.isFinite(report.timestamp) && report.timestamp > 0) {
    return {
      label: `Cached report ${sampleAge(report.timestamp, now)}`,
      detail: `Report saved ${localTime(report.timestamp, true)}. Individual sample times are unknown.`,
      stale: now - report.timestamp >= STALE_MS,
    };
  }
  const times = samples.map((s) => s.at).filter(Boolean);
  const detail = samples.map(({ id, at }) => `${SAMPLE_NAMES[id] ?? id} · ${at
    ? `${sampleAge(at, now)} (${localTime(at, true)})` : "sample age unknown"}`).join("\n");
  if (!times.length) return { label: "Sample age unknown", detail };
  const oldest = Math.min(...times);
  const age = sampleAge(oldest, now);
  const label = times.length < samples.length ? "Oldest known sample"
    : age !== sampleAge(Math.max(...times), now) ? "Oldest sample" : "Sampled";
  return { label: `${label} ${age}`, detail, stale: now - oldest >= STALE_MS };
}

// "3:56 PM" today, "Nov 25, 8:58 AM" on another day.
export function localTime(value, seconds = false) {
  const date = new Date(value);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const secondPart = seconds ? `:${String(date.getSeconds()).padStart(2, "0")}` : "";
  const clock = `${hours % 12 || 12}:${minutes}${secondPart} ${hours < 12 ? "AM" : "PM"}`;
  if (date.toDateString() === new Date().toDateString()) return clock;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clock}`;
}

export function refreshDuration(ms) {
  const tenths = Math.round(Math.max(0, ms) / 100);
  return `${(tenths / 10).toFixed(1)}s`;
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
