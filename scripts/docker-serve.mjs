import { createServer } from 'node:http';
import { createNodeRuntime } from '@crowclaw/runtime-node';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '0.0.0.0';
const runtime = createNodeRuntime({ hostname: host });
let inFlight = 0;

const server = createServer(async (req, res) => {
  inFlight += 1;
  res.on('close', () => { inFlight -= 1; });

  try {
    const requestHost = req.headers.host ?? `${host}:${port}`;
    const url = new URL(req.url ?? '/', `http://${requestHost}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }

    headers.delete('x-crowclaw-remote-addr');
    if (req.socket?.remoteAddress) {
      headers.set('x-crowclaw-remote-addr', req.socket.remoteAddress);
    }

    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(Buffer.from(chunk));
    }
    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

    const response = await runtime.fetch(new Request(url.toString(), {
      method: req.method ?? 'GET',
      headers,
      body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    }));

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, host, () => {
  console.log(`CrowClaw Docker server running at http://${host}:${port}`);
});

await new Promise((resolve) => {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining ${inFlight} in-flight request(s)...`);

    if (typeof runtime.close === 'function') {
      try {
        await runtime.close();
      } catch (error) {
        console.error(`[shutdown] runtime.close() failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    server.close(() => {
      console.log('[shutdown] Server closed gracefully.');
      resolve();
    });

    const forceTimer = setTimeout(() => {
      console.error(`[shutdown] Force exit after 10s timeout (${inFlight} request(s) still in-flight).`);
      resolve();
    }, 10_000);
    forceTimer.unref();
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
});
