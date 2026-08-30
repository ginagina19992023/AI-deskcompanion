// Main-process only. Detects whether an NVIDIA (CUDA-capable) discrete GPU
// is present, so the dashboard can hide/disable local voice-cloning engines
// (IndexTTS2, OpenVoice, Fish Speech-GPU) that silently hang or crash
// without one rather than let the user pick an option that can't work.
// WMI query rather than a CUDA runtime call -- no CUDA toolkit needed just
// to answer "is there an NVIDIA card at all", and it works even before
// any ML dependency is installed.
import { execFileSync } from 'node:child_process';

let cachedResult = null;

export function detectNvidiaGpu() {
  if (cachedResult !== null) return cachedResult;
  if (process.platform !== 'win32') {
    cachedResult = { available: false, name: null, reason: 'not-windows' };
    return cachedResult;
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nvidiaLine = lines.find((l) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(l));
    cachedResult = nvidiaLine
      ? { available: true, name: nvidiaLine, reason: null }
      : { available: false, name: null, reason: lines.length ? `no NVIDIA card (found: ${lines.join(', ')})` : 'no video controller detected' };
  } catch (err) {
    cachedResult = { available: false, name: null, reason: `detection failed: ${err.message}` };
  }
  return cachedResult;
}
