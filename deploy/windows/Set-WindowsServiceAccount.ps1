#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string[]]$ServiceNames = @('FeishuAgentGateway', 'FeishuAgentWorker'),
    [PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'

function Grant-ServiceLogonRight {
    param([Parameter(Mandatory)][string]$AccountName)
    if (-not ('FeishuAgent.ServiceLogonRight' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace FeishuAgent {
  public static class ServiceLogonRight {
    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES {
      public int Length;
      public IntPtr RootDirectory;
      public IntPtr ObjectName;
      public uint Attributes;
      public IntPtr SecurityDescriptor;
      public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LSA_UNICODE_STRING {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attributes, uint accessMask, out IntPtr policyHandle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaAddAccountRights(IntPtr policyHandle, byte[] accountSid, LSA_UNICODE_STRING[] userRights, uint countOfRights);
    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policyHandle);
    [DllImport("advapi32.dll")]
    private static extern int LsaNtStatusToWinError(uint status);

    public static void Grant(string accountName) {
      var sid = (SecurityIdentifier)new NTAccount(accountName).Translate(typeof(SecurityIdentifier));
      var sidBytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(sidBytes, 0);
      var attributes = new LSA_OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES)) };
      IntPtr policy;
      uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x00000810, out policy);
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status), "Unable to open the local security policy.");
      IntPtr buffer = Marshal.StringToHGlobalUni("SeServiceLogonRight");
      try {
        var right = new LSA_UNICODE_STRING {
          Buffer = buffer,
          Length = checked((ushort)("SeServiceLogonRight".Length * 2)),
          MaximumLength = checked((ushort)(("SeServiceLogonRight".Length + 1) * 2))
        };
        status = LsaAddAccountRights(policy, sidBytes, new[] { right }, 1);
        if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status), "Unable to grant Log on as a service.");
      } finally {
        Marshal.FreeHGlobal(buffer);
        LsaClose(policy);
      }
    }
  }
}
'@
    }
    [FeishuAgent.ServiceLogonRight]::Grant($AccountName)
}

if (-not $Credential) {
    $Credential = Get-Credential -Message 'Enter the dedicated Windows service account. The password is sent directly to SCM and is not written to disk.'
}

$password = $Credential.GetNetworkCredential().Password
try {
    Grant-ServiceLogonRight -AccountName $Credential.UserName
    foreach ($serviceName in $ServiceNames) {
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
        $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
            StartName = $Credential.UserName
            StartPassword = $password
        }
        if ($result.ReturnValue -ne 0) {
            throw "SCM rejected the account change for $serviceName with code $($result.ReturnValue)."
        }
        Restart-Service -Name $serviceName -Force
        (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }
}
finally {
    $password = $null
}

Get-CimInstance -ClassName Win32_Service | Where-Object Name -In $ServiceNames | Select-Object Name, StartName, State, StartMode
