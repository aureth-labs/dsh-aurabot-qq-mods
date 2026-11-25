import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Existing vault script loads credentials only into the child process.
// Its stdout is a private pipe; never surface it or stderr in errors/logs.
export function loadWindowsCredentials(networkInterface = '', { allowMissing = false } = {}) {
  const script = [
    '$ErrorActionPreference="Stop"',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    allowMissing ? '& $env:FAMILY_VAULT_SCRIPT -Action load-optional *> $null' : '& $env:FAMILY_VAULT_SCRIPT -Action load *> $null',
    '$addresses=@([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.Name -eq $env:FAMILY_NETWORK_INTERFACE -and $_.OperationalStatus -eq "Up" } | ForEach-Object { $_.GetIPProperties().UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | ForEach-Object { $_.Address.ToString() } })',
    'if ($addresses.Count -ne 1) { throw "Network unavailable" }',
    '[Console]::Write((@{userId=$env:L05C_TEST_USER;passToken=$env:L05C_TEST_TOKEN;deviceId=$env:L05C_TEST_DEVICE;localAddress=$addresses[0]} | ConvertTo-Json -Compress))',
  ].join(';');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: {
        ...process.env,
        FAMILY_VAULT_SCRIPT: fileURLToPath(new URL('../windows/l05c-vault.ps1', import.meta.url)),
        FAMILY_NETWORK_INTERFACE: String(networkInterface),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('无法读取现有音箱凭据。')); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error('现有凭据或音箱网卡不可用。'));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); }
      catch { reject(new Error('凭据工具没有返回有效结果。')); }
      output = '';
    });
  });
}

export function saveWindowsCredentials(credentials) {
  const { userId, passToken, deviceId } = credentials;
  if (!/^\d+$/.test(userId) || !passToken || !deviceId ||
      [passToken, deviceId].some((value) => /[;\r\n]/.test(value))) {
    return Promise.reject(new Error('新的登录凭据格式不可用。'));
  }
  const script = [
    '$ErrorActionPreference="Stop"',
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '& $env:FAMILY_VAULT_SCRIPT -Action status *> $null',
    '$value=[Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$bytes=[Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))',
    'try { [DBFriend.L05cCredentialVault]::Write("DBFriend/L05C/MiNA",$bytes,$false) } finally { [Array]::Clear($bytes,0,$bytes.Length); $value=$null }',
  ].join(';');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, FAMILY_VAULT_SCRIPT: fileURLToPath(new URL('../windows/l05c-vault.ps1', import.meta.url)) },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timeout); reject(new Error('无法保存音箱登录凭据。')); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('无法保存音箱登录凭据。'));
    });
    child.stdin.end(JSON.stringify({ userId, passToken, deviceId }));
  });
}
