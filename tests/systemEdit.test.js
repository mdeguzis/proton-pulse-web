const fs = require('fs');
const path = require('path');
const vm = require('vm');

const editSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'profile', 'system-edit.js'),
  'utf8'
);

// Load utils.js + its config dep via vm (strips import/export, ?v= paths)
const stripImports = src => src
  .replace(/^import\b[\s\S]*?;[ \t]*$/gm, '')
  .replace(/^export\s+(async\s+)?(function|class|const|let|var)\s/gm, '$1$2 ')
  .replace(/^(?:const|let|var)\s+(\w+)\s*=\s*window\.\1\s*;?\s*$/gm, '');

const configSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'profile', 'config.js'), 'utf8');
const utilsSrc  = fs.readFileSync(path.join(__dirname, '..', 'js', 'profile', 'utils.js'), 'utf8');

const SHIM = `
var window = { location: { host: 'localhost' } };
var localStorage = { getItem: function(){ return null; }, setItem: function(){} };
${stripImports(configSrc)}
${stripImports(utilsSrc)}
`;

let ctx;
beforeAll(() => {
  ctx = {};
  vm.createContext(ctx);
  vm.runInContext(SHIM, ctx);
});

describe('system-edit submit handler (source checks)', () => {
  test('reads GPU Vendor field and includes it in sysinfo lines', () => {
    expect(editSrc).toContain("document.getElementById('sys-gpu-vendor').value");
    expect(editSrc).toContain('if (gpuVendor) lines.push(`GPU Vendor: ${gpuVendor}`)');
  });

  test('validates that at least cpu or gpu is present', () => {
    expect(editSrc).toContain('if (!cpu && !gpu)');
    expect(editSrc).toContain("fieldError('sys-cpu'");
    expect(editSrc).toContain("fieldError('sys-gpu'");
  });

  test('validates GPU Vendor, RAM, and OS as required fields', () => {
    expect(editSrc).toContain("if (!gpuVendor) fieldError('sys-gpu-vendor'");
    expect(editSrc).toContain("if (!ram) fieldError('sys-ram'");
    expect(editSrc).toContain("if (!os) fieldError('sys-os'");
  });

  test('per-field error marks outline and label red', () => {
    expect(editSrc).toContain("el.style.outline = '2px solid var(--red)'");
    expect(editSrc).toContain("labelEl.style.color = 'var(--red)'");
  });

  test('scrolls to first error field on validation failure', () => {
    expect(editSrc).toContain('firstError.el?.scrollIntoView');
  });

  test('clears previous field errors before revalidating', () => {
    expect(editSrc).toContain('clearErrors()');
    expect(editSrc).toContain("el.style.outline = ''");
    expect(editSrc).toContain("labelEl.style.color = ''");
  });
});

describe('parseSteamSystemInfo GPU Vendor round-trip', () => {
  test('parses explicit GPU Vendor line', () => {
    const out = ctx.parseSteamSystemInfo('CPU Brand: AMD Ryzen 5\nGPU Vendor: nvidia\nVideo Card: GeForce RTX 4070');
    expect(out.gpuVendor).toBe('nvidia');
  });

  test('lowercases GPU Vendor value on parse', () => {
    const out = ctx.parseSteamSystemInfo('GPU Vendor: AMD');
    expect(out.gpuVendor).toBe('amd');
  });

  test('no GPU Vendor line leaves gpuVendor undefined', () => {
    const out = ctx.parseSteamSystemInfo('CPU Brand: Intel Core i9');
    expect(out.gpuVendor).toBeUndefined();
  });

  test('explicit GPU Vendor takes precedence over inferred vendor in parseUploadedSystem', () => {
    // sysinfo_text has GPU Vendor: amd but GPU string would infer nvidia
    const row = { sysinfo_text: 'Video Card: GeForce RTX 4070\nGPU Vendor: amd' };
    const out = ctx.parseUploadedSystem(row);
    expect(out.gpuVendor).toBe('amd');
  });
});

describe('CPU vendor', () => {
  test('inferCpuVendor recognizes AMD, Intel, and falls back to other', () => {
    expect(ctx.inferCpuVendor('AMD Ryzen 7 5800X3D')).toBe('amd');
    expect(ctx.inferCpuVendor('Ryzen 9 7950X3D')).toBe('amd');
    expect(ctx.inferCpuVendor('Intel Core i9-13900K')).toBe('intel');
    expect(ctx.inferCpuVendor('Apple M2')).toBe('other');
    expect(ctx.inferCpuVendor('')).toBe('');
  });

  test('parseSteamSystemInfo reads an explicit CPU Vendor line', () => {
    const out = ctx.parseSteamSystemInfo('CPU Brand: Some Chip\nCPU Vendor: intel');
    expect(out.cpuVendor).toBe('intel');
  });

  test('parseSteamSystemInfo infers CPU vendor from the brand when no explicit line', () => {
    const out = ctx.parseSteamSystemInfo('CPU Brand: AMD Ryzen 5 5600X 6-Core Processor');
    expect(out.cpuVendor).toBe('amd');
  });

  test('submit handler reads sys-cpu-vendor and writes a CPU Vendor line', () => {
    expect(editSrc).toContain("document.getElementById('sys-cpu-vendor').value");
    expect(editSrc).toContain('if (cpuVendor) lines.push(`CPU Vendor: ${cpuVendor}`)');
  });
});

describe('Steam-info parse modal + cancel', () => {
  test('cancel button navigates back to profile', () => {
    expect(editSrc).toContain("getElementById('cancel-btn')");
    expect(editSrc).toContain("window.location.href = 'profile.html'");
  });

  test('parse modal runs parseSteamSystemInfo and fills via applyParsed', () => {
    expect(editSrc).toContain("getElementById('steam-parse-run')");
    expect(editSrc).toContain('const parsed = parseSteamSystemInfo(text)');
    expect(editSrc).toContain('applyParsed(parsed)');
  });
});
