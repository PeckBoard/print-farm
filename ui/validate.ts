// Printer form draft → inline field errors + the request body. Pure (no DOM)
// — unit-tested in test/ui-format.test.ts. Mirrors src/printers.ts
// buildPrinter so the user sees problems before the server rejects them.

export interface PrinterDraft {
  name: string;
  type: string;
  host: string;
  port: string;
  api_key: string;
  username: string;
  password: string;
  storage: string;
  tls_insecure: boolean;
  serial: string;
  access_code: string;
  model: string;
  orca_printer_profile: string;
  orca_filament_profile: string;
  orca_process_profile: string;
  /// Secrets the user asked to forget (sent as null).
  clear: { api_key?: boolean; password?: boolean };
}

/// What the saved printer already has (the redacted `has_*` flags).
export interface SavedSecrets {
  has_api_key?: boolean;
  has_password?: boolean;
  bambu?: { has_access_code?: boolean };
}

export function validatePrinter(d: PrinterDraft, saved: SavedSecrets | null): Record<string, string> {
  const err: Record<string, string> = {};
  const host = d.host.trim();
  if (d.name.trim().length > 120) err.name = "Keep the name under 120 characters.";
  if (!host) err.host = d.type === "bambu" ? "Enter the printer's IP address." : "Enter the printer's address.";
  else if (/[\s'"`<>]/.test(host)) err.host = "The address can't contain spaces or quotes.";
  if (d.port.trim()) {
    const n = Number(d.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) err.port = "Port must be a whole number from 1 to 65535.";
  }
  const hasKey = (!!d.api_key && !d.clear.api_key) || (!!saved?.has_api_key && !d.clear.api_key);
  const hasPw = (!!d.password && !d.clear.password) || (!!saved?.has_password && !d.clear.password);
  if (d.type === "octoprint" && !hasKey) err.api_key = "OctoPrint needs an API key (Settings → Application Keys).";
  if (d.type === "prusalink" && !hasKey && !hasPw) err.password = "Enter the PrusaLink password (or an API key).";
  if (d.type === "bambu") {
    if (!d.serial.trim()) err.serial = "Enter the serial number (printer screen → Settings → Device).";
    else if (!/^[A-Za-z0-9]{6,32}$/.test(d.serial.trim())) err.serial = "Serial numbers are letters and digits only.";
    if (!d.access_code && !saved?.bambu?.has_access_code) err.access_code = "Enter the LAN access code.";
  }
  return err;
}

/// Build the POST/PUT body. Secrets: typed → replace, cleared → null, else
/// omitted (the server keeps the stored value).
export function printerBody(d: PrinterDraft, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: d.name.trim() || undefined,
    type: d.type,
    host: d.host.trim(),
    port: d.port.trim() ? Number(d.port) : editing ? null : undefined,
    tls_insecure: d.tls_insecure,
    orca_printer_profile: d.orca_printer_profile || (editing ? null : undefined),
    orca_filament_profile: d.orca_filament_profile || (editing ? null : undefined),
    orca_process_profile: d.orca_process_profile || (editing ? null : undefined),
  };
  if (d.type !== "bambu") {
    if (d.api_key) body.api_key = d.api_key;
    else if (d.clear.api_key) body.api_key = null;
  }
  if (d.type === "prusalink") {
    body.username = d.username.trim() || (editing ? null : undefined);
    body.storage = d.storage || (editing ? null : undefined);
    if (d.password) body.password = d.password;
    else if (d.clear.password) body.password = null;
  }
  if (d.type === "bambu") {
    const b: Record<string, unknown> = { serial: d.serial.trim(), model: d.model || null };
    if (d.access_code) b.access_code = d.access_code;
    body.bambu = b;
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}
