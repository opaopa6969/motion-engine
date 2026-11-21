const HTTP_AUTH_ADR = 'https://github.com/opaopa6969/shitate-engine/blob/main/docs/adr/0001-mcp-http-authorization.md';

export function listenOnLoopback(server, port, onListening, host = '127.0.0.1') {
  const bindAddress = host === 'localhost' ? '127.0.0.1' : host;
  if (bindAddress !== '127.0.0.1' && bindAddress !== '::1') {
    throw new Error(`Invalid MCP_HOST ${JSON.stringify(host)}. Only 127.0.0.1, ::1, and localhost are allowed because backend Bearer verification is not implemented. See ADR 0001: ${HTTP_AUTH_ADR}`);
  }

  server.listen(port, bindAddress, () => {
    const { address, family, port: boundPort } = server.address();
    const urlHost = family === 'IPv6' ? `[${address}]` : address;
    onListening(`http://${urlHost}:${boundPort}/mcp`);
  });
}
