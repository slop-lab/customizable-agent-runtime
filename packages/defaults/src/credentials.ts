import { ProviderInvocationError } from "@car/core";

export interface CredentialResolver {
  resolve(handle: string): string;
}

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}
  resolve(handle: string): string {
    const prefix = "env:";
    if (!handle.startsWith(prefix)) throw new ProviderInvocationError("credential.handle", `Unsupported credential handle: ${handle}`, false);
    const name = handle.slice(prefix.length);
    const value = this.environment[name];
    if (!value) throw new ProviderInvocationError("credential.missing", `Credential environment variable is not set: ${name}`, false);
    return value;
  }
}
