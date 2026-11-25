param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('save', 'load', 'load-optional', 'status', 'delete', 'self-test')]
    [string] $Action
)

$ErrorActionPreference = 'Stop'
$targetName = 'DBFriend/L05C/MiNA'

if (-not ('DBFriend.L05cCredentialVault' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DBFriend {
    public static class L05cCredentialVault {
        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME { public uint Low; public uint High; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
            public FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr credential);

        public static void Write(string target, byte[] secret, bool sessionOnly) {
            if (secret == null || secret.Length == 0 || secret.Length > 2560) {
                throw new InvalidOperationException("Credential size is invalid.");
            }
            IntPtr buffer = Marshal.AllocHGlobal(secret.Length);
            try {
                Marshal.Copy(secret, 0, buffer, secret.Length);
                CREDENTIAL credential = new CREDENTIAL();
                credential.Type = 1; // CRED_TYPE_GENERIC
                credential.TargetName = target;
                credential.CredentialBlobSize = (uint)secret.Length;
                credential.CredentialBlob = buffer;
                credential.Persist = sessionOnly ? 1u : 2u;
                if (!CredWrite(ref credential, 0)) {
                    throw new InvalidOperationException("CredWrite error " + Marshal.GetLastWin32Error());
                }
            } finally {
                for (int i = 0; i < secret.Length; i++) Marshal.WriteByte(buffer, i, 0);
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static byte[] Read(string target) {
            IntPtr pointer;
            if (!CredRead(target, 1, 0, out pointer)) {
                int code = Marshal.GetLastWin32Error();
                if (code == 1168) return null; // ERROR_NOT_FOUND
                throw new InvalidOperationException("CredRead error " + code);
            }
            try {
                CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
                if (credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 2560) {
                    throw new InvalidOperationException("Credential size is invalid.");
                }
                byte[] secret = new byte[credential.CredentialBlobSize];
                Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
                return secret;
            } finally {
                CredFree(pointer);
            }
        }

        public static bool Delete(string target) {
            if (CredDelete(target, 1, 0)) return true;
            int code = Marshal.GetLastWin32Error();
            if (code == 1168) return false;
            throw new InvalidOperationException("CredDelete error " + code);
        }
    }
}
'@
}

function Test-L05cFields($value) {
    return (
        $null -ne $value -and
        $value.userId -is [string] -and $value.userId -match '^\d+$' -and
        $value.passToken -is [string] -and $value.passToken.Length -gt 0 -and
        $value.deviceId -is [string] -and $value.deviceId.Length -gt 0 -and
        $value.passToken -notmatch '[;\r\n]' -and
        $value.deviceId -notmatch '[;\r\n]'
    )
}

function Read-L05cEntry([string] $name) {
    $bytes = [DBFriend.L05cCredentialVault]::Read($name)
    if ($null -eq $bytes) { return $null }
    try {
        $value = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        if (-not (Test-L05cFields $value)) { throw 'Invalid credential entry.' }
        return $value
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

switch ($Action) {
    'save' {
        $secureDevice = $null
        $devicePointer = [IntPtr]::Zero
        $bytes = $null
        try {
            $userId = Read-Host 'Xiaomi numeric userId'
            $null = Read-Host 'Copy ONLY passToken Value, then press Enter'
            $passToken = Get-Clipboard -Raw
            $secureDevice = Read-Host 'Browser cookie deviceId' -AsSecureString
            $devicePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureDevice)
            $deviceId = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($devicePointer)
            $value = [PSCustomObject]@{
                userId = [string]$userId
                passToken = [string]$passToken
                deviceId = [string]$deviceId
            }
            if (-not (Test-L05cFields $value)) { throw 'Invalid credential input.' }
            $json = $value | ConvertTo-Json -Compress
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            if ($bytes.Length -gt 2560) { throw 'Credential is too long for Windows Credential Manager.' }
            [DBFriend.L05cCredentialVault]::Write($targetName, $bytes, $false)
            Write-Host 'Saved to Windows Credential Manager for the current Windows user.'
        }
        finally {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            if ($devicePointer -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($devicePointer)
            }
            if ($null -ne $secureDevice) { $secureDevice.Dispose() }
            $value = $null; $json = $null; $passToken = $null; $deviceId = $null
        }
    }
    'load' {
        $value = Read-L05cEntry $targetName
        if ($null -eq $value) { throw 'L05C credential not found; run save first.' }
        $env:L05C_TEST_USER = $value.userId
        $env:L05C_TEST_TOKEN = $value.passToken
        $env:L05C_TEST_DEVICE = $value.deviceId
        $value = $null
        Write-Host 'Loaded L05C credential into this process.'
    }
    'load-optional' {
        $env:L05C_TEST_USER = $null
        $env:L05C_TEST_TOKEN = $null
        $env:L05C_TEST_DEVICE = $null
        $value = Read-L05cEntry $targetName
        if ($null -ne $value) {
            $env:L05C_TEST_USER = $value.userId
            $env:L05C_TEST_TOKEN = $value.passToken
            $env:L05C_TEST_DEVICE = $value.deviceId
        }
        $value = $null
    }
    'status' {
        $value = Read-L05cEntry $targetName
        if ($null -eq $value) { Write-Host 'L05C credential: not found.' }
        else { Write-Host 'L05C credential: available.' }
        $value = $null
    }
    'delete' {
        if ([DBFriend.L05cCredentialVault]::Delete($targetName)) {
            Write-Host 'L05C credential deleted.'
        } else {
            Write-Host 'L05C credential was not found.'
        }
    }
    'self-test' {
        $testName = 'DBFriend/L05C/TEST-' + [guid]::NewGuid().ToString('N')
        $testValue = [PSCustomObject]@{
            userId = '12345678'
            passToken = 'V1:' + ('x' * 1800)
            deviceId = 'test-device'
        }
        $testBytes = [System.Text.Encoding]::UTF8.GetBytes(($testValue | ConvertTo-Json -Compress))
        $testRead = $null
        $created = $false
        try {
            [DBFriend.L05cCredentialVault]::Write($testName, $testBytes, $true)
            $created = $true
            $testRead = Read-L05cEntry $testName
            if ($testRead.userId -cne $testValue.userId -or
                $testRead.passToken -cne $testValue.passToken -or
                $testRead.deviceId -cne $testValue.deviceId) {
                throw 'Credential round trip failed.'
            }
            Write-Host 'Credential Manager synthetic round trip: OK.'
        }
        finally {
            [Array]::Clear($testBytes, 0, $testBytes.Length)
            if ($created) {
                if (-not [DBFriend.L05cCredentialVault]::Delete($testName)) {
                    throw 'Synthetic credential cleanup failed.'
                }
                if ($null -ne [DBFriend.L05cCredentialVault]::Read($testName)) {
                    throw 'Synthetic credential cleanup could not be verified.'
                }
            }
            $testRead = $null; $testValue = $null
        }
    }
}
