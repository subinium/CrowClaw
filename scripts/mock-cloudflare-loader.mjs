/**
 * Node.js ESM loader hook that mocks @cloudflare/* modules.
 * Usage: node --loader ./scripts/mock-cloudflare-loader.mjs scripts/serve-local.mjs
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('@cloudflare/sandbox') || specifier.includes('@cloudflare/containers')) {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(
        'export class Sandbox {} export class Container {} export const proxyToSandbox = async () => null; export const getSandbox = () => ({ exec: () => {} }); export default {};'
      ),
    };
  }
  return nextResolve(specifier, context);
}
