/**
 * Readable names for Sophos Fusion sensor types, for dim_sensor_type.
 * Copied from the SecOps Toolkit (backend/src/mappers/views.ts, MIT, same
 * author) so both tools label sources the same way.
 */

export const SENSOR_LABELS: Record<string, string> = {
  SOPHOS_SFOS: "Sophos Firewall",
  SFOS: "Sophos Firewall",
  SOPHOS_EMAIL: "Sophos Email",
  SOPHOS_NDR: "Sophos NDR",
  SOPHOS_ZTNA: "Sophos ZTNA",
  ENDPOINT_AGENT: "Endpoint",
  ENDPOINT: "Endpoint",
  ENDPOINT_TAEGIS: "Endpoint",
  ENDPOINT_SOPHOS: "Endpoint",
  ENDPOINT_REDCLOAK: "Endpoint",
  REDCLOAK: "Endpoint",
  SERVER: "Server",
  FIREWALL: "Firewall",
  NETWORK: "Network",
  CLOUD: "Cloud",
  EMAIL: "Email",
  IDENTITY: "Identity",
  MICROSOFT: "Microsoft 365",
  O365: "Microsoft 365",
  AZURE: "Azure",
  AWS: "AWS",
  GCP: "Google Cloud",
  NDR: "NDR",
  ISENSOR: "Taegis NDR",
  ITDR: "ITDR",
  MDR: "MDR",
  INTEGRATION: "Integrations",
  // Integrations whose sensor_type the fallback would mangle, named as their integration guides name them.
  ABNORMALSECURITY: "Abnormal Security",
  "AKAMAI_APP_&_API_PROTECTOR": "Akamai App & API Protector",
  AKAMAI_EAA: "Akamai EAA",
  CISCO_ISE: "Cisco ISE",
  CLAROTY_XDOME: "Claroty xDome",
  CLOUDFLARE: "Cloudflare",
  CYBERARK: "CyberArk",
  MCAFEE_EPO: "McAfee ePO",
  SCADAFENCE: "SCADAfence",
  VMWARE_VCENTER: "VMware vCenter",
  // Microsoft sensor types from the Taegis Sensor Types page, each its own source.
  MICROSOFT_WINDOWS_SNARE: "Windows Events (Snare)",
  MICROSOFT_WINDOWS_SPLUNK: "Windows Events (Splunk)",
  MICROSOFT_IIS: "Microsoft IIS",
  MSDHCP: "Microsoft DHCP",
  MSDNS: "Microsoft DNS",
  MICROSOFT_AZURE_ACTIVITY: "Azure Activity Log",
  MICROSOFT_GRAPH_ALERTS: "Microsoft Graph Security",
  MICROSOFT_GRAPH_SIGN_IN: "Entra ID Sign-ins",
  MICROSOFT_GRAPH_DIRECTORY_AUDIT: "Entra ID Audit Logs",
  MICROSOFT_OFFICE_MANAGEMENT: "Microsoft 365",
  AZURE_RISK_DETECTION: "Entra ID Risk Detection",
  // Third-party EDR: the ENDPOINT prefix would name each of them as the Sophos endpoint row.
  ENDPOINT_MICROSOFT_ATP: "Microsoft Defender for Endpoint",
  ENDPOINT_CROWD_STRIKE: "CrowdStrike Falcon",
  ENDPOINT_SENTINELONE: "SentinelOne",
  ENDPOINT_CARBON_BLACK_PSC: "Carbon Black Cloud",
  ENDPOINT_HARFANG_LAB: "HarfangLab",
  // Other types on the Taegis Sensor Types page that the fallback or the AWS prefix would mangle.
  FORTIGATE_FW: "Fortinet FortiGate",
  PALOALTO_FIREWALL: "Palo Alto Networks Firewall",
  BARRACUDA_FW: "Barracuda Firewall",
  BARRACUDA_WAF: "Barracuda WAF",
  CISCO_FIREWALL_ASA: "Cisco Secure Firewall ASA",
  CISCO_FIREWALL_FTD: "Cisco Secure Firewall Threat Defense",
  JUNIPER_SRX_FIREWALL: "Juniper SRX Firewall",
  PFSENSE_FIREWALL: "pfSense Firewall",
  SONICWALL: "SonicWall",
  WATCHGUARD_FIREWALL: "WatchGuard Firewall",
  ZSCALER_FIREWALL_DNS: "Zscaler Firewall DNS",
  ZSCALER_NSS: "Zscaler NSS",
  ARUBA_CLEARPASS: "Aruba ClearPass",
  BLUECOAT_PROXYSG: "Blue Coat ProxySG",
  CISCO_IOS: "Cisco IOS",
  CISCO_IRONPORT: "Cisco IronPort",
  FORTINET_FORTIWEB: "Fortinet FortiWeb",
  IMPERVA_SECURESPHERE: "Imperva SecureSphere",
  MCAFEE_WEBGATEWAY: "McAfee Web Gateway",
  NAMED: "BIND DNS (named)",
  NETSCALER: "NetScaler",
  PULSESECURE_SA: "Pulse Secure",
  SILENTDEFENSE: "SilentDefense",
  SSHD: "sshd",
  SUDO: "sudo",
  SURICATAEVE: "Suricata EVE",
  VMWARE_ESXI: "VMware ESXi",
  AMAZON_GUARDDUTY: "Amazon GuardDuty",
  AWS_APPLICATION_LOAD_BALANCER: "AWS Application Load Balancer",
  AWS_CLOUDTRAIL: "AWS CloudTrail",
  AWS_VPC_FLOW: "AWS VPC Flow Logs",
  AWS_WAF: "AWS WAF",
  CISCO_ESTREAMER: "Cisco eStreamer",
  ORACLE_OCI: "Oracle Cloud Infrastructure",
  ORACLE_OCI_AUDIT: "Oracle Cloud Audit",
  ORACLE_OCI_LOADBALANCER: "Oracle Cloud Load Balancer",
  ORACLE_OCI_VCNFLOW: "Oracle Cloud VCN Flow Logs",
};

/** Vendor names that are not a family prefix: MICROSOFT_WINDOWS_SNARE is not Microsoft 365, Azure Firewall is not just Azure. */
const WHOLE_NAME_ONLY = new Set(["MICROSOFT", "AZURE"]);

/**
 * A readable name for a Fusion sensor type such as ENDPOINT_TAEGIS or cloud
 * audit, for the Overview and the Search screens alike. A prefix only counts
 * at a word boundary, so CLOUDFLARE_HTTP is not "Cloud".
 */
export function sensorLabel(raw: string): string {
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  if (SENSOR_LABELS[key]) return SENSOR_LABELS[key]!;
  for (const [prefix, label] of Object.entries(SENSOR_LABELS)) if (!WHOLE_NAME_ONLY.has(prefix) && key.startsWith(`${prefix}_`)) return label;
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
