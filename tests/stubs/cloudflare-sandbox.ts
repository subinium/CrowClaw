export class Sandbox {}

export async function proxyToSandbox(): Promise<Response | null> {
  return null;
}

export function getSandbox() {
  return {
    exec: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 })
  };
}
