import { createServer } from 'node:http';

const PORT = 3000;

const server = createServer((req, res) => {
  const body = JSON.stringify({
    time: new Date().toISOString(),
    message: 'Hello World',
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });

  res.end(body);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
