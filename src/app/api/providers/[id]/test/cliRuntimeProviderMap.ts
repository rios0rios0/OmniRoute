// Maps only providers whose connection-test authentication depends on a local CLI
// runtime. Providers with hosted OAuth/API integrations do not belong here.
// kilocode is intentionally absent: the provider uses OAuth device flow + direct
// HTTPS to api.kilo.ai and never depends on the kilocode CLI binary at runtime
// (#2404). CLI-tools integration for Kilo (configuring the VSCode extension to
// point at OmniRoute) lives in /api/cli-tools/kilo-settings and keeps its own
// runtime check there.
export const CLI_RUNTIME_PROVIDER_MAP: Record<string, string> = {
  qoder: "qoder",
};
