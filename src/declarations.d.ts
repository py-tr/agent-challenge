/**
 * src/declarations.d.ts
 * Ambient module declarations for optional / not-yet-installed packages.
 *
 * @modelcontextprotocol/sdk is loaded via dynamic import inside a try/catch
 * fallback block in gmailClient.ts and calendarClient.ts. TypeScript still
 * resolves the module path at compile time, so we declare it here as "any"
 * to let tsc pass without the package being installed.
 *
 * When the package is installed (pnpm add @modelcontextprotocol/sdk),
 * these declarations are superseded by the package's own .d.ts files.
 */

declare module "@modelcontextprotocol/sdk/client/index.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Client: any;
  export { Client };
}

declare module "@modelcontextprotocol/sdk/client/streamableHttp.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StreamableHTTPClientTransport: any;
  export { StreamableHTTPClientTransport };
}
