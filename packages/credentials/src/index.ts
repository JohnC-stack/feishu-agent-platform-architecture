import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CredentialReferenceSchema, type CredentialReference } from '@feishu-agent/contracts';

const execFileAsync = promisify(execFile);

export class ProtectedCredential {
  public constructor(private readonly value: string) {
    if (!value) {
      throw new Error('Resolved credential must not be empty.');
    }
  }

  public reveal(): string {
    return this.value;
  }

  public toString(): string {
    return '[PROTECTED_CREDENTIAL]';
  }

  public toJSON(): string {
    return '[PROTECTED_CREDENTIAL]';
  }
}

export interface CredentialProvider {
  readonly provider: CredentialReference['provider'];
  resolve(target: string): Promise<ProtectedCredential>;
}

export class CredentialReferenceResolver {
  private readonly providers: Map<CredentialReference['provider'], CredentialProvider>;

  public constructor(providers: CredentialProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.provider, provider]));
  }

  public async resolve(referenceInput: CredentialReference): Promise<ProtectedCredential> {
    const reference = CredentialReferenceSchema.parse(referenceInput);
    const provider = this.providers.get(reference.provider);
    if (!provider) {
      throw new Error(`Credential provider is not configured: ${reference.provider}`);
    }
    return provider.resolve(reference.target);
  }
}

export interface WindowsCredentialCommandRunner {
  (target: string): Promise<string>;
}

export class WindowsCredentialManagerProvider implements CredentialProvider {
  public readonly provider = 'windows_credential_manager' as const;

  public constructor(
    private readonly allowedTargetPrefixes: string[] = ['FeishuAgent/'],
    private readonly runner: WindowsCredentialCommandRunner = readWindowsCredential,
  ) {
    if (allowedTargetPrefixes.length === 0 || allowedTargetPrefixes.some((prefix) => !prefix)) {
      throw new Error('At least one non-empty credential target prefix is required.');
    }
  }

  public async resolve(target: string): Promise<ProtectedCredential> {
    if (!this.allowedTargetPrefixes.some((prefix) => target.startsWith(prefix))) {
      throw new Error('Credential target is outside the configured allowlist.');
    }
    return new ProtectedCredential((await this.runner(target)).trimEnd());
  }
}

export class EnterpriseSecretManagerProvider implements CredentialProvider {
  public readonly provider = 'enterprise_secret_manager' as const;

  public constructor(private readonly resolver: (target: string) => Promise<string>) {}

  public async resolve(target: string): Promise<ProtectedCredential> {
    return new ProtectedCredential(await this.resolver(target));
  }
}

export interface EnvironmentCredentialResolver {
  resolve(reference: {
    name: string;
    provider: 'windows_credential_manager';
    target: string;
  }): Promise<ProtectedCredential>;
}

export async function resolveEnvironmentCredentialReferences(input: {
  names: string[];
  environment?: NodeJS.ProcessEnv;
  allowedTargetPrefixes?: string[];
  resolver?: EnvironmentCredentialResolver;
}): Promise<{ resolvedNames: string[] }> {
  const environment = input.environment ?? process.env;
  const resolver =
    input.resolver ??
    new CredentialReferenceResolver([
      new WindowsCredentialManagerProvider(input.allowedTargetPrefixes ?? ['FeishuAgent/']),
    ]);
  const resolvedNames: string[] = [];
  for (const name of input.names) {
    const value = environment[name]?.trim();
    if (!value?.startsWith('wincred://')) continue;
    const target = decodeURIComponent(value.slice('wincred://'.length));
    if (!target) throw new Error(`${name} has an empty Windows Credential Manager target.`);
    const credential = await resolver.resolve({
      name: name.toLowerCase(),
      provider: 'windows_credential_manager',
      target,
    });
    environment[name] = credential.reveal();
    resolvedNames.push(name);
  }
  return { resolvedNames };
}

export async function storeWindowsCredential(input: {
  target: string;
  secret: string;
  username?: string;
}): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Credential Manager is only available on Windows.');
  }
  if (!input.target || !input.secret) {
    throw new Error('Credential target and secret are required.');
  }
  const shell = process.env.POWERSHELL_EXE?.trim() || 'powershell.exe';
  await execFileAsync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(storeScript)],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1_048_576,
      env: {
        ...process.env,
        FEISHU_AGENT_CREDENTIAL_TARGET: input.target,
        FEISHU_AGENT_CREDENTIAL_SECRET: input.secret,
        FEISHU_AGENT_CREDENTIAL_USERNAME: input.username ?? 'FeishuAgent',
      },
      encoding: 'utf8',
    },
  );
}

async function readWindowsCredential(target: string): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Credential Manager is only available on Windows.');
  }
  const shell = process.env.POWERSHELL_EXE?.trim() || 'powershell.exe';
  const { stdout } = await execFileAsync(
    shell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(credentialScript),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, FEISHU_AGENT_CREDENTIAL_TARGET: target },
      encoding: 'utf8',
    },
  );
  const value = stdout.replace(/^\uFEFF/u, '').trimEnd();
  if (!value) {
    throw new Error('Windows Credential Manager returned an empty credential.');
  }
  return value;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('FEISHU_AGENT_CREDENTIAL_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Credential target is required.' }

if (-not ('FeishuAgent.WinCred' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FeishuAgent {
  public static class WinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public UInt32 Flags;
      public UInt32 Type;
      public IntPtr TargetName;
      public IntPtr Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public UInt32 CredentialBlobSize;
      public IntPtr CredentialBlob;
      public UInt32 Persist;
      public UInt32 AttributeCount;
      public IntPtr Attributes;
      public IntPtr TargetAlias;
      public IntPtr UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    private static extern void CredFree(IntPtr credential);

    public static string Read(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential target was not found or cannot be read.");
      }
      try {
        Credential credential = Marshal.PtrToStructure<Credential>(pointer);
        if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) {
          return string.Empty;
        }
        return Marshal.PtrToStringUni(credential.CredentialBlob, checked((int)credential.CredentialBlobSize / 2));
      } finally {
        CredFree(pointer);
      }
    }
  }
}
'@
}

[Console]::Out.Write([FeishuAgent.WinCred]::Read($target))
`;

const storeScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('FEISHU_AGENT_CREDENTIAL_TARGET', 'Process')
$secret = [Environment]::GetEnvironmentVariable('FEISHU_AGENT_CREDENTIAL_SECRET', 'Process')
$username = [Environment]::GetEnvironmentVariable('FEISHU_AGENT_CREDENTIAL_USERNAME', 'Process')
if ([string]::IsNullOrWhiteSpace($target) -or [string]::IsNullOrEmpty($secret)) {
  throw 'Credential target and secret are required.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace FeishuAgent {
  public static class WinCredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public UInt32 Flags;
      public UInt32 Type;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
      public IntPtr Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public UInt32 CredentialBlobSize;
      public IntPtr CredentialBlob;
      public UInt32 Persist;
      public UInt32 AttributeCount;
      public IntPtr Attributes;
      public IntPtr TargetAlias;
      [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, UInt32 flags);

    public static void Write(string target, string username, string secret) {
      IntPtr blob = Marshal.StringToCoTaskMemUni(secret);
      try {
        Credential credential = new Credential {
          Type = 1,
          TargetName = target,
          CredentialBlobSize = checked((UInt32)Encoding.Unicode.GetByteCount(secret)),
          CredentialBlob = blob,
          Persist = 2,
          UserName = username
        };
        if (!CredWrite(ref credential, 0)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential could not be stored.");
        }
      } finally {
        Marshal.ZeroFreeCoTaskMemUnicode(blob);
      }
    }
  }
}
'@

[FeishuAgent.WinCredWriter]::Write($target, $username, $secret)
`;
