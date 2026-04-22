/**
 * llm/gpu-probe.ts — detect available GPU capabilities for Node.js.
 *
 * Two signals:
 *   1. WebGPU adapter via `navigator.gpu` (available in Node with transformers.js v4)
 *      gives us `maxBufferSize`, `maxStorageBufferBindingSize`, vendor/architecture hints.
 *   2. OS-level video controller info (Windows WMI, Linux sysfs, macOS system_profiler)
 *      gives us dedicated VRAM bytes — which WebGPU hides for privacy reasons.
 *
 * Cached per-process: the probe runs at most once. GPU topology doesn't change.
 */
export interface GpuCapabilities {
  available: boolean;
  vendor?: string;                        // "AMD" | "Intel" | "NVIDIA" | "Apple" | "unknown"
  architecture?: string;                  // adapter.info.architecture if available
  type?: "dgpu" | "igpu" | "unknown";
  vramBytes?: number;                     // dedicated VRAM from OS query (0 if unknown)
  maxBufferSize?: number;                 // WebGPU per-buffer cap (usually 2 GiB on iGPUs)
  maxStorageBufferBindingSize?: number;
  driverDateMs?: number;                  // driver install date (Windows only); missing on other OSes
  driverStaleDays?: number;               // days since driver install
  probeError?: string;
  warnings?: string[];                    // human-readable advisories to surface on first use
}

let cached: Promise<GpuCapabilities> | null = null;

export function probeGpu(): Promise<GpuCapabilities> {
  if (!cached) cached = doProbe();
  return cached;
}

async function doProbe(): Promise<GpuCapabilities> {
  const caps: GpuCapabilities = { available: false };

  // OS-level probe first — in Node, navigator.gpu is usually not exposed to external
  // code (transformers.js v4 initializes WebGPU internally when device='webgpu' is
  // requested, without installing a global navigator.gpu shim). So we trust OS info
  // as the primary GPU-existence signal, and let the WebGPU adapter probe fill in
  // limits where it's actually accessible (browser context or Deno/Bun).
  try {
    const osInfo = await probeOsGpuInfo();
    caps.vramBytes = osInfo.vramBytes;
    caps.driverDateMs = osInfo.driverDateMs;
    caps.vendor = osInfo.vendor;
    if (osInfo.driverDateMs) {
      const ageDays = Math.floor((Date.now() - osInfo.driverDateMs) / 86400_000);
      caps.driverStaleDays = ageDays;
    }
    // If OS reports a GPU with VRAM, assume WebGPU is available — transformers.js v4
    // creates its own adapter internally when device='webgpu' is passed.
    if (osInfo.vramBytes && osInfo.vramBytes > 0) caps.available = true;
  } catch { /* ignore */ }

  // Supplementary WebGPU adapter probe — only works in browser-like environments or
  // if a caller explicitly polyfills navigator.gpu. Fills in maxBufferSize when reachable.
  try {
    const nav = (globalThis as any).navigator;
    const gpu = nav?.gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter?.();
      if (adapter) {
        caps.available = true;
        caps.maxBufferSize = adapter.limits?.maxBufferSize;
        caps.maxStorageBufferBindingSize = adapter.limits?.maxStorageBufferBindingSize;
        const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
        if (info?.vendor) {
          const raw = String(info.vendor).toLowerCase();
          if (raw.includes("nvidia")) caps.vendor = "NVIDIA";
          else if (raw.includes("amd") || raw.includes("advanced micro")) caps.vendor = "AMD";
          else if (raw.includes("intel")) caps.vendor = "Intel";
          else if (raw.includes("apple")) caps.vendor = "Apple";
          caps.architecture = info.architecture;
        }
      }
    }
  } catch (err) {
    caps.probeError = err instanceof Error ? err.message : String(err);
  }

  // Default maxBufferSize to the WebGPU spec minimum (2 GiB) when the adapter probe
  // couldn't give us a real value. This matches what we've measured on AMD 780M +
  // Intel iGPUs — the spec floor is ~2 GiB on integrated graphics.
  if (caps.available && !caps.maxBufferSize) {
    caps.maxBufferSize = 2 * 2 ** 30;
  }

  // Warnings — driver age, missing stack, iGPU memory pressure.
  caps.warnings = [];
  if ((caps.driverStaleDays ?? 0) > 180) {
    caps.warnings.push(
      `GPU driver is ${caps.driverStaleDays} days old (installed ${new Date(caps.driverDateMs!).toISOString().slice(0, 10)}). ` +
      `Recent AMD/Intel driver updates include WebGPU/DirectML fixes; consider updating for better throughput and stability.`,
    );
  }
  if (caps.type === "igpu" && caps.vramBytes && caps.vramBytes < 2 * 2 ** 30) {
    caps.warnings.push(
      `iGPU has ${(caps.vramBytes / 2 ** 30).toFixed(1)} GiB VRAM — small models fit comfortably, ` +
      `but models >150 MB at seq≥1024 may hit WebGPU per-buffer limits. Consider cpu device for those.`,
    );
  }

  // Classify dgpu vs igpu:
  //   iGPU: AMD/Intel with maxBufferSize at the WebGPU spec minimum (2 GiB)
  //         AND vendor is AMD/Intel (NVIDIA has no iGPUs; Apple Silicon is unified).
  //   dGPU: anything with maxBufferSize > 2 GiB, or NVIDIA.
  if (caps.vendor === "NVIDIA") caps.type = "dgpu";
  else if (caps.vendor === "Apple") caps.type = "igpu"; // unified memory — treat as iGPU budgeting
  else if (caps.maxBufferSize && caps.maxBufferSize > 2 * 2 ** 30) caps.type = "dgpu";
  else if (caps.available) caps.type = "igpu";
  else caps.type = "unknown";

  return caps;
}

interface OsGpuInfo {
  vramBytes: number;
  driverDateMs?: number;
  vendor?: string;
}

async function probeOsGpuInfo(): Promise<OsGpuInfo> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);

  if (process.platform === "win32") {
    // One PowerShell call returns VRAM, driver date, and GPU name.
    try {
      const script =
        "$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Sort-Object AdapterRAM -Descending | Select-Object -First 1;" +
        "[PSCustomObject]@{ VRAM = [int64]$gpu.AdapterRAM; DriverDate = if ($gpu.DriverDate) { [int64](($gpu.DriverDate - [DateTime]'1970-01-01Z').TotalMilliseconds) } else { 0 }; Name = [string]$gpu.Name } | ConvertTo-Json -Compress";
      const { stdout } = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: 5000 });
      const j = JSON.parse(stdout.trim()) as { VRAM?: number; DriverDate?: number; Name?: string };
      const name = String(j.Name || "").toLowerCase();
      let vendor: string | undefined;
      if (name.includes("nvidia") || name.includes("geforce") || name.includes("rtx")) vendor = "NVIDIA";
      else if (name.includes("amd") || name.includes("radeon") || name.includes("ryzen")) vendor = "AMD";
      else if (name.includes("intel") || name.includes("arc") || name.includes("iris")) vendor = "Intel";
      else if (name.includes("apple")) vendor = "Apple";
      return {
        vramBytes: Number(j.VRAM) || 0,
        driverDateMs: Number(j.DriverDate) || undefined,
        vendor,
      };
    } catch { return { vramBytes: 0 }; }
  }

  if (process.platform === "linux") {
    try {
      const fs = await import("fs/promises");
      const files = await fs.readdir("/sys/class/drm").catch(() => [] as string[]);
      for (const f of files) {
        if (!/^card\d+$/.test(f)) continue;
        const p = `/sys/class/drm/${f}/device/mem_info_vram_total`;
        const s = await fs.readFile(p, "utf8").catch(() => "");
        const n = Number(s.trim());
        if (Number.isFinite(n) && n > 0) return { vramBytes: n };
      }
    } catch { /* ignore */ }
    return { vramBytes: 0 };
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5000 });
      const data = JSON.parse(stdout);
      const gpu = data?.SPDisplaysDataType?.[0];
      const raw = gpu?.spdisplays_vram || gpu?.sppci_cores_vram || "";
      const m = /(\d+)\s*(GB|MB)/i.exec(String(raw));
      if (m && m[1] && m[2]) {
        const n = Number(m[1]);
        return { vramBytes: m[2].toUpperCase() === "GB" ? n * 2 ** 30 : n * 2 ** 20 };
      }
    } catch { /* ignore */ }
    return { vramBytes: 0 };
  }

  return { vramBytes: 0 };
}

export function formatGpuCapabilities(caps: GpuCapabilities): string {
  if (!caps.available) return "no GPU (WebGPU adapter unavailable)";
  const parts: string[] = [];
  parts.push(`${caps.vendor ?? "unknown"}${caps.architecture ? " " + caps.architecture : ""}`);
  parts.push(caps.type ?? "unknown");
  if (caps.vramBytes) parts.push(`${(caps.vramBytes / 2 ** 30).toFixed(1)} GiB VRAM`);
  if (caps.maxBufferSize) parts.push(`maxBuffer ${(caps.maxBufferSize / 2 ** 30).toFixed(1)} GiB`);
  return parts.join(", ");
}
